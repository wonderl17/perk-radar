import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, isMain, validateOffers } from './lib.mjs';

const MAX_OUTPUT = 256 * 1024;
const MAX_DATA = 8 * 1024 * 1024;
const CLI_ERROR = 'GitHub request failed; no automatic retry or force update was attempted.';
const SHA = /^[a-f0-9]{40}$/i;
const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Let gh use its existing authenticated session. No token is read, printed or
 * placed in command arguments; the public file body is sent over stdin. */
function runGhCli(args, input) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', outputBytes = 0, settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        killTimer.unref();
        child.once('close', () => clearTimeout(killTimer));
        reject(error);
      } else resolveOutput(output);
    };
    const safeError = () => {
      const error = new Error(CLI_ERROR);
      // Keep only the numeric conflict status, never reflect CLI/API contents.
      if (/HTTP\s+409\b|"status"\s*:\s*"?409\b/.test(stderr + stdout)) error.statusCode = 409;
      return error;
    };
    const timer = setTimeout(() => finish(new Error('GitHub request timed out; inspect the repository before retrying.')), 30000);
    const collect = (chunk, stream) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) { finish(new Error('GitHub response exceeded the safe output limit.')); return; }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    child.once('error', () => finish(new Error('GitHub CLI is unavailable; install gh and authenticate first.')));
    child.once('close', code => code === 0 ? finish(null, stdout) : finish(safeError()));
    child.stdin.on('error', () => {}); // A failed gh command can close stdin early.
    child.stdin.end(input ?? '');
  });
}

function validBranch(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== '@' && !value.startsWith('-') && !value.startsWith('refs/')
    && !value.includes('..') && !value.includes('@{')
    && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value)
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}
function validateRepository(config) {
  const owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?';
  const repository = new RegExp(`^${owner}/[A-Za-z0-9._-]{1,100}$`);
  if (!config || typeof config.repository !== 'string' || !repository.test(config.repository) || ['.', '..'].includes(config.repository.split('/')[1]) || !validBranch(config.branch) || (config.account !== undefined && (typeof config.account !== 'string' || !USERNAME.test(config.account)))) {
    throw new Error('Configure a valid GitHub owner/repository and branch in data/github.json.');
  }
  return config;
}
function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Sync only reviewed offers, preserving the public repository's other files
 * and history. A SHA mismatch at PUT fails rather than overwriting a newer edit. */
export async function syncGithub({ root = ROOT, runGh = runGhCli } = {}) {
  let bytes, document;
  try {
    bytes = await readFile(resolve(root, 'data/offers.json'));
    if (bytes.length > MAX_DATA) throw new Error('oversize');
    document = JSON.parse(bytes.toString('utf8'));
  } catch { throw new Error('Reviewed benefits data is unreadable or exceeds the safe file size.'); }
  if (validateOffers(document).length) throw new Error('Reviewed benefits data failed validation; GitHub was not changed.');
  let config;
  try { config = JSON.parse(await readFile(resolve(root, 'data/github.json'), 'utf8')); }
  catch { throw new Error('GitHub repository configuration is unavailable.'); }
  config = validateRepository(config);
  const repo = config.repository;
  if (config.account !== undefined) {
    let login;
    try { login = String(await runGh(['api', '--hostname', 'github.com', 'user', '--jq', '.login'])).trim(); }
    catch { throw new Error('Unable to verify the active GitHub account; GitHub was not changed.'); }
    if (!USERNAME.test(login) || login.toLowerCase() !== config.account.toLowerCase()) {
      throw new Error('The active GitHub account does not match data/github.json; switch gh to the configured account before syncing.');
    }
  }
  const endpoint = `repos/${repo}/contents/data/offers.json`;
  let remoteSha;
  try { remoteSha = String(await runGh(['api', '--hostname', 'github.com', `${endpoint}?ref=${encodeURIComponent(config.branch)}`, '--jq', '.sha'])).trim(); }
  catch { throw new Error('Unable to read the existing public benefits file; check repository access and branch.'); }
  if (!SHA.test(remoteSha)) throw new Error('GitHub returned an invalid file revision; no update was sent.');
  if (blobSha(bytes) === remoteSha.toLowerCase()) return { repo, updated: false, commitUrl: null };
  const identity = { name: 'Perk Radar', email: `${config.account || repo.split('/')[0]}@users.noreply.github.com` };
  const payload = {
    message: `Update reviewed benefits at ${document.updatedAt}`,
    content: bytes.toString('base64'), sha: remoteSha, branch: config.branch,
    author: identity, committer: identity,
  };
  let response;
  try {
    response = await runGh(['api', '--hostname', 'github.com', '--method', 'PUT', endpoint, '--input', '-'], JSON.stringify(payload));
  } catch (error) {
    if (Number(error?.statusCode ?? error?.status) === 409) throw new Error('The public benefits file changed concurrently; the newer revision was not overwritten.');
    throw new Error(CLI_ERROR);
  }
  let commit;
  try { commit = JSON.parse(response).commit; } catch { /* Handled below without reflecting response data. */ }
  if (!SHA.test(commit?.sha) || commit.html_url !== `https://github.com/${repo}/commit/${commit.sha}`) {
    throw new Error('GitHub update could not be verified; inspect the repository before retrying.');
  }
  return { repo, updated: true, commitUrl: commit.html_url };
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: node scripts/sync-github.mjs');
    console.log(JSON.stringify(await syncGithub()));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
