import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BENEFIT_PATTERN = /\b(?:free|credits?|grant|giveaway|trial|discount|student|scholarship)\b|免费|赠送|积分|额度|福利|优惠|限免|学生|奖学金|试用/iu;
const TRACKING = /^(?:utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref_src)$/i;
export function canonicalUrl(value, base) {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) URLs are allowed');
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) if (TRACKING.test(name)) url.searchParams.delete(name);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}
export function candidateId(url) { return createHash('sha256').update(canonicalUrl(url)).digest('hex').slice(0, 20); }
export function isMain(metaUrl) { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl); }
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}
export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}
export function decodeEntities(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity) => {
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity.startsWith('#')) {
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : full;
    }
    return map[entity.toLowerCase()] ?? full;
  });
}
export function plainText(html) {
  return decodeEntities(html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
export function validateOffers(document, { now = Date.now() } = {}) {
  const errors = [];
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.offers)) return ['Expected schemaVersion 1 and offers array'];
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!date(document.updatedAt)) errors.push('updatedAt must be an ISO date with timezone');
  const ids = new Set(), urls = new Set();
  for (const [index, offer] of document.offers.entries()) {
    const label = `offers[${index}] (${offer?.id ?? '?'})`;
    const fail = text => errors.push(`${label}: ${text}`);
    if (!offer || typeof offer !== 'object') { fail('must be an object'); continue; }
    if (typeof offer.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(offer.id)) fail('id must be a lowercase slug');
    if (ids.has(offer.id)) fail('duplicate id'); ids.add(offer.id);
    for (const key of ['title', 'provider', 'summary', 'benefit', 'availability']) if (typeof offer[key] !== 'string' || !offer[key].trim()) fail(`${key} is required`);
    if (!['ai', 'developer', 'learning', 'life'].includes(offer.category)) fail('invalid category');
    if (!Array.isArray(offer.regions) || !offer.regions.length || offer.regions.some(r => !['cn', 'global'].includes(r))) fail('regions must include cn or global');
    for (const key of ['eligibility', 'steps', 'caveats', 'tags']) {
      if (!Array.isArray(offer[key]) || offer[key].some(x => typeof x !== 'string' || !x.trim()) || (key !== 'tags' && !offer[key].length)) fail(`${key} must contain nonempty strings`);
    }
    for (const key of ['discoveredAt', 'verifiedAt']) if (!date(offer[key])) fail(`${key} must be an ISO date with timezone`);
    for (const key of ['publishedAt', 'expiresAt']) if (offer[key] !== null && !date(offer[key])) fail(`${key} must be ISO date or null`);
    if (date(offer.verifiedAt) && Date.parse(offer.verifiedAt) > now + 300_000) fail('verifiedAt cannot be in the future');
    if (date(offer.discoveredAt) && Date.parse(offer.discoveredAt) > now + 300_000) fail('discoveredAt cannot be in the future');
    if (!['ongoing', 'limited'].includes(offer.offerType)) fail('invalid offerType');
    if (!['published', 'withdrawn'].includes(offer.status)) fail('invalid status');
    if (offer.featured !== undefined && typeof offer.featured !== 'boolean') fail('featured must be boolean');
    if (offer.verification !== undefined) {
      const proof = offer.verification;
      if (!proof || proof.method !== 'gpt' || typeof proof.model !== 'string' || !proof.model.trim()) fail('verification must identify the GPT method and model');
      if (!date(proof?.verifiedAt) || proof.verifiedAt !== offer.verifiedAt) fail('verification time must match verifiedAt');
      if (typeof proof?.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.evidenceHash)) fail('verification evidenceHash must be SHA-256');
      if (!Array.isArray(proof?.evidenceQuotes) || !proof.evidenceQuotes.length || proof.evidenceQuotes.length > 10 || proof.evidenceQuotes.some(item => typeof item?.field !== 'string' || !item.field.trim() || typeof item?.quote !== 'string' || !item.quote.trim() || item.quote.length > 260)) fail('verification needs bounded field evidence quotes');
    }

    if (!offer.source || typeof offer.source.name !== 'string' || !offer.source.name.trim() || typeof offer.source.evidence !== 'string' || !offer.source.evidence.trim()) fail('official source name and evidence required');
    try {
      const url = canonicalUrl(offer.source?.url);
      if (!url.startsWith('https://')) fail('source URL must use HTTPS');
      if (urls.has(url)) fail('duplicate source URL'); urls.add(url);
    } catch { fail('invalid source URL'); }
  }
  return errors;
}

// Serialize only short local read/modify/write sections; never hold during HTTP/model calls.
export async function withDataLock(root, action) {
  const path = resolve(root, 'work/data-write.lock');
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 10000;
  let handle;
  while (!handle) {
    try { handle = await open(path, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readJson(path, {});
      if (Number.isInteger(previous.pid)) {
        try { process.kill(previous.pid, 0); }
        catch (e) { if (e.code === 'ESRCH') { await unlink(path).catch(() => {}); continue; } }
      }
      if (Date.now() > deadline) throw new Error('Another data writer is active; no changes were overwritten.');
      await new Promise(done => setTimeout(done, 30));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await unlink(path).catch(() => {}); }
}
