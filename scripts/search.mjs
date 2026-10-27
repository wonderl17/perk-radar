import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from './lib.mjs';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 45000;
const ENV_KEYS = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];

function searchEnvironment(env) {
  const childEnv = Object.fromEntries(ENV_KEYS.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
  return { ...childEnv, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
}

function runSearchBridge({ query, limit, python, scriptPath, timeoutMs, env }) {
  return new Promise((done, reject) => {
    const child = execFile(python, [scriptPath], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env, windowsHide: true }, (error, stdout) => {
      if (error) { reject(new Error('Web search bridge failed.')); return; }
      done(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ query, limit }));
  });
}

function normalizeResults(raw, limit) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || data.provider !== 'ddgs' || !Array.isArray(data.results) || data.error) throw new Error('Invalid search response');
  const results = [], seen = new Set();
  for (const hit of data.results.slice(0, 100)) {
    if (!hit || typeof hit !== 'object' || typeof hit.url !== 'string' || hit.url.length > 4096) continue;
    let url;
    try {
      url = new URL(hit.url);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) continue;
      url.hash = '';
    } catch { continue; }
    if (seen.has(url.href)) continue;
    const title = typeof hit.title === 'string' ? hit.title.trim().slice(0, 240) : '';
    if (!title) continue;
    seen.add(url.href);
    results.push({ title, url: url.href, description: typeof hit.description === 'string' ? hit.description.trim().slice(0, 1200) : '' });
    if (results.length >= limit) break;
  }
  return { provider: 'ddgs', results };
}

/** Search returns untrusted leads, never admission or publication approval.
 * PERK_SEARCH_PYTHON may select a Python runtime with requirements-search.txt;
 * the default isolated runtime is work/search-venv/bin/python (Scripts on Windows).
 * Model/provider credentials are deliberately absent from the child environment.
 */
export async function searchWeb({ query, limit = 5, env = process.env, bridgeImpl = runSearchBridge, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 240 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('Search query must contain 1–240 characters without control characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Search limit must be an integer from 1 to 8.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('Search timeout must be between 1 and 45000 milliseconds.');
  const python = env.PERK_SEARCH_PYTHON || resolve(ROOT, 'work/search-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (typeof python !== 'string' || !python.trim() || /[\u0000\r\n]/.test(python)) throw new Error('Invalid search Python runtime.');
  let timer;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => bridgeImpl({ query: query.trim(), limit, python, scriptPath: resolve(ROOT, 'scripts/web-search.py'), timeoutMs, env: searchEnvironment(env) })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    if (typeof raw === 'string' && Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) throw new Error('oversized response');
    return normalizeResults(raw, limit);
  } catch {
    // Do not forward child stdout/stderr or provider exception messages: request
    // URLs and runtime environment values can otherwise leak into reports.
    throw new Error('Web search unavailable. Check the isolated Python runtime, requirements-search.txt, and network access.');
  } finally { clearTimeout(timer); }
}
