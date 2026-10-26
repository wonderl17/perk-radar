import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { ROOT, BENEFIT_PATTERN, canonicalUrl, candidateId, decodeEntities, plainText, readJson, writeJson, withDataLock, isMain } from './lib.mjs';

export const DEFAULT_MAX_BYTES = 1_048_576;
export const MAX_SOURCE_BYTES = 4 * 1_048_576;
export function sourceMaxBytes(source = {}) {
  const value = source.maxBytes === undefined ? DEFAULT_MAX_BYTES : source.maxBytes;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SOURCE_BYTES) throw new Error('source.maxBytes must be an integer between 1 and 4194304 bytes (4 MiB)');
  return value;
}

export function assertSourceUrl(value, allowedHosts) {
  canonicalUrl(value); // Validate scheme and credentials without changing a server's slash-sensitive path.
  const url = new URL(value);
  url.hash = '';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) || host === 'localhost' || !host.includes('.') || host.endsWith('.local') || !allowedHosts.includes(host)) throw new Error('URL must belong to a declared public source host');
  return url.href;
}
export async function fetchText(url, { allowedHosts = [new URL(url).hostname], fetchImpl = fetch, timeoutMs = 12000, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  maxBytes = sourceMaxBytes({ maxBytes });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Source request timed out')), timeoutMs);
  try {
    let target = assertSourceUrl(url, allowedHosts);
    for (let redirect = 0; redirect < 6; redirect++) {
      const response = await fetchImpl(target, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'PerkRadar/0.1 (+official-source-monitor; no auto-publication)', Accept: 'text/html, application/rss+xml, application/atom+xml, application/xml, text/plain' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Redirect without location');
        target = assertSourceUrl(new URL(location, target).href, allowedHosts);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const type = response.headers.get('content-type') ?? '';
      if (type && !/(?:text\/|xml|json)/i.test(type)) { await response.body?.cancel(); throw new Error('Unsupported content type'); }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Source exceeds size limit'); }
      if (!response.body) return { text: '', url: target };
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); throw new Error('Source exceeds size limit'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const merged = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      return { text: new TextDecoder().decode(merged), url: target };
    }
    throw new Error('Too many redirects');
  } finally { clearTimeout(timer); }
}
function tag(body, name) { return body.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? ''; }
export function extractCandidates(source, body, fetchedUrl = source.url) {
  const allowedHosts = source.allowedHosts ?? [new URL(source.url).hostname];
  const results = new Map();
  function add(title, url, excerpt) {
    title = plainText(title).slice(0, 240);
    excerpt = plainText(excerpt).slice(0, 600);
    if (!BENEFIT_PATTERN.test(`${title} ${excerpt}`)) return;
    try {
      const normalized = canonicalUrl(assertSourceUrl(decodeEntities(url), allowedHosts), fetchedUrl);
      if (!results.has(normalized)) results.set(normalized, { id: candidateId(normalized), sourceId: source.id, sourceName: source.name, title: title || source.name, url: normalized, excerpt, region: source.region, status: 'pending', evidenceType: 'automated-keyword-match' });
    } catch { /* Ignore off-site or malformed links. They are not official evidence. */ }
  }
  if (source.kind === 'rss') {
    const entries = body.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
    for (const entry of entries.slice(0, 80)) {
      const atom = entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1];
      const link = plainText(tag(entry, 'link')) || atom;
      if (link) {
        try { add(tag(entry, 'title'), new URL(decodeEntities(link), fetchedUrl).href, tag(entry, 'description') || tag(entry, 'summary') || tag(entry, 'content')); }
        catch { /* One malformed feed link must not discard the other entries. */ }
      }
    }
  } else {
    const title = tag(body, 'title') || source.name;
    const excerpt = plainText(body).slice(0, 3000);
    add(title, fetchedUrl, excerpt);
    const cleanBody = body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    for (const match of cleanBody.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      if (results.size >= 40) break;
      if (!BENEFIT_PATTERN.test(plainText(match[2]))) continue;
      try { add(match[2], new URL(decodeEntities(match[1]), fetchedUrl).href, match[2]); } catch { /* malformed URL */ }
    }
  }
  return [...results.values()];
}
export function mergeCandidates(existing, incoming, publishedUrls = [], now = new Date().toISOString()) {
  const published = new Set(publishedUrls.map(value => canonicalUrl(value)));
  const map = new Map();
  for (const item of existing) map.set(canonicalUrl(item.url), item);
  for (const item of incoming) {
    const url = canonicalUrl(item.url);
    if (published.has(url)) continue;
    const previous = map.get(url);
    map.set(url, { ...previous, ...item, status: previous?.status ?? 'pending', firstDiscoveredAt: previous?.firstDiscoveredAt ?? now, lastSeenAt: now, ...(previous?.notes ? { notes: previous.notes } : {}) });
  }
  return [...map.values()].filter(item => !published.has(canonicalUrl(item.url))).sort((a, b) => b.firstDiscoveredAt.localeCompare(a.firstDiscoveredAt));
}
export function sourceContent(body) {
  // Ignore bundles, styles and markup churn; visible text is only a change signal, not semantic proof.
  const main = tag(body, 'main') || tag(body, 'body') || body;
  const text = plainText(main);
  return { contentHash: createHash('sha256').update(text).digest('hex'), contentCharacters: text.length, excerpt: text.slice(0, 600) };
}
export function observeSource(source, result, previous, offers, changes, now) {
  const sourceUrl = canonicalUrl(source.url);
  const contentUrl = canonicalUrl(result.url);
  const content = sourceContent(result.text);
  const hasBaseline = previous?.contentHash && previous.baselineSourceUrl === sourceUrl;
  const changed = Boolean(hasBaseline && previous.contentHash !== content.contentHash);
  if (changed) {
    const affectedOfferIds = offers.filter(offer => [sourceUrl, contentUrl].includes(canonicalUrl(offer.source.url))).map(offer => offer.id).sort();
    const pending = changes.find(item => item.sourceId === source.id && item.sourceUrl === sourceUrl && item.status === 'pending');
    if (pending) {
      pending.currentHash = content.contentHash;
      pending.lastDetectedAt = now;
      pending.lastObservedAt = now;
      pending.url = contentUrl;
      pending.excerpt = content.excerpt;
      pending.affectedOfferIds = [...new Set([...(pending.affectedOfferIds ?? []), ...affectedOfferIds])].sort();
    } else {
      changes.push({
        id: createHash('sha256').update(`${source.id}|${sourceUrl}|${now}|${previous.contentHash}|${content.contentHash}`).digest('hex').slice(0, 20),
        sourceId: source.id, sourceName: source.name, sourceUrl, url: contentUrl,
        kind: 'source-content-change', status: 'pending',
        firstDetectedAt: now, lastDetectedAt: now, lastObservedAt: now,
        previousHash: previous.contentHash, currentHash: content.contentHash, affectedOfferIds,
        excerpt: content.excerpt,
        note: 'Automated visible-text change signal; requires human review and does not confirm changed benefit terms.'
      });
    }
  } else {
    const pending = changes.find(item => item.sourceId === source.id && item.sourceUrl === sourceUrl && item.status === 'pending');
    if (pending) pending.lastObservedAt = now;
  }
  return {
    sourceId: source.id, sourceUrl, checkedAt: now, outcome: 'ok',
    contentHash: content.contentHash, contentCharacters: content.contentCharacters,
    contentUrl, baselineSourceUrl: sourceUrl, lastSuccessAt: now, consecutiveFailures: 0,
    contentChanged: changed, baselineInitialized: !hasBaseline
  };
}
export async function collect({ root = ROOT, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  const sources = await readJson(resolve(root, 'data/sources.json'));
  if (!Array.isArray(sources) || sources.length > 100) throw new Error('Expected at most 100 configured sources');
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Source IDs must be unique');
  const existing = await readJson(resolve(root, 'work/candidates.json'), { candidates: [] });
  const previousHealth = await readJson(resolve(root, 'work/health.json'), { sources: [] });
  const previousChanges = await readJson(resolve(root, 'work/changes.json'), { changes: [] });
  const offers = await readJson(resolve(root, 'data/offers.json'), { offers: [] });
  const previousById = new Map(previousHealth.sources.map(source => [source.sourceId, source]));
  const changes = previousChanges.changes;
  const health = [], incoming = []; let cursor = 0;
  async function worker() {
    while (cursor < sources.length) {
      const source = sources[cursor++];
      const previous = previousById.get(source.id);
      try {
        if (!source.id || !source.name || !['page', 'rss'].includes(source.kind) || !['cn', 'global'].includes(source.region)) throw new Error('Invalid source configuration');
        const result = await fetchText(source.url, { allowedHosts: source.allowedHosts ?? [new URL(source.url).hostname], maxBytes: sourceMaxBytes(source), fetchImpl });
        const candidates = extractCandidates(source, result.text, result.url);
        incoming.push(...candidates);
        const observation = observeSource(source, result, previous, offers.offers, changes, now);
        health.push({ ...observation, candidateCount: candidates.length });
      } catch (error) {
        const { message: _oldMessage, candidateCount: _oldCount, ...baseline } = previous ?? {};
        health.push({
          ...baseline, sourceId: source.id ?? 'invalid', checkedAt: now, outcome: 'error',
          contentHash: previous?.contentHash ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null,
          consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
          contentChanged: false, baselineInitialized: false,
          message: error.name === 'AbortError' ? 'Source request timed out' : error.message
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, worker));
  return withDataLock(root, async () => {
    const latestQueue = await readJson(resolve(root, 'work/candidates.json'), { candidates: [] });
    const latestOffers = await readJson(resolve(root, 'data/offers.json'), { offers: [] });
    const latestChanges = await readJson(resolve(root, 'work/changes.json'), { changes: [] });
    const candidates = mergeCandidates(latestQueue.candidates ?? [], incoming, latestOffers.offers.map(offer => offer.source.url), now);
    const mergedChanges = new Map(latestChanges.changes.map(item => [item.id, item]));
    for (const item of changes) {
      const latest = mergedChanges.get(item.id);
      // A completed GPT/editor review wins over the older pre-fetch snapshot.
      if (!latest || (latest.status === 'pending' && item.lastDetectedAt >= latest.lastDetectedAt)) mergedChanges.set(item.id, item);
    }
    const finalChanges = [...mergedChanges.values()].sort((a, b) => b.firstDetectedAt.localeCompare(a.firstDetectedAt));
    await writeJson(resolve(root, 'work/candidates.json'), { schemaVersion: 1, updatedAt: now, candidates });
    await writeJson(resolve(root, 'work/changes.json'), { schemaVersion: 1, updatedAt: now, changes: finalChanges });
    await writeJson(resolve(root, 'work/health.json'), { checkedAt: now, sources: health.sort((a, b) => a.sourceId.localeCompare(b.sourceId)) });
    return { sources: sources.length, candidates: candidates.length, changes: finalChanges.filter(item => item.status === 'pending').length, failures: health.filter(h => h.outcome === 'error').length };
  });
}
if (isMain(import.meta.url)) {
  try { const result = await collect(); console.log(`Collected ${result.sources} sources, ${result.candidates} pending candidates, ${result.changes} pending content-change reviews, ${result.failures} source errors. See work/health.json and work/changes.json. Published offers were not changed.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
