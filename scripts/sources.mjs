import { isIP } from 'node:net';
import { canonicalUrl } from './lib.mjs';

const SOURCE_FIELDS = new Set(['id', 'name', 'url', 'kind', 'region', 'maxBytes', 'allowedHosts', 'discovery']);
const DISCOVERY_FIELDS = ['method', 'model', 'discoveredAt', 'query', 'homepageUrl', 'searchUrl', 'evidenceHash', 'homepageHash', 'identityQuote', 'benefitQuote'];
const PRIVATE_MARKER = /(?:\/Users\/|\/home\/|[a-z]:\\Users\\|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{24,}\b)/i;
const boundedText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) && !PRIVATE_MARKER.test(value);
function publicHost(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value) || value.endsWith('.')) return false;
  const host = value.toLowerCase();
  return !isIP(host) && host.includes('.') && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    && !/(?:^|\.)(?:localhost|local|localdomain|internal|home|lan|test|invalid|example|onion)$/.test(host);
}
function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value) || PRIVATE_MARKER.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && publicHost(url.hostname)
      && [...url.searchParams.keys()].every(key => !/^(?:api[-_]?key|token|access[-_]?token|password|secret|credential)$/i.test(key));
  } catch { return false; }
}
/** Source metadata is public configuration, never a place for raw search output,
 * pending candidates or arbitrary model fields. DNS/connection safety is checked
 * by the collector; this validates only what may enter public Git history. */
export function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length > 500) return false;
  const ids = new Set(), urls = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !SOURCE_FIELDS.has(key))) return false;
    if (typeof source.id !== 'string' || source.id.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.id) || ids.has(source.id)) return false;
    if (!boundedText(source.name, 180) || !publicUrl(source.url) || !['page', 'rss'].includes(source.kind) || !['cn', 'global'].includes(source.region)) return false;
    const url = canonicalUrl(source.url);
    if (urls.has(url)) return false;
    ids.add(source.id); urls.add(url);
    if (source.maxBytes !== undefined && (!Number.isInteger(source.maxBytes) || source.maxBytes < 1 || source.maxBytes > 4 * 1048576)) return false;
    if (source.allowedHosts !== undefined && (!Array.isArray(source.allowedHosts) || !source.allowedHosts.length || source.allowedHosts.length > 8 || source.allowedHosts.some(host => !publicHost(host)) || !source.allowedHosts.map(host => host.toLowerCase()).includes(new URL(source.url).hostname))) return false;
    if (source.discovery !== undefined) {
      const proof = source.discovery;
      if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== DISCOVERY_FIELDS.length || DISCOVERY_FIELDS.some(key => !Object.hasOwn(proof, key))) return false;
      if (proof.method !== 'gpt-web-search' || !boundedText(proof.model, 160) || !/^[a-z0-9_./:-]+$/i.test(proof.model) || !boundedText(proof.query, 240)) return false;
      if (typeof proof.discoveredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(proof.discoveredAt) || !Number.isFinite(Date.parse(proof.discoveredAt))) return false;
      if (!publicUrl(proof.homepageUrl) || !publicUrl(proof.searchUrl) || !/^[a-f0-9]{64}$/.test(proof.evidenceHash) || !/^[a-f0-9]{64}$/.test(proof.homepageHash)) return false;
      if (!boundedText(proof.identityQuote, 500) || !boundedText(proof.benefitQuote, 500)) return false;
    }
  }
  return true;
}
