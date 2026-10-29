import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT, decodeEntities, isMain, validateOffers } from './lib.mjs';
import { fetchPublicText } from './public-web.mjs';
import { runGhCli, validateRepository } from './sync-github.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const MAX_PAGE_BYTES = 4 * 1_048_576;
const SNAPSHOT_FILES = ['data/github.json', 'data/site.json', 'data/offers.json'];

function productionOrigin(siteUrl) {
  const url = new URL(siteUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.') || host.length > 253
    || /(?:^|\.)(?:localhost|local|internal|localdomain|home|lan)$/.test(host)
    || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new Error('Invalid origin');
  return url.origin;
}

function deploymentUrl(status) {
  // Status descriptions and error messages are never returned. Keep only a
  // credential-free public Vercel URL, without query strings or fragments.
  try {
    const url = new URL(status.target_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !(url.hostname === 'vercel.com' || /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname))
      || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname) || url.pathname.length > 400
      || /ghp_|github_pat_|sk-|token|secret/i.test(url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function vercelState(response, commit, repository) {
  if (!response || response.sha?.toLowerCase() !== commit || !Array.isArray(response.statuses)) throw new Error('Invalid status');
  const project = repository.split('/')[1].toLowerCase();
  const isVercel = context => typeof context === 'string' && ['vercel', `vercel – ${project}`, `vercel - ${project}`, `vercel (${project})`].includes(context.toLowerCase());
  const latest = new Map();
  for (const status of response.statuses) {
    if (!status || !isVercel(status.context)) continue;
    const key = status.context.toLowerCase();
    const previous = latest.get(key);
    // GitHub's combined status already contains the latest per context. The
    // ordering also protects adapters that return the status history instead.
    const time = Date.parse(status.updated_at ?? status.created_at) || 0;
    const previousTime = previous ? Date.parse(previous.updated_at ?? previous.created_at) || 0 : -1;
    if (!previous || time > previousTime || (time === previousTime && Number(status.id) > Number(previous.id))) latest.set(key, status);
  }
  const statuses = [...latest.values()];
  const normalized = statuses.map(status => String(status.state).toLowerCase());
  const state = normalized.some(value => ['error', 'failure'].includes(value)) ? 'failed'
    : statuses.length && normalized.every(value => value === 'success') ? 'success' : 'pending';
  const url = statuses.map(deploymentUrl).find(Boolean);
  return { state, ...(url ? { deploymentUrl: url } : {}) };
}

function validPage(result, origin) {
  if (result?.status !== 200 || typeof result.text !== 'string' || Buffer.byteLength(result.text) > MAX_PAGE_BYTES) return false;
  try { return new URL(result.url).origin === origin; } catch { return false; }
}

function homepageMatches(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const title = clean.match(/<title\b[^>]*>([^<]*)<\/title\s*>/i);
  return !!title && decodeEntities(title[1]).includes('福利雷达');
}

function rssMatches(xml, origin) {
  // Read only the direct rss/channel/link element. An item link (or a link
  // hidden inside a description) cannot satisfy the production-origin check.
  const stack = []; let roots = 0, channels = 0, links = 0, link = '', collecting = false;
  const tokens = xml.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== xml) return false;
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (!token.startsWith('<') || token.startsWith('<![CDATA[')) {
      const value = token.startsWith('<![CDATA[') ? token.slice(9, -3) : decodeEntities(token);
      if (collecting) link += value;
      else if (!stack.length && value.trim()) return false;
      continue;
    }
    const close = token.match(/^<\/([A-Za-z_][\w:.-]*)\s*>$/);
    if (close) {
      if (stack.pop() !== close[1]) return false;
      if (collecting && close[1] === 'link') collecting = false;
      continue;
    }
    const open = token.match(/^<([A-Za-z_][\w:.-]*)(?:\s[^<>]*)?\s*\/?>$/);
    if (!open || collecting) return false;
    const name = open[1];
    if (!stack.length && (name !== 'rss' || ++roots !== 1)) return false;
    if (stack.length === 1 && stack[0] === 'rss' && name === 'channel') channels++;
    if (stack.length === 2 && stack[0] === 'rss' && stack[1] === 'channel' && name === 'link') { links++; collecting = true; }
    if (!token.endsWith('/>')) stack.push(name);
    else if (collecting) collecting = false;
  }
  if (stack.length || roots !== 1 || channels !== 1 || links !== 1) return false;
  try {
    const url = new URL(link.trim());
    return url.origin === origin && url.href === `${origin}/`;
  } catch { return false; }
}

/** Read-only publication verification. Results contain fixed codes and bounded
 * public metadata; untrusted CLI output, response bodies and errors stay local. */
export async function verifySite({ root = ROOT, runGh = runGhCli, fetchPageImpl = fetchPublicText, nowFn = Date.now } = {}) {
  const checks = {};
  const result = (status, code, metadata = {}) => ({ status, ...metadata, checks: { ...checks }, ...(code ? { code } : {}) });
  let snapshot, config, document, origin;
  try {
    snapshot = await Promise.all(SNAPSHOT_FILES.map(path => readFile(resolve(root, path))));
    if (snapshot.some((bytes, index) => bytes.length > (index === 2 ? MAX_PAGE_BYTES : 16_384))) throw new Error('Oversize');
    config = validateRepository(JSON.parse(snapshot[0].toString('utf8')));
    if (typeof config.account !== 'string' || !config.account) throw new Error('Missing account');
    origin = productionOrigin(JSON.parse(snapshot[1].toString('utf8')).siteUrl);
    document = JSON.parse(snapshot[2].toString('utf8'));
    const now = new Date(nowFn()).getTime();
    if (!Number.isFinite(now) || validateOffers(document, { now }).length) throw new Error('Invalid data');
  } catch { return result('failed', 'LOCAL_DATA_INVALID'); }
  let login;
  try { login = String(await runGh(['api', '--hostname', 'github.com', 'user', '--jq', '.login'])).trim(); }
  catch { return result('failed', 'ACCOUNT_UNAVAILABLE'); }
  checks.githubAccount = login.toLowerCase() === config.account.toLowerCase();
  if (!checks.githubAccount) return result('failed', 'ACCOUNT_MISMATCH');

  const ref = `repos/${config.repository}/git/ref/heads/${encodeURIComponent(config.branch)}`;
  const readHead = async () => {
    const sha = String(await runGh(['api', '--hostname', 'github.com', ref, '--jq', '.object.sha'])).trim();
    if (!SHA.test(sha)) throw new Error('Invalid commit');
    return sha.toLowerCase();
  };
  let commit;
  try { commit = await readHead(); }
  catch { return result('failed', 'GITHUB_UNAVAILABLE'); }
  const metadata = { commit };
  let status = 'failed', code = 'GITHUB_UNAVAILABLE';
  try {
    const response = JSON.parse(await runGh(['api', '--hostname', 'github.com', `repos/${config.repository}/commits/${commit}/status?per_page=100`]));
    const deployment = vercelState(response, commit, config.repository);
    checks.vercel = deployment.state;
    if (deployment.deploymentUrl) metadata.deploymentUrl = deployment.deploymentUrl;
    status = deployment.state;
    code = status === 'pending' ? 'DEPLOYMENT_PENDING' : status === 'failed' ? 'DEPLOYMENT_FAILED' : undefined;
    if (status === 'success') {
      const paths = ['/', '/data/offers.json', '/feed.xml'];
      const pages = await Promise.allSettled(paths.map(path => Promise.resolve().then(() => fetchPageImpl(`${origin}${path}`, {
        allowedHosts: [new URL(origin).hostname], timeoutMs: 15000, maxBytes: MAX_PAGE_BYTES, preferIpv4: true,
      }))));
      const values = pages.map(page => page.status === 'fulfilled' && validPage(page.value, origin) ? page.value.text : undefined);
      checks.homepage = values[0] !== undefined && homepageMatches(values[0]);
      try { checks.offers = values[1] !== undefined && isDeepStrictEqual(JSON.parse(values[1]), document); }
      catch { checks.offers = false; }
      checks.rss = values[2] !== undefined && rssMatches(values[2], origin);
      if (!checks.homepage || !checks.offers || !checks.rss) {
        status = 'failed'; code = pages.some(page => page.status === 'rejected') ? 'SITE_UNAVAILABLE' : 'SITE_MISMATCH';
      }
    }
  } catch {
    status = 'failed';
    code = checks.vercel === 'success' ? 'SITE_UNAVAILABLE' : 'GITHUB_UNAVAILABLE';
  }

  // Recheck after all HTTP requests settle, even after a failed page check. A
  // moving production branch or local dataset means the observation is pending.
  const stability = await Promise.allSettled([
    Promise.all(SNAPSHOT_FILES.map(path => readFile(resolve(root, path)))), readHead(),
  ]);
  checks.localSnapshot = stability[0].status === 'fulfilled' && snapshot.every((bytes, index) => bytes.equals(stability[0].value[index]));
  checks.branchStable = stability[1].status === 'fulfilled' && stability[1].value === commit;
  if (!checks.localSnapshot) return result('pending', 'LOCAL_CHANGED', metadata);
  if (stability[1].status === 'fulfilled' && !checks.branchStable) return result('pending', 'BRANCH_CHANGED', metadata);
  if (stability[1].status === 'rejected') return result('failed', 'GITHUB_UNAVAILABLE', metadata);
  return result(status, code, metadata);
}

if (isMain(import.meta.url)) {
  const result = process.argv.length > 2 ? { status: 'failed', code: 'INVALID_ARGUMENTS' } : await verifySite();
  console.log(JSON.stringify(result));
  if (result.status === 'failed') process.exitCode = 1;
}
