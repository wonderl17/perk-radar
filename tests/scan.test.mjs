import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScanConfig, runDueScan, startScanScheduler } from '../scripts/scan.mjs';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const CONFIG = { scanIntervalMinutes: 5, maxItemsPerScan: 2, retryIntervalMinutes: 1 };
const REPORT = { model: 'gpt-test', examined: 2, published: 1, updated: 0, flagged: 0, held: 1, rejected: 0, failed: 0 };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, config = CONFIG) {
  const root = await mkdtemp(join(tmpdir(), 'perk-radar-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data')); await mkdir(join(root, 'work'));
  await writeFile(join(root, 'data/runtime.json'), JSON.stringify(config));
  return { root, put: (path, value) => writeFile(join(root, path), JSON.stringify(value)), read: async path => JSON.parse(await readFile(join(root, path), 'utf8')), text: path => readFile(join(root, path), 'utf8') };
}
function timers() {
  const pending = new Map(); let nextId = 0;
  return {
    pending,
    setTimeoutImpl(fn, ms) { const id = ++nextId; pending.set(id, { fn, ms }); return id; },
    clearTimeoutImpl(id) { pending.delete(id); },
    take() { assert.equal(pending.size, 1, 'only the next check may be scheduled'); const [id, timer] = [...pending.entries()][0]; pending.delete(id); return timer; },
  };
}

test('scan config loads project cadence and validates bounded explicit overrides', async t => {
  const fs = await fixture(t);
  assert.deepEqual(await loadScanConfig({ root: fs.root, env: {} }), CONFIG);
  assert.deepEqual(await loadScanConfig({ root: fs.root, env: { PERK_SCAN_INTERVAL_MINUTES: '360', PERK_SCAN_LIMIT: '6', PERK_SCAN_RETRY_MINUTES: '15', OPENAI_API_KEY: 'ignored-secret' } }), { scanIntervalMinutes: 360, maxItemsPerScan: 6, retryIntervalMinutes: 15 });
  for (const env of [{ PERK_SCAN_INTERVAL_MINUTES: '4' }, { PERK_SCAN_INTERVAL_MINUTES: '10081' }, { PERK_SCAN_LIMIT: '0' }, { PERK_SCAN_LIMIT: '31' }, { PERK_SCAN_LIMIT: '3.5' }, { PERK_SCAN_RETRY_MINUTES: '6' }, { PERK_SCAN_RETRY_MINUTES: '-1' }]) await assert.rejects(loadScanConfig({ root: fs.root, env }));
});

test('next scan starts from completion and survives restart without another paid ingestion', async t => {
  const fs = await fixture(t); let now = NOW, calls = 0;
  const ingestImpl = async options => { assert.deepEqual(options, { root: fs.root, limit: 2 }); calls++; now += 120000; return { ...REPORT, provider: 'must-not-persist', apiKey: 'must-not-persist', arbitrary: 'must-not-persist' }; };
  const first = await runDueScan({ root: fs.root, config: CONFIG, ingestImpl, nowFn: () => now });
  assert.equal(first.ran, true); assert.equal(first.state.status, 'idle');
  assert.equal(first.state.lastAttemptAt, new Date(NOW).toISOString());
  assert.equal(first.state.lastSuccessAt, new Date(NOW + 120000).toISOString());
  assert.equal(first.state.nextScanAt, new Date(NOW + 420000).toISOString());
  assert(!String(await fs.text('work/scan-state.json')).includes('must-not-persist'));
  const restart = await runDueScan({ root: fs.root, config: CONFIG, ingestImpl, nowFn: () => new Date(now).toISOString() });
  assert.equal(restart.ran, false); assert.equal(calls, 1);
  now = Date.parse(first.state.nextScanAt);
  assert.equal((await runDueScan({ root: fs.root, config: CONFIG, ingestImpl, nowFn: () => now })).ran, true);
  assert.equal(calls, 2);
});

test('a failed or partially failed scan keeps last success and retries without exposing error details', async t => {
  const fs = await fixture(t); let now = NOW;
  const success = '2026-10-26T05:00:00.000Z';
  await fs.put('work/scan-state.json', { status: 'idle', lastSuccessAt: success, nextScanAt: new Date(NOW).toISOString() });
  const failed = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => now, ingestImpl: async () => { throw new Error('Bearer SECRET https://provider.private/internal'); } });
  assert.equal(failed.ran, true); assert.equal(failed.state.status, 'error'); assert.equal(failed.state.lastSuccessAt, success);
  assert.equal(failed.state.nextScanAt, new Date(NOW + 60000).toISOString());
  assert(!String(await fs.text('work/scan-state.json')).includes('SECRET'));
  assert(!String(await fs.text('work/scan-state.json')).includes('provider.private'));
  let calls = 0;
  const tooEarly = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => now + 59000, ingestImpl: async () => { calls++; return REPORT; } });
  assert.equal(tooEarly.ran, false); assert.equal(calls, 0);
  now += 60000;
  const partial = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => now, ingestImpl: async () => ({ ...REPORT, failed: 1, discovery: { failures: 1 } }) });
  assert.equal(partial.state.status, 'error'); assert.equal(partial.state.lastSuccessAt, success);
  assert.equal(partial.state.lastResult.published, 1, 'partial content changes remain visible to the publisher');
  assert.equal(partial.state.lastResult.sourceFailures, 1);
  const reread = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => now, ingestImpl: async () => { throw Error('not due'); } });
  assert.equal(reread.state.lastResult.sourceFailures, 1);
  now += 60000;
  const recovered = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => now, ingestImpl: async () => REPORT });
  assert.equal(recovered.state.status, 'idle'); assert.equal(recovered.state.lastError, null); assert.equal(recovered.state.lastSuccessAt, new Date(now).toISOString());
});

