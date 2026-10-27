import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const PUBLIC_ERROR = 'Public source request failed.';
const TIMEOUT_ERROR = 'Public source request timed out.';
const MAX_BYTES = 4 * 1_048_576;
const CONTENT_TYPE = /^(?:text\/(?:html|plain|xml)|application\/(?:xhtml\+xml|(?:[a-z0-9.+-]+\+)?xml|(?:[a-z0-9.+-]+\+)?json))(?:\s*;|$)/i;
function sourcePolicyError(message) { return Object.assign(new Error(message), { code: 'SOURCE_POLICY' }); }

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => value * 256 + part, 0);
}
function inV4Range(value, start, bits) {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(ipv4Number(start) / size);
}
function publicV4(address) {
  const value = ipv4Number(address);
  if (value === null) return false;
  return ![
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ].some(([start, bits]) => inV4Range(value, start, bits));
}
function publicV6(address) {
  // Only ordinary global unicast is eligible. This also excludes loopback,
  // link-local, unique-local, IPv4-mapped and NAT64/translation addresses.
  const first = address.split('::')[0].split(':');
  const high = parseInt(first[0], 16);
  const next = parseInt(first[1] || '0', 16);
  if (!(high >= 0x2000 && high <= 0x3fff)) return false;
  if (high === 0x2001 && (next < 0x0200 || next === 0x0db8)) return false;
  if (high === 0x2002 || high === 0x3ffe || high === 0x3fff) return false;
  return true;
}
function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? publicV4(address) : family === 6 ? publicV6(address) : false;
}
function checkedUrl(value, allowedHosts) {
  let url;
  try { url = new URL(value); } catch { throw sourcePolicyError('Public source URL is not allowed.'); }
  const host = url.hostname.toLowerCase();
  const bareHost = host.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(bareHost)
    || !host.includes('.') || host.length > 253 || host.endsWith('.')
    || /(?:^|\.)(?:localhost|local|internal|localdomain|home|lan)$/.test(host)
    || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
    || !allowedHosts.includes(host)) throw sourcePolicyError('Public source URL is not allowed.');
  url.hash = '';
  return url;
}
function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error(TIMEOUT_ERROR));
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error(TIMEOUT_ERROR)); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) reject(new Error(TIMEOUT_ERROR)); else resolve(value);
    }, () => {
      signal.removeEventListener('abort', aborted);
      reject(new Error(signal.aborted ? TIMEOUT_ERROR : 'Public source DNS could not be verified.'));
    });
  });
}
async function resolvedAddresses(host, lookupImpl, signal) {
  let answers;
  try { answers = await untilAbort(lookupImpl(host, { all: true, verbatim: true }), signal); }
  catch { throw new Error(signal.aborted ? TIMEOUT_ERROR : 'Public source DNS could not be verified.'); }
  if (!Array.isArray(answers) || !answers.length || answers.length > 64
    || answers.some(answer => !answer || !publicAddress(answer.address) || isIP(answer.address) !== answer.family)) {
    throw sourcePolicyError('Public source DNS is not globally routable.');
  }
  return answers.map(({ address, family }) => ({ address, family }));
}
function requestText(url, addresses, { requestImpl, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    let req, res, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      if (error) reject(new Error(error)); else resolve(value);
    };
    const stop = message => {
      finish(message);
      res?.destroy(); req?.destroy();
    };
    const aborted = () => stop(TIMEOUT_ERROR);
    if (signal.aborted) { reject(new Error(TIMEOUT_ERROR)); return; }
    signal.addEventListener('abort', aborted, { once: true });
    try {
      req = requestImpl(url, {
        method: 'GET', agent: false, signal, servername: url.hostname,
        // The connection receives only the addresses already verified above;
        // it cannot perform a second DNS lookup after the safety check.
        lookup(_hostname, options, callback) {
          const result = options?.all ? addresses.map(item => ({ ...item })) : addresses[0].address;
          queueMicrotask(() => options?.all ? callback(null, result) : callback(null, result, addresses[0].family));
        },
        headers: {
          'User-Agent': 'PerkRadar/0.1 (+public-official-source-discovery)',
          Accept: 'text/html, text/plain, application/rss+xml, application/atom+xml, application/xml, application/json',
          'Accept-Encoding': 'identity',
        },
      }, response => {
        res = response;
        if (settled || signal.aborted) { stop(TIMEOUT_ERROR); return; }
        response.on('error', () => stop(PUBLIC_ERROR));
        response.on('aborted', () => stop(PUBLIC_ERROR));
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          if (typeof location !== 'string' || !location) { stop(PUBLIC_ERROR); return; }
          finish(null, { redirect: location });
          response.destroy(); req?.destroy(); return;
        }
        if (!Number.isInteger(status) || status < 200 || status >= 300) { stop(PUBLIC_ERROR); return; }
        const type = response.headers['content-type'];
        const encoding = response.headers['content-encoding'];
        const length = response.headers['content-length'];
        if (typeof type !== 'string' || !CONTENT_TYPE.test(type)
          || (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity')
          || (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes))) {
          stop('Public source response is unsupported or too large.'); return;
        }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += value.length;
          if (bytes > maxBytes) { stop('Public source response is too large.'); return; }
          chunks.push(value);
        });
        response.on('end', () => finish(null, { text: Buffer.concat(chunks, bytes).toString('utf8'), url: url.href }));
      });
      req.on('error', () => stop(signal.aborted ? TIMEOUT_ERROR : PUBLIC_ERROR));
      if (signal.aborted) aborted(); else req.end();
    } catch { stop(signal.aborted ? TIMEOUT_ERROR : PUBLIC_ERROR); }
  });
}

/** Fetch public evidence without sending runtime credentials, cookies or proxy
 * settings. Untrusted URLs and every redirect must pass URL and pinned DNS checks. */
export async function fetchPublicText(value, {
  allowedHosts, timeoutMs = 12000, maxBytes = 1_048_576, lookupImpl = dnsLookup, requestImpl = httpsRequest,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
    || typeof lookupImpl !== 'function' || typeof requestImpl !== 'function') throw new Error('Public source request limits are invalid.');
  if (allowedHosts === undefined) {
    try { allowedHosts = [new URL(value).hostname.toLowerCase()]; } catch { throw new Error('Public source URL is not allowed.'); }
  }
  if (!Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.length > 20 || allowedHosts.some(host => typeof host !== 'string')) throw new Error('Public source host policy is invalid.');
  allowedHosts = allowedHosts.map(host => host.toLowerCase());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = checkedUrl(value, allowedHosts);
    for (let redirects = 0; redirects < 6; redirects++) {
      const addresses = await resolvedAddresses(target.hostname, lookupImpl, controller.signal);
      if (controller.signal.aborted) throw new Error(TIMEOUT_ERROR);
      const result = await requestText(target, addresses, { requestImpl, maxBytes, signal: controller.signal });
      if (!result.redirect) return result;
      try { target = checkedUrl(new URL(result.redirect, target).href, allowedHosts); }
      catch { throw sourcePolicyError('Public source redirect is not allowed.'); }
    }
    throw new Error('Public source redirect limit exceeded.');
  } finally { clearTimeout(timer); }
}
