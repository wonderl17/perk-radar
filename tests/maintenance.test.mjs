import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { loadMaintenanceConfig, runDueMaintenance, startMaintenanceScheduler } from '../scripts/maintenance.mjs';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const CONFIG = { enabled: true, intervalMinutes: 60, retryIntervalMinutes: 5, deploymentPollMinutes: 1 };
const COMMIT = '2'.repeat(40), COMMIT_URL = `https://github.com/wonderl17/perk-radar/commit/${COMMIT}`;
const iso = value => new Date(value).toISOString();
const scanState = (extra = {}) => ({ status: 'idle', lastAttemptAt: iso(NOW), lastSuccessAt: iso(NOW), nextScanAt: iso(NOW + 3600000), lastResult: { model: 'gpt-test', published: 1 }, ...extra });
const successfulScan = async () => ({ ran: true, state: scanState() });
const successfulSync = async () => ({ updated: false, commitUrl: null });
const successfulVerification = async () => ({ status: 'success', commit: COMMIT, deploymentUrl: 'https://vercel.com/wonderl/perk-radar/deployment', checks: { githubAccount: true, vercel: 'success', homepage: true, offers: true, rss: true } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'perk-radar-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data')); await mkdir(join(root, 'work'));
  return { root, put: (path, value) => writeFile(join(root, path), JSON.stringify(value)), read: async path => JSON.parse(await readFile(join(root, path), 'utf8')), text: path => readFile(join(root, path), 'utf8') };
}
function options(fs, extra = {}) { return { root: fs.root, config: CONFIG, nowFn: () => NOW, scanImpl: successfulScan, syncImpl: successfulSync, verifyImpl: successfulVerification, ...extra }; }
function timers() {
  const pending = new Map(); let nextId = 0;
  return {
    pending,
    setTimeoutImpl(fn, ms) { const id = ++nextId; pending.set(id, { fn, ms }); return id; },
    clearTimeoutImpl(id) { pending.delete(id); },
    take() { assert.equal(pending.size, 1); const [id, timer] = [...pending.entries()][0]; pending.delete(id); return timer; },
  };
}

test('configuration is opt-in for old projects and overrides remain bounded', async t => {
  const fs = await fixture(t);
  assert.deepEqual(await loadMaintenanceConfig({ root: fs.root, env: {} }), { ...CONFIG, enabled: false });
  await fs.put('data/maintenance.json', CONFIG);
  assert.deepEqual(await loadMaintenanceConfig({ root: fs.root, env: {} }), CONFIG);
  assert.deepEqual(await loadMaintenanceConfig({ root: fs.root, env: { PERK_MAINTENANCE_ENABLED: 'false', PERK_MAINTENANCE_INTERVAL_MINUTES: '90', OPENAI_API_KEY: 'private' } }), { ...CONFIG, enabled: false, intervalMinutes: 90 });
  for (const env of [{ PERK_MAINTENANCE_ENABLED: 'yes' }, { PERK_MAINTENANCE_INTERVAL_MINUTES: '4' }, { PERK_MAINTENANCE_INTERVAL_MINUTES: '10081' }, { PERK_MAINTENANCE_RETRY_MINUTES: '0' }, { PERK_MAINTENANCE_RETRY_MINUTES: '61' }, { PERK_MAINTENANCE_DEPLOYMENT_POLL_MINUTES: '1.5' }]) await assert.rejects(loadMaintenanceConfig({ root: fs.root, env }));
});

test('disabled maintenance invokes no external stage and creates no timer', async t => {
  const fs = await fixture(t); const clock = timers();
  const fail = async () => { assert.fail('disabled maintenance called a stage'); };
  const scheduler = startMaintenanceScheduler(options(fs, { config: { ...CONFIG, enabled: false }, scanImpl: fail, syncImpl: fail, verifyImpl: fail, ...clock }));
  assert.equal((await scheduler.firstRun).status, 'disabled'); assert.equal(clock.pending.size, 0);
  await assert.rejects(access(join(fs.root, 'work/maintenance-state.json')), { code: 'ENOENT' });
  await scheduler.stop();
});

