import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, isMain, readJson, writeJson } from './lib.mjs';
import { runDueScan } from './scan.mjs';
import { syncGithub } from './sync-github.mjs';
import { verifySite } from './verify-site.mjs';

const MINUTE = 60000;
const BUSY_RECHECK_MS = 30000;
const DEFAULTS = { enabled: false, intervalMinutes: 60, retryIntervalMinutes: 5, deploymentPollMinutes: 1 };
const STAGES = ['scan', 'sync', 'verify'];
const SHA = /^[a-f0-9]{40}$/i;
const FILES = ['data/offers.json', 'data/sources.json'];
const ERROR = 'Project maintenance needs attention; inspect the local maintenance report.';
const SCAN_ERROR = 'Automatic scan failed; inspect the local ingestion report before retrying.';
const SCAN_DEGRADED = 'Autonomous discovery or publication dating is degraded; inspect the local reports.';
const VERIFICATION_CODES = ['LOCAL_DATA_INVALID', 'ACCOUNT_UNAVAILABLE', 'ACCOUNT_MISMATCH', 'GITHUB_UNAVAILABLE', 'DEPLOYMENT_PENDING', 'DEPLOYMENT_FAILED', 'SITE_UNAVAILABLE', 'SITE_MISMATCH', 'LOCAL_CHANGED', 'BRANCH_CHANGED'];
const COUNT_KEYS = ['examined', 'published', 'updated', 'flagged', 'held', 'rejected', 'failed', 'sourceFailures'];

