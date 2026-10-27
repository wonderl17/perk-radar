import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, isMain, readJson, writeJson } from './lib.mjs';
import { ingest } from './ingest.mjs';

const MINUTE = 60000;
const BUSY_RECHECK_MS = 30000;
const DEFAULTS = { scanIntervalMinutes: 60, maxItemsPerScan: 6, retryIntervalMinutes: 15 };
const RESULT_COUNTS = ['examined', 'published', 'updated', 'flagged', 'held', 'rejected', 'failed'];
const SCAN_ERROR = 'Automatic scan failed; inspect the local ingestion report before retrying.';

function integer(value, name, min, max) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    value = Number(value);
  }
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function validateConfig(config) {
  const result = {
    scanIntervalMinutes: integer(config.scanIntervalMinutes, 'scanIntervalMinutes', 5, 10080),
    maxItemsPerScan: integer(config.maxItemsPerScan, 'maxItemsPerScan', 1, 30),
    retryIntervalMinutes: integer(config.retryIntervalMinutes, 'retryIntervalMinutes', 1, 60),
  };
  if (result.retryIntervalMinutes > result.scanIntervalMinutes) throw new Error('retryIntervalMinutes must not exceed scanIntervalMinutes.');
  return result;
}
export async function loadScanConfig({ root = ROOT, env = process.env } = {}) {
  const saved = await readJson(resolve(root, 'data/runtime.json'), {});
  return validateConfig({
    scanIntervalMinutes: env.PERK_SCAN_INTERVAL_MINUTES ?? saved.scanIntervalMinutes ?? DEFAULTS.scanIntervalMinutes,
    maxItemsPerScan: env.PERK_SCAN_LIMIT ?? saved.maxItemsPerScan ?? DEFAULTS.maxItemsPerScan,
    retryIntervalMinutes: env.PERK_SCAN_RETRY_MINUTES ?? saved.retryIntervalMinutes ?? DEFAULTS.retryIntervalMinutes,
  });
}
function timeOf(nowFn) {
  const value = nowFn();
  const time = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('The scan clock is invalid.');
  return time;
}
const iso = time => new Date(time).toISOString();
function dateOrNull(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null; }
function resultSummary(result) {
  if (!result || typeof result !== 'object') return null;
  const summary = {};
  for (const key of RESULT_COUNTS) if (Number.isInteger(result[key]) && result[key] >= 0) summary[key] = result[key];
  if (typeof result.model === 'string' && /^[a-z0-9_./:-]{1,160}$/i.test(result.model)) summary.model = result.model;
  if (dateOrNull(result.finishedAt)) summary.finishedAt = result.finishedAt;
  const sourceFailures = result.discovery?.failures ?? result.sourceFailures;
  if (Number.isInteger(sourceFailures) && sourceFailures >= 0) summary.sourceFailures = sourceFailures;
  const discovery = result.discovery?.autonomous ?? result.autonomousDiscovery;
  if (discovery && typeof discovery === 'object') summary.autonomousDiscovery = Object.fromEntries(['added', 'held', 'failed', 'considered', 'searchResults'].filter(key => Number.isInteger(discovery[key]) && discovery[key] >= 0).map(key => [key, discovery[key]]));
  return summary;
}
function cleanState(raw = {}) {
  return {
    schemaVersion: 1,
    status: ['running', 'idle', 'error'].includes(raw.status) ? raw.status : 'idle',
    startedAt: dateOrNull(raw.startedAt),
    lastAttemptAt: dateOrNull(raw.lastAttemptAt),
    lastSuccessAt: dateOrNull(raw.lastSuccessAt),
    nextScanAt: dateOrNull(raw.nextScanAt),
    lastResult: resultSummary(raw.lastResult),
    lastError: raw.status === 'error' ? SCAN_ERROR : null,
  };
}
async function readState(root) {
  try { return cleanState(await readJson(resolve(root, 'work/scan-state.json'), {})); }
  catch { throw new Error('Scan state is unreadable; restore work/scan-state.json before retrying.'); }
}
function isDue(state, now) {
  return state.status === 'running' || !state.nextScanAt || Date.parse(state.nextScanAt) <= now;
}
async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : true; }
}
async function acquireScanLock(root, now) {
  const path = resolve(root, 'work/scan-run.lock');
  await mkdir(resolve(root, 'work'), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    const token = randomUUID();
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: iso(now) }));
      return async () => {
        await handle.close();
        try {
          const current = await readJson(path);
          if (current.token === token) await unlink(path);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); throw error; }
      if (error.code !== 'EEXIST') throw error;
      let before, metadata;
      try { before = await readFile(path, 'utf8'); metadata = JSON.parse(before); }
      catch (error) { if (error.code === 'ENOENT') continue; return null; }
      if (await pidAlive(metadata.pid) !== false) return null;
      // Never delete a live owner's lock. Re-read before removing a dead PID's
      // file so a concurrent recovery does not casually remove a replacement.
      try { if (await readFile(path, 'utf8') !== before) continue; await unlink(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return null;
}

/** Run at most once when due. It is safe for the application and a scheduled
 * task to call this command: a successful scan persists the next due time. */
export async function runDueScan({ root = ROOT, config, ingestImpl = ingest, nowFn = () => Date.now(), onState } = {}) {
  config = validateConfig(config ?? await loadScanConfig({ root }));
  let state = await readState(root);
  const now = timeOf(nowFn);
  if (!isDue(state, now)) return { ran: false, state };
  const release = await acquireScanLock(root, now);
  if (!release) return { ran: false, busy: true, retryAfterMs: BUSY_RECHECK_MS, state: await readState(root) };
  try {
    state = await readState(root);
    if (!isDue(state, timeOf(nowFn))) return { ran: false, state };
    const startedAt = iso(timeOf(nowFn));
    state = { ...state, status: 'running', startedAt, lastAttemptAt: startedAt, nextScanAt: null, lastError: null };
    await writeJson(resolve(root, 'work/scan-state.json'), state);
    try { onState?.(structuredClone(state)); } catch {}
    try {
      const report = await ingestImpl({ root, limit: config.maxItemsPerScan });
      if (!report || typeof report !== 'object') throw new Error('Missing scan report');
      const finished = timeOf(nowFn);
      const failed = (Number(report.failed) || 0) > 0 || (Number(report.discovery?.failures) || 0) > 0 || (Number(report.discovery?.autonomous?.failed) || 0) > 0;
      state = {
        ...state, status: failed ? 'error' : 'idle',
        lastSuccessAt: failed ? state.lastSuccessAt : iso(finished),
        nextScanAt: iso(finished + (failed ? config.retryIntervalMinutes : config.scanIntervalMinutes) * MINUTE),
        lastResult: resultSummary(report), lastError: failed ? SCAN_ERROR : null,
      };
    } catch {
      const finished = timeOf(nowFn);
      state = { ...state, status: 'error', nextScanAt: iso(finished + config.retryIntervalMinutes * MINUTE), lastError: SCAN_ERROR };
    }
    await writeJson(resolve(root, 'work/scan-state.json'), state);
    try { onState?.(structuredClone(state)); } catch {}
    return { ran: true, state };
  } finally { await release(); }
}

/** Start with a due check, then schedule the next check only after the previous
 * one settles. stop() waits for the current scan instead of interrupting GPT. */
export function startScanScheduler({ root = ROOT, config, ingestImpl = ingest, nowFn = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onState } = {}) {
  // The application resolves project config before opening its server.
  config = validateConfig(config ?? DEFAULTS);
  let stopped = false, timer = null, current;
  let state = cleanState();
  const publishState = () => { try { onState?.(structuredClone(state)); } catch { /* Status observers cannot stop scanning. */ } };
  async function tick() {
    if (stopped) return structuredClone(state);
    let recheck;
    try {
      const result = await runDueScan({ root, config, ingestImpl, nowFn, onState: value => { state = value; publishState(); } });
      state = result.state; recheck = result.retryAfterMs;
    } catch {
      const now = timeOf(nowFn);
      state = { ...state, status: 'error', nextScanAt: iso(now + config.retryIntervalMinutes * MINUTE), lastError: SCAN_ERROR };
    }
    publishState();
    if (!stopped) {
      const now = timeOf(nowFn);
      const delay = recheck ?? (dateOrNull(state.nextScanAt) ? Date.parse(state.nextScanAt) - now : BUSY_RECHECK_MS);
      timer = setTimeoutImpl(() => { timer = null; current = tick(); }, Math.max(1000, Math.min(delay, 2147483647)));
    }
    return structuredClone(state);
  }
  current = tick();
  const firstRun = current;
  return {
    firstRun,
    getStatus: () => structuredClone(state),
    async stop() {
      stopped = true;
      if (timer !== null) { clearTimeoutImpl(timer); timer = null; }
      await current;
    },
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--status')) throw new Error('Usage: node scripts/scan.mjs [--status]');
    const config = await loadScanConfig();
    if (args.includes('--status')) console.log(JSON.stringify({ config, state: await readState(ROOT) }));
    else {
      const result = await runDueScan({ config });
      console.log(JSON.stringify(result));
      if (result.state.status === 'error') process.exitCode = 1;
    }
  } catch { console.error('Scheduled scanning could not run. Check project runtime configuration and local scan state.'); process.exitCode = 1; }
}