test('the scanner retains its due check while an independently due publication still syncs and verifies', async t => {
  const fs = await fixture(t); const calls = [];
  const first = await runDueMaintenance(options(fs, {
    scanImpl: async value => { calls.push('scan'); assert.deepEqual(value, { root: fs.root }); return { ran: false, state: scanState() }; },
    syncImpl: async value => { calls.push('sync'); assert.deepEqual(value, { root: fs.root }); return { updated: false }; },
    verifyImpl: async value => { calls.push('verify'); assert.deepEqual(value, { root: fs.root }); return successfulVerification(); },
  }));
  assert.deepEqual(calls, ['scan', 'sync', 'verify']); assert.equal(first.state.stages.scan, 'skipped');
  assert.equal(first.state.status, 'success'); assert.equal(first.state.lastSync.updated, false);
  assert.equal(first.state.nextMaintenanceAt, iso(NOW + 3600000));
  assert.equal(first.state.lastVerification.deploymentUrl, 'https://vercel.com/wonderl/perk-radar/deployment');
  const restart = await runDueMaintenance(options(fs, { scanImpl: async () => assert.fail('restart paid early'), nowFn: () => NOW + 1000 }));
  assert.equal(restart.ran, false); assert.equal(restart.state.lastSuccessAt, iso(NOW));
});

test('scan failure or degradation never blocks syncing already reviewed data or verifying production', async t => {
  for (const failure of ['throw', 'error', 'degraded']) {
    const fs = await fixture(t); const calls = [];
    const result = await runDueMaintenance(options(fs, {
      scanImpl: async () => { calls.push('scan'); if (failure === 'throw') throw new Error('private scanner body'); return { ran: true, state: scanState({ status: failure }) }; },
      syncImpl: async () => { calls.push('sync'); return { updated: true, commitUrl: COMMIT_URL }; },
      verifyImpl: async () => { calls.push('verify'); return successfulVerification(); },
    }));
    assert.deepEqual(calls, ['scan', 'sync', 'verify']); assert.equal(result.state.status, failure === 'degraded' ? 'degraded' : 'error');
    assert.equal(result.state.lastSync.updated, true); assert.equal(result.state.lastVerification.status, 'success');
    assert.deepEqual(result.state.retryStages, ['scan']); assert.equal(result.state.nextMaintenanceAt, iso(NOW + (failure === 'degraded' ? 3600000 : 300000)));
  }
});

test('a failed scan retry stays under scanner backoff while still comparing reviewed JSON', async t => {
  const fs = await fixture(t); let scans = 0, syncs = 0, verifies = 0;
  const input = options(fs, {
    scanImpl: async () => ({ ran: ++scans === 1, state: scanState({ status: 'error' }) }),
    syncImpl: async () => { syncs++; return { updated: false }; }, verifyImpl: async () => { verifies++; return successfulVerification(); },
  });
  await runDueMaintenance(input);
  const retry = await runDueMaintenance({ ...input, nowFn: () => NOW + 300000 });
  assert.equal(scans, 2); assert.equal(syncs, 2); assert.equal(verifies, 2); assert.equal(retry.state.status, 'error');
  assert.equal(retry.state.nextMaintenanceAt, iso(NOW + 600000));
});

test('a partial sync is preserved, never repeated within a round, and production verification still runs', async t => {
  const fs = await fixture(t); let puts = 0, verifies = 0, scans = 0;
  const result = await runDueMaintenance(options(fs, {
    scanImpl: async () => { scans++; return successfulScan(); },
    syncImpl: async () => { puts++; throw Object.assign(new Error('private GitHub token response'), { statusCode: 409, completedFiles: [{ path: 'data/offers.json', updated: true, commitUrl: COMMIT_URL, secret: 'private' }, { path: '/private/secret', updated: true }] }); },
    verifyImpl: async () => { verifies++; return successfulVerification(); },
  }));
  assert.equal(puts, 1); assert.equal(verifies, 1); assert.equal(result.state.status, 'error');
  assert.deepEqual(result.state.lastSync.completedFiles, [{ path: 'data/offers.json', updated: true, commitUrl: COMMIT_URL }]);
  assert.equal(result.state.lastSync.updated, true); assert.equal(result.state.lastSync.commitUrl, COMMIT_URL);
  assert.deepEqual(result.state.retryStages, ['sync']);
  const retry = await runDueMaintenance(options(fs, { nowFn: () => NOW + 300000, scanImpl: async () => assert.fail('successful scan must not rerun'), syncImpl: async () => { puts++; return { updated: false }; }, verifyImpl: async () => { verifies++; return successfulVerification(); } }));
  assert.equal(scans, 1); assert.equal(puts, 2); assert.equal(verifies, 2); assert.equal(retry.state.status, 'success');
});

