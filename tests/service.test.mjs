import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startService } from '../scripts/service.mjs';

const config = { scanIntervalMinutes: 360, maxItemsPerScan: 6, retryIntervalMinutes: 15 };
test('starting the running project scans once, serves safe status and resumes the durable schedule', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const ingestImpl = async () => { calls++; return { examined: 1, published: 1, updated: 0, flagged: 0, held: 0, rejected: 0, failed: 0, apiKey: 'never-expose-this', model: 'test-model' }; };
  const runtime = await startService({ root, config, port: 0, ingestImpl });
  t.after(() => runtime.stop());
  await runtime.scheduler.firstRun;
  assert.equal(calls, 1);
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/health`);
  const text = await response.text();
  assert.equal(response.status, 200);
  const health = JSON.parse(text);
  assert.equal(health.status, 'ok');
  assert.equal(health.scanner.status, 'idle');
  assert.equal(health.scanner.lastResult.published, 1);
  assert(!text.includes('never-expose-this'));
  assert(health.scanner.nextScanAt);
  await runtime.stop();
  const restarted = await startService({ root, config, port: 0, ingestImpl });
  t.after(() => restarted.stop());
  await restarted.scheduler.firstRun;
  assert.equal(calls, 1, 'restarting before the next due time must not call GPT again');
});
test('a port conflict aborts startup before any paid model work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-service-port-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupying = createServer();
  await new Promise(done => occupying.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => occupying.close(done)));
  let calls = 0;
  await assert.rejects(startService({ root, config, port: occupying.address().port, ingestImpl: async () => { calls++; return {}; } }), error => error.code === 'EADDRINUSE');
  assert.equal(calls, 0);
});

test('the project service owns scanning, GitHub sync and verified publishing without a Codex trigger', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-service-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maintenanceConfig = { enabled: true, intervalMinutes: 60, retryIntervalMinutes: 5, deploymentPollMinutes: 1 };
  const calls = [];
  const options = { root, config, maintenanceConfig, port: 0,
    ingestImpl: async () => { calls.push('scan'); return { examined: 1, published: 0, updated: 0, held: 1, failed: 0 }; },
    syncImpl: async () => { calls.push('sync'); return { updated: false, apiKey: 'never-expose-this-sync-secret' }; },
    verifyImpl: async () => { calls.push('verify'); return { status: 'success', commit: 'a'.repeat(40), apiKey: 'never-expose-this-verify-secret' }; },
  };
  const runtime = await startService(options); t.after(() => runtime.stop());
  await runtime.maintenance.firstRun;
  assert.deepEqual(calls, ['scan', 'sync', 'verify']);
  const response = await fetch(`http://127.0.0.1:${runtime.address.port}/api/health`);
  const text = await response.text(), health = JSON.parse(text);
  assert.equal(health.scanner.status, 'idle');
  assert.equal(health.maintenance.lastVerification.status, 'success');
  assert.equal(health.maintenance.lastVerification.commit, 'a'.repeat(40));
  assert.ok(health.maintenance.nextMaintenanceAt);
  assert.ok(!text.includes('secret'));
  await runtime.stop();
  const restarted = await startService(options); t.after(() => restarted.stop());
  await restarted.maintenance.firstRun;
  assert.deepEqual(calls, ['scan', 'sync', 'verify'], 'restarting does not rerun fresh maintenance or pay GPT again');
});