test('the service and a simultaneous scheduled task share a cross-process lock and never overlap', async t => {
  const fs = await fixture(t); const started = deferred(), finish = deferred(); let calls = 0;
  const ingestImpl = async () => { calls++; started.resolve(); return finish.promise; };
  const first = runDueScan({ root: fs.root, config: CONFIG, nowFn: () => NOW, ingestImpl });
  await started.promise;
  const before = await fs.text('work/scan-state.json');
  assert.equal(JSON.parse(before).status, 'running');
  const other = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => NOW, ingestImpl });
  assert.equal(other.ran, false); assert.equal(other.busy, true); assert.equal(other.retryAfterMs, 30000);
  assert.equal(calls, 1); assert.equal(await fs.text('work/scan-state.json'), before, 'a busy caller cannot mark another owner successful or idle');
  finish.resolve(REPORT); await first;
  await assert.rejects(access(join(fs.root, 'work/scan-run.lock')), { code: 'ENOENT' });
});

test('partial discovery preserves useful results and waits for its real deadline instead of rerunning core evidence', async t => {
  const fs = await fixture(t, { scanIntervalMinutes: 60, maxItemsPerScan: 6, retryIntervalMinutes: 15 });
  const config = await loadScanConfig({ root: fs.root, env: {} });
  const previousSuccess = new Date(NOW - 3600000).toISOString();
  await fs.put('work/scan-state.json', { status: 'idle', lastSuccessAt: previousSuccess });
  let now = NOW;
  const discovery = { status: 'partial', startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 60000).toISOString(), nextRunAt: new Date(NOW + 3600000).toISOString(), added: 2, held: 0, failed: 1, searchResults: 9 };
  const first = await runDueScan({ root: fs.root, config, nowFn: () => now, ingestImpl: async () => {
    now += 120000;
    return { ...REPORT, discovery: { failures: 0, autonomous: discovery } };
  } });
  assert.equal(first.state.status, 'degraded');
  assert.equal(first.state.lastResult.published, 1);
  assert.equal(first.state.lastResult.autonomousDiscovery.added, 2);
  assert.equal(first.state.nextScanAt, discovery.nextRunAt, 'align with the independent search budget deadline');
  assert.equal(first.state.lastSuccessAt, previousSuccess);
  let calls = 0;
  const early = await runDueScan({ root: fs.root, config, nowFn: () => NOW + 17 * 60000, ingestImpl: async () => { calls++; return REPORT; } });
  assert.equal(early.ran, false);
  assert.equal(early.state.status, 'degraded');
  assert.equal(calls, 0);
  const recovered = await runDueScan({ root: fs.root, config, nowFn: () => NOW + 3600000, ingestImpl: async () => ({ ...REPORT, discovery: { failures: 0, autonomous: { status: 'empty', failed: 0, added: 0, nextRunAt: new Date(NOW + 7200000).toISOString() } } }) });
  assert.equal(recovered.state.status, 'idle');
  assert.equal(recovered.state.lastResult.autonomousDiscovery.status, 'empty');
  assert.equal(recovered.state.lastSuccessAt, new Date(NOW + 3600000).toISOString());
});

test('a core retry that skips discovery cannot erase a failed search or announce its recovery', async t => {
  const fs = await fixture(t);
  const search = { status: 'failed', startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW + 1000).toISOString(), nextRunAt: new Date(NOW + 3600000).toISOString(), failed: 2, added: 0 };
  await fs.put('work/scan-state.json', { status: 'error', nextScanAt: new Date(NOW).toISOString(), lastResult: { ...REPORT, autonomousDiscovery: search } });
  const retry = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => NOW + 60000, ingestImpl: async () => ({ ...REPORT, discovery: { failures: 0, autonomous: { status: 'skipped', failed: 0, added: 0, nextRunAt: search.nextRunAt } } }) });
  assert.equal(retry.state.status, 'degraded');
  assert.equal(retry.state.lastResult.autonomousDiscovery.status, 'failed');
  assert.equal(retry.state.lastResult.autonomousDiscovery.failed, 2);
  assert.equal(retry.state.lastResult.autonomousDiscovery.startedAt, search.startedAt);
  const persisted = await fs.read('work/scan-state.json');
  assert.equal(persisted.status, 'degraded');
});