test('pending deployments poll only existing production and restart without scan or sync', async t => {
  const fs = await fixture(t); let scans = 0, syncs = 0, verifies = 0;
  const input = options(fs, { scanImpl: async () => { scans++; return successfulScan(); }, syncImpl: async () => { syncs++; return { updated: true, commitUrl: COMMIT_URL }; }, verifyImpl: async () => { verifies++; return { status: 'pending', commit: COMMIT, code: 'DEPLOYMENT_PENDING', checks: { vercel: 'pending' } }; } });
  const pending = await runDueMaintenance(input);
  assert.equal(pending.state.status, 'pending'); assert.equal(pending.state.nextMaintenanceAt, iso(NOW + 60000));
  assert.equal((await runDueMaintenance({ ...input, nowFn: () => NOW + 59000 })).ran, false);
  const again = await runDueMaintenance({ ...input, nowFn: () => NOW + 60000 });
  assert.equal(again.state.status, 'pending'); assert.equal(scans, 1); assert.equal(syncs, 1); assert.equal(verifies, 2);
  const success = await runDueMaintenance({ ...input, nowFn: () => NOW + 120000, verifyImpl: successfulVerification });
  assert.equal(success.state.status, 'success'); assert.equal(scans, 1); assert.equal(syncs, 1);
});

test('pending publication with old degraded scanning only polls until the real scan deadline', async t => {
  const fs = await fixture(t); let scans = 0, syncs = 0;
  const input = options(fs, {
    scanImpl: async () => { scans++; return { ran: true, state: scanState({ status: 'degraded' }) }; },
    syncImpl: async () => { syncs++; return { updated: false }; },
    verifyImpl: async () => ({ status: 'pending', commit: COMMIT, code: 'DEPLOYMENT_PENDING' }),
  });
  await runDueMaintenance(input);
  const pending = await runDueMaintenance({ ...input, nowFn: () => NOW + 60000, scanImpl: async () => assert.fail('old degradation is not a due scan'), syncImpl: async () => assert.fail('pending deployment must not resync') });
  assert.equal(pending.state.status, 'pending'); assert.equal(scans, 1); assert.equal(syncs, 1);
  await runDueMaintenance({ ...input, nowFn: () => NOW + 3600000, verifyImpl: successfulVerification });
  assert.equal(scans, 2); assert.equal(syncs, 2, 'publication cannot starve a newly due scan and its sync');
});

test('a concurrent local change detected during verification resyncs before verifying again', async t => {
  const fs = await fixture(t); let syncs = 0;
  await runDueMaintenance(options(fs, { syncImpl: async () => { syncs++; return { updated: false }; }, verifyImpl: async () => ({ status: 'pending', commit: COMMIT, code: 'LOCAL_CHANGED' }) }));
  const result = await runDueMaintenance(options(fs, { nowFn: () => NOW + 60000, scanImpl: async () => assert.fail('local publication repair must not repeat GPT'), syncImpl: async () => { syncs++; return { updated: true }; } }));
  assert.equal(syncs, 2); assert.equal(result.state.status, 'success');
});

test('verification retries do not repeat a successful scan or a successful GitHub update', async t => {
  const fs = await fixture(t);
  const failed = await runDueMaintenance(options(fs, { verifyImpl: async () => { throw new Error('private deployed page'); } }));
  assert.equal(failed.state.status, 'error'); assert.deepEqual(failed.state.retryStages, ['verify']);
  const recovered = await runDueMaintenance(options(fs, { nowFn: () => NOW + 300000, scanImpl: async () => assert.fail('scan repeated'), syncImpl: async () => assert.fail('sync repeated') }));
  assert.equal(recovered.state.status, 'success'); assert.equal(recovered.state.lastSuccessAt, iso(NOW + 300000));
});

