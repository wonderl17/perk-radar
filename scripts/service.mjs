import { ROOT, isMain } from './lib.mjs';
import { createPreviewServer } from './serve.mjs';
import { loadScanConfig, runDueScan, startScanScheduler } from './scan.mjs';
import { loadMaintenanceConfig, startMaintenanceScheduler } from './maintenance.mjs';

/** The running project serves current reviewed data and checks the durable scan
 * schedule. Binding the HTTP port happens first, so a failed start never spends
 * model credits. Neither the model configuration nor credentials reach HTTP. */
export async function startService({ root = ROOT, config, maintenanceConfig, host = '127.0.0.1', port = 4173, ingestImpl, syncImpl, verifyImpl, onState, onMaintenanceState } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid service port');
  config ??= await loadScanConfig({ root });
  maintenanceConfig ??= await loadMaintenanceConfig({ root });
  let scheduler, maintenance, scanStatus;
  const server = createPreviewServer({ root,
    getScanStatus: () => scanStatus ?? scheduler?.getStatus() ?? { status: 'starting' },
    getMaintenanceStatus: () => maintenance?.getStatus() ?? { status: maintenanceConfig.enabled ? 'starting' : 'disabled' },
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); done(); });
  });
  try {
    if (maintenanceConfig.enabled) {
      maintenance = startMaintenanceScheduler({ root, config: maintenanceConfig, syncImpl, verifyImpl,
        scanImpl: options => runDueScan({ ...options, config, ingestImpl, onState: value => { scanStatus = value; onState?.(value); } }),
        onState: value => { if (value.scanState) scanStatus = value.scanState; onMaintenanceState?.(value); },
      });
      // Keep the original scan observer API while using a single project loop.
      scheduler = { firstRun: maintenance.firstRun, getStatus: () => maintenance.getScanStatus(), stop: () => maintenance.stop() };
    } else scheduler = startScanScheduler({ root, config, ingestImpl, onState });
  }
  catch (error) { await new Promise(done => server.close(done)); throw error; }
  let stopping;
  const stop = () => stopping ??= (async () => {
    const closed = new Promise(done => server.close(done));
    await scheduler.stop();
    await closed;
  })();
  return { server, scheduler, maintenance, stop, address: server.address() };
}
if (isMain(import.meta.url)) {
  try {
    const config = await loadScanConfig({ root: ROOT });
    const port = Number(process.env.PERK_HTTP_PORT || process.env.PORT || 4173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port');
    const host = process.env.PERK_HTTP_HOST || '127.0.0.1';
    let lastMaintenance;
    const runtime = await startService({ config, host, port, onMaintenanceState: state => {
      if (state.status === 'running') return;
      const signature = `${state.status}:${state.lastVerification?.status || ''}:${state.lastSync?.updated || false}`;
      if (signature === lastMaintenance) return;
      lastMaintenance = signature;
      console.log(`Project maintenance: ${state.status}. Next check: ${state.nextMaintenanceAt || 'pending'}. See npm run maintain:status.`);
    }, onState: state => {
      if (state.status === 'running') console.log('Scanning official sources with the Hermes GPT configuration…');
      else if (state.status === 'error') console.log('Scan failed; a bounded retry is scheduled. See npm run scan:status.');
      else if (state.status === 'degraded') console.log(`Some scan stages need attention. Next check: ${state.nextScanAt || 'pending'}`);
      else if (state.lastSuccessAt) console.log(`Scan ready. Next check: ${state.nextScanAt || 'pending'}`);
    } });
    console.log(`Local: http://${host}:${runtime.address.port}/`);
    console.log(`Periodic scans: every ${config.scanIntervalMinutes} minutes; up to ${config.maxItemsPerScan} items per scan.`);
    if (runtime.maintenance) console.log('Project maintenance owns GitHub sync and production verification; no Codex timer is needed.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      console.log('Stopping future scans; allowing the current scan to finish safely…');
      runtime.stop().then(() => process.exit(0)).catch(() => process.exit(1));
    });
  } catch { console.error('Unable to start the project service. Check the port and data/runtime.json.'); process.exitCode = 1; }
}