function integer(value, name, min, max) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function validateConfig(value) {
  if (typeof value.enabled !== 'boolean') throw new Error('Maintenance enabled must be a boolean.');
  const config = {
    enabled: value.enabled,
    intervalMinutes: integer(value.intervalMinutes, 'intervalMinutes', 5, 10080),
    retryIntervalMinutes: integer(value.retryIntervalMinutes, 'retryIntervalMinutes', 1, 60),
    deploymentPollMinutes: integer(value.deploymentPollMinutes, 'deploymentPollMinutes', 1, 60),
  };
  if (config.retryIntervalMinutes > config.intervalMinutes || config.deploymentPollMinutes > config.intervalMinutes) throw new Error('Maintenance retry and deployment polling must not exceed the maintenance interval.');
  return config;
}
export async function loadMaintenanceConfig({ root = ROOT, env = process.env } = {}) {
  const saved = await readJson(resolve(root, 'data/maintenance.json'), {});
  let enabled = env.PERK_MAINTENANCE_ENABLED ?? saved.enabled ?? DEFAULTS.enabled;
  if (enabled === 'true') enabled = true;
  else if (enabled === 'false') enabled = false;
  return validateConfig({
    enabled,
    intervalMinutes: env.PERK_MAINTENANCE_INTERVAL_MINUTES ?? saved.intervalMinutes ?? DEFAULTS.intervalMinutes,
    retryIntervalMinutes: env.PERK_MAINTENANCE_RETRY_MINUTES ?? saved.retryIntervalMinutes ?? DEFAULTS.retryIntervalMinutes,
    deploymentPollMinutes: env.PERK_MAINTENANCE_DEPLOYMENT_POLL_MINUTES ?? saved.deploymentPollMinutes ?? DEFAULTS.deploymentPollMinutes,
  });
}
function timeOf(nowFn) {
  const value = nowFn();
  const time = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('The maintenance clock is invalid.');
  return time;
}
const iso = value => new Date(value).toISOString();
function dateOrNull(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}
function counts(value, keys) {
  return Object.fromEntries(keys.filter(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0).map(key => [key, value[key]]));
}
function cleanScanResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const result = counts(raw, COUNT_KEYS);
  if (typeof raw.model === 'string' && /^[a-z0-9_./:-]{1,160}$/i.test(raw.model) && !/ghp_|github_pat_|sk-|bearer|token|secret|credential/i.test(raw.model)) result.model = raw.model;
  if (dateOrNull(raw.finishedAt)) result.finishedAt = raw.finishedAt;
  for (const key of ['autonomousDiscovery', 'publication']) {
    if (!raw[key] || typeof raw[key] !== 'object') continue;
    result[key] = counts(raw[key], key === 'publication' ? ['examined', 'updated', 'known', 'unknown', 'failed', 'deferredFailures'] : ['added', 'held', 'failed', 'considered', 'searchResults']);
    if (['completed', 'empty', 'partial', 'failed', 'skipped', 'busy', 'disabled'].includes(raw[key].status)) result[key].status = raw[key].status;
    for (const date of ['startedAt', 'finishedAt', 'nextRunAt']) if (dateOrNull(raw[key][date])) result[key][date] = raw[key][date];
  }
  return result;
}
function cleanScanState(raw = {}) {
  const status = ['running', 'idle', 'degraded', 'error'].includes(raw?.status) ? raw.status : 'idle';
  return {
    schemaVersion: 1, status,
    startedAt: dateOrNull(raw?.startedAt), lastAttemptAt: dateOrNull(raw?.lastAttemptAt), lastSuccessAt: dateOrNull(raw?.lastSuccessAt), nextScanAt: dateOrNull(raw?.nextScanAt),
    lastResult: cleanScanResult(raw?.lastResult), lastError: status === 'error' ? SCAN_ERROR : status === 'degraded' ? SCAN_DEGRADED : null,
  };
}
function commitUrl(value) {
  return typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/commit\/[a-f0-9]{40}$/i.test(value) ? value : null;
}
function deploymentUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !(url.hostname === 'vercel.com' || /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)) || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname) || url.pathname.length > 400 || /ghp_|github_pat_|sk-|token|secret/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
function cleanFiles(raw) {
  return Array.isArray(raw) ? raw.filter(file => FILES.includes(file?.path) && typeof file.updated === 'boolean').slice(0, FILES.length).map(file => ({ path: file.path, updated: file.updated, commitUrl: commitUrl(file.commitUrl) })) : [];
}
function cleanSync(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    status: raw.status === 'success' ? 'success' : 'failed', attemptedAt: dateOrNull(raw.attemptedAt),
    updated: raw.updated === true || cleanFiles(raw.completedFiles).some(file => file.updated), commitUrl: commitUrl(raw.commitUrl) ?? cleanFiles(raw.completedFiles).findLast(file => file.updated && file.commitUrl)?.commitUrl ?? null, files: cleanFiles(raw.files), completedFiles: cleanFiles(raw.completedFiles),
    ...(raw.statusCode === 409 ? { statusCode: 409 } : {}),
    code: raw.status === 'success' ? 'SYNC_OK' : raw.statusCode === 409 ? 'SYNC_CONFLICT' : 'SYNC_FAILED',
  };
}
function cleanVerification(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = ['success', 'pending', 'failed'].includes(raw.status) ? raw.status : 'failed';
  const result = { status, attemptedAt: dateOrNull(raw.attemptedAt) };
  if (typeof raw.commit === 'string' && SHA.test(raw.commit)) result.commit = raw.commit;
  if (deploymentUrl(raw.deploymentUrl)) result.deploymentUrl = deploymentUrl(raw.deploymentUrl);
  // The verifier owns descriptive errors. Persist only a bounded known result.
  result.code = VERIFICATION_CODES.includes(raw.code) ? raw.code : status === 'success' ? 'VERIFICATION_OK' : status === 'pending' ? 'DEPLOYMENT_PENDING' : 'VERIFICATION_FAILED';
  if (raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks)) {
    result.checks = Object.fromEntries(['githubAccount', 'homepage', 'offers', 'rss', 'localSnapshot', 'branchStable'].filter(key => typeof raw.checks[key] === 'boolean').map(key => [key, raw.checks[key]]));
    if (['success', 'pending', 'failed'].includes(raw.checks.vercel)) result.checks.vercel = raw.checks.vercel;
  }
  return result;
}
function cleanState(raw = {}) {
  const status = ['idle', 'disabled', 'running', 'success', 'degraded', 'error', 'pending'].includes(raw.status) ? raw.status : 'idle';
  return {
    schemaVersion: 1, status,
    phase: STAGES.includes(raw.phase) ? raw.phase : null,
    lastAttemptAt: dateOrNull(raw.lastAttemptAt), lastSuccessAt: dateOrNull(raw.lastSuccessAt), nextMaintenanceAt: dateOrNull(raw.nextMaintenanceAt),
    scanState: cleanScanState(raw.scanState), lastSync: cleanSync(raw.lastSync), lastVerification: cleanVerification(raw.lastVerification),
    stages: Object.fromEntries(STAGES.map(key => [key, ['idle', 'running', 'success', 'skipped', 'busy', 'degraded', 'error', 'pending'].includes(raw.stages?.[key]) ? raw.stages[key] : 'idle'])),
    retryStages: STAGES.filter(key => raw.retryStages?.includes?.(key)), pendingVerification: raw.pendingVerification === true,
    lastError: ['degraded', 'error'].includes(status) ? ERROR : null,
  };
}
async function readState(root) {
  try {
    const raw = await readJson(resolve(root, 'work/maintenance-state.json'), {});
    if (!raw.scanState) raw.scanState = await readJson(resolve(root, 'work/scan-state.json'), {});
    return cleanState(raw);
  } catch { throw new Error('Maintenance state is unreadable; restore the local state before retrying.'); }
}
function isDue(state, now) { return !state.nextMaintenanceAt || Date.parse(state.nextMaintenanceAt) <= now; }
async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : true; }
}
async function acquireLock(root, now) {
  const path = resolve(root, 'work/maintenance-run.lock');
  await mkdir(resolve(root, 'work'), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    const token = randomUUID();
    const bytes = JSON.stringify({ pid: process.pid, token, createdAt: iso(now) });
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(bytes);
      return async () => {
        await handle.close();
        try { if (await readFile(path, 'utf8') === bytes) await unlink(path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); throw error; }
      if (error.code !== 'EEXIST') throw error;
      let before, metadata;
      try { before = await readFile(path, 'utf8'); metadata = JSON.parse(before); }
      catch (error) { if (error.code === 'ENOENT') continue; return null; }
      if (!metadata || typeof metadata.token !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(metadata.token) || !dateOrNull(metadata.createdAt) || await pidAlive(metadata.pid) !== false) return null;
      try { if (await readFile(path, 'utf8') !== before) continue; await unlink(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return null;
}

/** One durable maintenance round. Scanner due checks retain all GPT budgets;
 * publishing and independent production verification can recover separately. */
export async function runDueMaintenance({ root = ROOT, config, nowFn = () => Date.now(), scanImpl = runDueScan, syncImpl = syncGithub, verifyImpl = verifySite, onState } = {}) {
  config = validateConfig(config ?? await loadMaintenanceConfig({ root }));
  let state = await readState(root);
  if (!config.enabled) return { ran: false, state: cleanState({ ...state, status: 'disabled' }) };
  if (!isDue(state, timeOf(nowFn))) return { ran: false, state };
  const release = await acquireLock(root, timeOf(nowFn));
  if (!release) return { ran: false, busy: true, retryAfterMs: BUSY_RECHECK_MS, state: await readState(root) };
  try {
    state = await readState(root);
    if (!isDue(state, timeOf(nowFn))) return { ran: false, state };
    const startedAt = iso(timeOf(nowFn));
    const scannerDeadline = Date.parse(state.scanState.nextScanAt);
    const scannerDue = Number.isFinite(scannerDeadline) && scannerDeadline <= timeOf(nowFn);
    const publishingRetries = state.retryStages.filter(key => key !== 'scan');
    const plan = scannerDue || state.stages.scan === 'busy' ? [...STAGES]
      : state.pendingVerification ? state.lastVerification?.code === 'LOCAL_CHANGED' ? ['sync', 'verify'] : ['verify']
        : publishingRetries.length ? publishingRetries : [...STAGES];
    const failed = new Set(state.retryStages);
    state = { ...state, status: 'running', phase: plan[0], lastAttemptAt: startedAt, nextMaintenanceAt: null, lastError: null };
    const publish = async () => {
      state = cleanState(state);
      await writeJson(resolve(root, 'work/maintenance-state.json'), state);
      try { onState?.(structuredClone(state)); } catch { /* Observers cannot interrupt maintenance. */ }
    };
    await publish();
    if (plan.includes('scan')) {
      state.phase = 'scan'; state.stages.scan = 'running'; await publish();
      try {
        const result = await scanImpl({ root });
        if (!result || typeof result !== 'object' || !result.state || typeof result.state !== 'object') throw new Error('Missing scan state');
        state.scanState = cleanScanState(result.state);
        if (result.busy) {
          state.status = 'running'; state.phase = 'scan'; state.stages.scan = 'busy'; state.retryStages = [...STAGES];
          state.nextMaintenanceAt = iso(timeOf(nowFn) + BUSY_RECHECK_MS); await publish();
          await writeJson(resolve(root, 'work/maintenance-report.json'), { schemaVersion: 1, startedAt, finishedAt: iso(timeOf(nowFn)), busy: true, state });
          return { ran: false, busy: true, retryAfterMs: BUSY_RECHECK_MS, state };
        }
        state.stages.scan = ['error', 'degraded'].includes(state.scanState.status) ? state.scanState.status : result.ran ? 'success' : 'skipped';
        if (['error', 'degraded'].includes(state.stages.scan)) failed.add('scan'); else failed.delete('scan');
        // A completed or skipped due check still compares reviewed JSON. Another
        // scanner may have finished while this maintenance caller was waiting.
        if (!plan.includes('sync')) plan.push('sync');
      } catch {
        state.stages.scan = 'error'; failed.add('scan');
        state.scanState = { ...state.scanState, status: 'error', lastError: SCAN_ERROR };
        if (!plan.includes('sync')) plan.push('sync');
      }
      await publish();
    }
    if (plan.includes('sync')) {
      state.phase = 'sync'; state.stages.sync = 'running'; await publish();
      const attemptedAt = iso(timeOf(nowFn));
      try {
        const result = await syncImpl({ root });
        if (!result || typeof result !== 'object' || typeof result.updated !== 'boolean') throw new Error('Missing sync result');
        state.lastSync = cleanSync({ ...result, status: 'success', attemptedAt });
        state.stages.sync = 'success'; failed.delete('sync');
      } catch (error) {
        state.lastSync = cleanSync({ status: 'failed', attemptedAt, completedFiles: error?.completedFiles, statusCode: error?.statusCode });
        state.stages.sync = 'error'; failed.add('sync');
      }
      // Verify even after a partial or failed sync: production is independent.
      if (!plan.includes('verify')) plan.push('verify');
      await publish();
    }
    if (plan.includes('verify')) {
      state.phase = 'verify'; state.stages.verify = 'running'; await publish();
      const attemptedAt = iso(timeOf(nowFn));
      try { state.lastVerification = cleanVerification({ ...await verifyImpl({ root }), attemptedAt }); }
      catch { state.lastVerification = cleanVerification({ status: 'failed', attemptedAt }); }
      const verification = state.lastVerification;
      state.stages.verify = verification.status === 'failed' ? 'error' : verification.status;
      state.pendingVerification = verification.status === 'pending';
      if (verification.status === 'failed') failed.add('verify'); else failed.delete('verify');
      await publish();
    }
    const finished = timeOf(nowFn);
    state.retryStages = STAGES.filter(key => failed.has(key));
    state.phase = null;
    const scanDue = Date.parse(state.scanState.nextScanAt);
    const futureScan = Number.isFinite(scanDue) && scanDue > finished ? scanDue : Infinity;
    if (state.pendingVerification) {
      state.status = 'pending'; state.nextMaintenanceAt = iso(Math.min(finished + config.deploymentPollMinutes * MINUTE, futureScan));
    } else if (failed.size) {
      state.status = [...failed].some(key => state.stages[key] === 'error') ? 'error' : 'degraded';
      // Discovery and dating carry their own later retry budgets. Rechecking an
      // unchanged degraded result every five minutes cannot recover that work.
      const onlyDeferredScan = failed.size === 1 && failed.has('scan') && state.stages.scan === 'degraded' && Number.isFinite(futureScan);
      state.nextMaintenanceAt = iso(Math.min(finished + (onlyDeferredScan ? config.intervalMinutes : config.retryIntervalMinutes) * MINUTE, futureScan));
    } else {
      state.status = 'success'; state.lastSuccessAt = iso(finished);
      const boundedScan = Number.isFinite(scanDue) && scanDue <= finished ? finished + BUSY_RECHECK_MS : futureScan;
      state.nextMaintenanceAt = iso(Math.min(finished + config.intervalMinutes * MINUTE, boundedScan));
    }
    await publish();
    await writeJson(resolve(root, 'work/maintenance-report.json'), { schemaVersion: 1, startedAt, finishedAt: iso(finished), state });
    return { ran: true, state: structuredClone(state) };
  } finally { await release(); }
}

/** Serial scheduler. stop() lets the current round settle and prevents another
 * timer from being created while that round is finishing. */
export function startMaintenanceScheduler({ root = ROOT, config, nowFn = () => Date.now(), scanImpl = runDueScan, syncImpl = syncGithub, verifyImpl = verifySite, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, onState } = {}) {
  config = validateConfig(config ?? DEFAULTS);
  let stopped = false, timer = null, current;
  let state = cleanState();
  const publish = () => { try { onState?.(structuredClone(state)); } catch {} };
  async function tick() {
    if (stopped) return structuredClone(state);
    let recheck;
    try {
      const result = await runDueMaintenance({ root, config, nowFn, scanImpl, syncImpl, verifyImpl, onState: value => { state = value; publish(); } });
      state = result.state; recheck = result.retryAfterMs;
    } catch {
      let now; try { now = timeOf(nowFn); } catch { now = Date.now(); }
      state = cleanState({ ...state, status: 'error', phase: null, nextMaintenanceAt: iso(now + config.retryIntervalMinutes * MINUTE) });
    }
    publish();
    if (!stopped && config.enabled) {
      let now; try { now = timeOf(nowFn); } catch { now = Date.now(); }
      const delay = recheck ?? (dateOrNull(state.nextMaintenanceAt) ? Date.parse(state.nextMaintenanceAt) - now : BUSY_RECHECK_MS);
      timer = setTimeoutImpl(() => { timer = null; current = tick(); }, Math.max(1000, Math.min(delay, 2147483647)));
    }
    return structuredClone(state);
  }
  current = tick();
  const firstRun = current;
  return {
    firstRun,
    getStatus: () => structuredClone(state), getScanStatus: () => structuredClone(state.scanState),
    async stop() { stopped = true; if (timer !== null) { clearTimeoutImpl(timer); timer = null; } await current; },
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--status')) throw new Error('Invalid maintenance arguments');
    const config = await loadMaintenanceConfig();
    if (args.includes('--status')) console.log(JSON.stringify({ enabled: config.enabled, state: await readState(ROOT) }));
    else {
      const result = await runDueMaintenance({ config }); console.log(JSON.stringify(result));
      if (['error', 'degraded'].includes(result.state.status)) process.exitCode = 1;
    }
  } catch { console.error('Project maintenance could not run. Check maintenance configuration and local state.'); process.exitCode = 1; }
}