test('scanner busy keeps the active owner visible and postpones every publishing stage', async t => {
  const fs = await fixture(t);
  const result = await runDueMaintenance(options(fs, { scanImpl: async () => ({ ran: false, busy: true, state: scanState({ status: 'running' }) }), syncImpl: async () => assert.fail('sync while scan is active'), verifyImpl: async () => assert.fail('verify while scan is active') }));
  assert.equal(result.ran, false); assert.equal(result.busy, true); assert.equal(result.retryAfterMs, 30000);
  assert.equal(result.state.scanState.status, 'running'); assert.equal(result.state.nextMaintenanceAt, iso(NOW + 30000));
  const recovered = await runDueMaintenance(options(fs, { nowFn: () => NOW + 30000, scanImpl: async () => ({ ran: false, state: scanState() }) }));
  assert.equal(recovered.state.status, 'success'); assert.equal(recovered.state.lastSync.status, 'success');
});

test('a live maintenance lock protects one round and cannot be stolen even if its date is old', async t => {
  const fs = await fixture(t); const entered = deferred(), finish = deferred(); let calls = 0;
  const first = runDueMaintenance(options(fs, { scanImpl: async () => { calls++; entered.resolve(); return finish.promise; } }));
  await entered.promise;
  const before = await fs.text('work/maintenance-state.json');
  const other = await runDueMaintenance(options(fs, { nowFn: () => NOW + 86400000, scanImpl: async () => { calls++; return successfulScan(); } }));
  assert.equal(other.busy, true); assert.equal(calls, 1); assert.equal(await fs.text('work/maintenance-state.json'), before);
  finish.resolve({ ran: true, state: scanState() }); await first;
  await assert.rejects(access(join(fs.root, 'work/maintenance-run.lock')), { code: 'ENOENT' });
});

test('malformed locks remain untouched and a verified dead owner can be recovered', async t => {
  const fs = await fixture(t); const lock = join(fs.root, 'work/maintenance-run.lock');
  await writeFile(lock, '{broken');
  const busy = await runDueMaintenance(options(fs, { scanImpl: async () => assert.fail('bad lock stolen') }));
  assert.equal(busy.busy, true); assert.equal(await readFile(lock, 'utf8'), '{broken');
  const child = spawn(process.execPath, ['-e', '']); await once(child, 'exit');
  await fs.put('work/maintenance-run.lock', { pid: child.pid, token: '12345678-1234-1234-1234-123456789012', createdAt: iso(NOW) });
  assert.equal((await runDueMaintenance(options(fs))).state.status, 'success');
});

test('safe state, observer updates and local reports reject arbitrary provider bodies and mock secrets', async t => {
  const fs = await fixture(t); const observed = [];
  const result = await runDueMaintenance(options(fs, {
    scanImpl: async () => ({ ran: true, state: scanState({ apiKey: 'sensitive-value', lastError: 'sensitive-value', lastResult: { model: 'gpt-test', published: 2, token: 'sensitive-value', publication: { status: 'completed', apiKey: 'sensitive-value', failed: 0 } } }) }),
    syncImpl: async () => ({ updated: true, commitUrl: `${COMMIT_URL}?token=sensitive-value`, token: 'sensitive-value', files: [{ path: 'data/offers.json', updated: true, commitUrl: COMMIT_URL, secret: 'sensitive-value' }] }),
    verifyImpl: async () => ({ status: 'failed', code: 'sensitive-value', commit: 'sensitive-value', deploymentUrl: 'https://secret.example/?token=sensitive-value', checks: { homepage: false, arbitrary: 'sensitive-value' }, error: 'sensitive-value' }),
    onState: state => { observed.push(state); throw new Error('sensitive-value'); },
  }));
  const content = JSON.stringify([result, observed, await fs.read('work/maintenance-state.json'), await fs.read('work/maintenance-report.json')]);
  assert(!content.includes('sensitive-value')); assert.equal(result.state.scanState.lastResult.published, 2);
  assert.equal(result.state.lastVerification.checks.homepage, false); assert.equal(result.state.lastVerification.code, 'VERIFICATION_FAILED');
  assert.equal(result.state.lastSync.commitUrl, null);
});