test('an abandoned running state and confirmed dead PID can be recovered without deleting a live lock', async t => {
  const fs = await fixture(t);
  await fs.put('work/scan-state.json', { status: 'running', startedAt: '2026-10-25T12:00:00.000Z' });
  await fs.put('work/scan-run.lock', { pid: 2147483647, token: 'dead-owner' });
  let calls = 0;
  const result = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => NOW, ingestImpl: async () => { calls++; return REPORT; } });
  assert.equal(result.ran, true); assert.equal(result.state.status, 'idle'); assert.equal(calls, 1);
  await fs.put('work/scan-state.json', { status: 'running' });
  await fs.put('work/scan-run.lock', { pid: process.pid, token: 'live-owner' });
  const busy = await runDueScan({ root: fs.root, config: CONFIG, nowFn: () => NOW, ingestImpl: async () => { calls++; return REPORT; } });
  assert.equal(busy.ran, false); assert.equal(busy.busy, true); assert.equal(calls, 1);
  assert.equal((await fs.read('work/scan-run.lock')).token, 'live-owner');
});

test('the project scheduler checks on start and loops after each completed scan', async t => {
  const fs = await fixture(t), clock = timers(); let now = NOW, calls = 0;
  const secondIdle = deferred();
  const scheduler = startScanScheduler({ root: fs.root, config: CONFIG, nowFn: () => now, ...clock,
    ingestImpl: async () => { calls++; return REPORT; },
    onState: state => { if (calls === 2 && state.status === 'idle') secondIdle.resolve(); },
  });
  await scheduler.firstRun;
  assert.equal(calls, 1); assert.equal(scheduler.getStatus().status, 'idle');
  const firstTimer = clock.take(); assert.equal(firstTimer.ms, 300000);
  now += firstTimer.ms; firstTimer.fn();
  await secondIdle.promise;
  // stop() waits through the completed tick's persistence/scheduling boundary.
  await scheduler.stop();
  assert.equal(calls, 2); assert.equal(clock.pending.size, 0);
  firstTimer.fn(); await new Promise(done => setImmediate(done));
  assert.equal(calls, 2, 'a queued callback cannot restart work after stop');
});

test('a rejected ingestion promise does not kill the loop, and the retry can succeed', async t => {
  const fs = await fixture(t), clock = timers(); let now = NOW, calls = 0;
  const recovered = deferred();
  const scheduler = startScanScheduler({ root: fs.root, config: CONFIG, nowFn: () => now, ...clock,
    ingestImpl: async () => { calls++; if (calls === 1) throw new Error('secret diagnostic'); return REPORT; },
    onState: state => { if (calls === 2 && state.status === 'idle') recovered.resolve(); },
  });
  assert.equal((await scheduler.firstRun).status, 'error');
  assert(!scheduler.getStatus().lastError.includes('secret'));
  const retry = clock.take(); assert.equal(retry.ms, 60000); now += retry.ms; retry.fn();
  await recovered.promise; await scheduler.stop();
  assert.equal(calls, 2); assert.equal(scheduler.getStatus().status, 'idle');
});

test('stop cancels future scans while waiting for the active GPT work to finish', async t => {
  const fs = await fixture(t), clock = timers(); const started = deferred(), finish = deferred(); let calls = 0, stopped = false;
  const scheduler = startScanScheduler({ root: fs.root, config: CONFIG, nowFn: () => NOW, ...clock,
    ingestImpl: async () => { calls++; started.resolve(); return finish.promise; },
  });
  await started.promise;
  assert.equal(scheduler.getStatus().status, 'running');
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(stopped, false); assert.equal(clock.pending.size, 0);
  finish.resolve(REPORT); await stopping;
  assert.equal(stopped, true); assert.equal(calls, 1); assert.equal(clock.pending.size, 0);
});

test('an unreadable saved state cannot silently trigger new model work', async t => {
  const fs = await fixture(t), clock = timers(); let calls = 0;
  await writeFile(join(fs.root, 'work/scan-state.json'), '{broken');
  await assert.rejects(runDueScan({ root: fs.root, config: CONFIG, nowFn: () => NOW, ingestImpl: async () => { calls++; return REPORT; } }), /state is unreadable/);
  const scheduler = startScanScheduler({ root: fs.root, config: CONFIG, nowFn: () => NOW, ...clock, ingestImpl: async () => { calls++; return REPORT; } });
  assert.equal((await scheduler.firstRun).status, 'error'); assert.equal(calls, 0);
  assert.equal(clock.take().ms, 60000); await scheduler.stop();
});