test('scheduler chooses the earlier scanner deadline and stop waits for an active round', async t => {
  const fs = await fixture(t); const clock = timers(); const entered = deferred(), finish = deferred();
  const scheduler = startMaintenanceScheduler(options(fs, { ...clock, scanImpl: async () => { entered.resolve(); return finish.promise; } }));
  await entered.promise; let stopped = false; const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal(clock.pending.size, 0);
  finish.resolve({ ran: true, state: scanState({ nextScanAt: iso(NOW + 900000) }) }); await stopping;
  assert.equal(scheduler.getStatus().status, 'success'); assert.equal(scheduler.getScanStatus().status, 'idle'); assert.equal(clock.pending.size, 0);
  const again = startMaintenanceScheduler(options(fs, { ...clock })); await again.firstRun;
  assert.equal(clock.take().ms, 900000); await again.stop();
});

test('scheduler keeps a bounded future retry when persistent state cannot be read', async t => {
  const fs = await fixture(t); const clock = timers();
  await writeFile(join(fs.root, 'work/maintenance-state.json'), '{broken');
  const scheduler = startMaintenanceScheduler(options(fs, { ...clock, scanImpl: async () => assert.fail('unreadable state started scan') }));
  assert.equal((await scheduler.firstRun).status, 'error'); assert.equal(clock.take().ms, 300000);
  await scheduler.stop();
});


test('pending production verification cannot starve a scanner whose own deadline arrives', async t => {
  const fs = await fixture(t); let scans = 0, syncs = 0, verifies = 0;
  const input = options(fs, {
    scanImpl: async () => { scans++; return { ran: true, state: scanState({ nextScanAt: iso(NOW + (scans === 1 ? 120000 : 3600000)) }) }; },
    syncImpl: async () => { syncs++; return { updated: false }; },
    verifyImpl: async () => { verifies++; return { status: 'pending' }; },
  });
  await runDueMaintenance(input);
  await runDueMaintenance({ ...input, nowFn: () => NOW + 60000 });
  assert.equal(scans, 1); assert.equal(syncs, 1); assert.equal(verifies, 2);
  await runDueMaintenance({ ...input, nowFn: () => NOW + 120000 });
  assert.equal(scans, 2); assert.equal(syncs, 2); assert.equal(verifies, 3);
});

test('degraded discovery or dating respects its future scanner budget and normal skipped rounds still publish', async t => {
  const fs = await fixture(t); let scans = 0, syncs = 0;
  const input = options(fs, {
    scanImpl: async () => { scans++; return { ran: false, state: scanState({ status: 'degraded', nextScanAt: iso(NOW + 600000), lastResult: { publication: { status: 'partial', deferredFailures: 10 } } }) }; },
    syncImpl: async () => { syncs++; return { updated: false }; },
  });
  const first = await runDueMaintenance(input);
  assert.equal(first.state.status, 'degraded'); assert.equal(first.state.nextMaintenanceAt, iso(NOW + 600000));
  assert.equal((await runDueMaintenance({ ...input, nowFn: () => NOW + 300000 })).ran, false);
  assert.equal(scans, 1); assert.equal(syncs, 1);
  const second = await runDueMaintenance({ ...input, nowFn: () => NOW + 600000, scanImpl: async () => ({ ran: false, state: scanState({ status: 'degraded', nextScanAt: iso(NOW + 4200000) }) }) });
  assert.equal(second.state.status, 'degraded'); assert.equal(syncs, 2);
  assert.equal(second.state.nextMaintenanceAt, iso(NOW + 4200000));
});

test('a stale scanner deadline after a completed round has a bounded recheck instead of a one-second loop', async t => {
  const fs = await fixture(t); const clock = timers();
  const scheduler = startMaintenanceScheduler(options(fs, { ...clock, scanImpl: async () => ({ ran: false, state: scanState({ nextScanAt: iso(NOW - 1000) }) }) }));
  const state = await scheduler.firstRun;
  assert.equal(state.nextMaintenanceAt, iso(NOW + 30000)); assert.equal(clock.take().ms, 30000);
  await scheduler.stop();
});
