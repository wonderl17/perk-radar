import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalUrl, validateOffers } from '../scripts/lib.mjs';
import { fetchText, extractCandidates, mergeCandidates, collect, sourceContent, sourceMaxBytes, DEFAULT_MAX_BYTES, MAX_SOURCE_BYTES } from '../scripts/collect.mjs';
import { mergeReviewedOffer } from '../scripts/review.mjs';
import { createFeed, build } from '../scripts/build.mjs';
import { resolvePublicPath } from '../scripts/serve.mjs';

const NOW = '2026-10-26T08:00:00.000Z';
function offer(overrides = {}) {
  return { id: 'official-free-plan', title: '官方免费计划', provider: 'Example', summary: '可以申请基础免费权益。', benefit: '免费基础额度', category: 'ai', regions: ['global'], availability: '限官方支持的地区', eligibility: ['注册账号'], steps: ['查看官方页面'], caveats: ['额度及限制以官方为准'], tags: ['免费'], publishedAt: null, discoveredAt: '2026-10-25T08:00:00.000Z', verifiedAt: NOW, expiresAt: null, offerType: 'ongoing', source: { name: 'Example 官方', url: 'https://example.com/free', evidence: '官方页面列出免费基础套餐。' }, status: 'published', ...overrides };
}
function document(offers = [offer()]) { return { schemaVersion: 1, updatedAt: NOW, offers }; }
const options = { now: Date.parse(NOW) };

test('canonical URL removes only known tracking parameters, preserving business parameters', () => {
  assert.equal(canonicalUrl('https://EXAMPLE.com/free/?utm_source=x&id=42&code=gift&ref=partner#top'), 'https://example.com/free?code=gift&id=42&ref=partner');
  assert.throws(() => canonicalUrl('javascript:alert(1)'));
  assert.throws(() => canonicalUrl('https://user:secret@example.com/free'));
});

test('candidate merge deduplicates tracking variants and preserves original discovery/status', () => {
  const existing = [{ url: 'https://example.com/free', title: 'old', firstDiscoveredAt: '2026-10-20T00:00:00Z', status: 'rejected', notes: 'not a benefit' }];
  const incoming = [{ url: 'https://example.com/free?utm_source=test', title: 'new', status: 'pending' }, { url: 'https://example.com/claimed', title: 'published' }];
  const result = mergeCandidates(existing, incoming, ['https://example.com/claimed'], NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].firstDiscoveredAt, existing[0].firstDiscoveredAt);
  assert.equal(result[0].lastSeenAt, NOW);
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].notes, 'not a benefit');
});

test('page/RSS extraction accepts benefit clues only from declared official hosts', () => {
  const source = { id: 'example', name: 'Example official', url: 'https://example.com/news', kind: 'page', region: 'global' };
  const page = '<title>News</title><script>free malicious text</script><a href="/free?utm_source=x">Free credits</a><a href="https://spam.test/free">Free gift</a><a href="/about">About</a>';
  const candidates = extractCandidates(source, page);
  assert(candidates.some(item => item.url === 'https://example.com/free'));
  assert(candidates.every(item => new URL(item.url).hostname === 'example.com'));
  assert(!candidates.some(item => item.url.endsWith('/about')));
  const rss = extractCandidates({ ...source, kind: 'rss' }, '<rss><channel><item><title>Free malformed link</title><link>http://[</link></item><item><title><![CDATA[学生免费额度]]></title><link>https://example.com/student</link><description>Apply today</description></item></channel></rss>');
  assert.equal(rss[0].url, 'https://example.com/student');
  assert.equal(rss[0].title, '学生免费额度');
});

test('bounded fetching rejects oversize payloads, failed HTTP and cross-host redirects', async () => {
  await assert.rejects(fetchText('https://example.com/free', { maxBytes: 3, fetchImpl: async () => new Response('large', { headers: { 'content-type': 'text/html' } }) }), /size limit/);
  await assert.rejects(fetchText('https://example.com/free', { fetchImpl: async () => new Response('no', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchText('https://example.com/free', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), /declared public source host/);
  await assert.rejects(fetchText('https://example.com/free', { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://unknown.test/free' } }) }), /declared public source host/);
});

test('fetching preserves slash-sensitive official URLs while deduplication can canonicalize them', async () => {
  const visited = [];
  const result = await fetchText('https://example.com/training/', { fetchImpl: async url => {
    visited.push(url);
    return url.endsWith('/') ? new Response('Free training', { headers: { 'content-type': 'text/html' } }) : new Response(null, { status: 301, headers: { location: '/training/' } });
  } });
  assert.equal(result.text, 'Free training');
  assert.deepEqual(visited, ['https://example.com/training/']);
});

test('schema requires explicit evidence, dates and unique canonical official URLs', () => {
  assert.deepEqual(validateOffers(document(), options), []);
  const bad = offer({ verifiedAt: '2027-01-01T00:00:00Z', source: { ...offer().source, evidence: '' } });
  assert(validateOffers(document([bad]), options).some(error => error.includes('evidence')));
  assert(validateOffers(document([bad]), options).some(error => error.includes('future')));
  assert(validateOffers(document([offer(), offer({ id: 'same-url', source: { ...offer().source, url: 'https://example.com/free?utm_source=test' } })]), options).some(error => error.includes('duplicate source URL')));
});

test('review rejects accidental overwrite and preserves original discovery on explicit correction', () => {
  assert.throws(() => mergeReviewedOffer(document(), offer(), { now: NOW }), /already exists/);
  assert.throws(() => mergeReviewedOffer(document(), offer({ id: 'duplicate' }), { now: NOW }), /Source URL already belongs/);
  const updated = mergeReviewedOffer(document(), offer({ discoveredAt: NOW, title: '官方更正' }), { replace: true, now: NOW });
  assert.equal(updated.offers[0].discoveredAt, '2026-10-25T08:00:00.000Z');
  assert.equal(updated.offers[0].title, '官方更正');
});

test('collection failure never changes published verification or discards old candidates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-radar-collect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data')); await mkdir(join(root, 'work'));
  await writeFile(join(root, 'data/sources.json'), JSON.stringify([{ id: 'failed', name: 'Example', url: 'https://example.com/news', kind: 'page', region: 'global' }]));
  const original = JSON.stringify(document());
  await writeFile(join(root, 'data/offers.json'), original);
  await writeFile(join(root, 'work/candidates.json'), JSON.stringify({ candidates: [{ url: 'https://example.com/old', firstDiscoveredAt: '2026-10-20T00:00:00Z', status: 'pending' }] }));
  const result = await collect({ root, now: NOW, fetchImpl: async () => { throw new Error('network unavailable'); } });
  assert.equal(result.failures, 1);
  assert.equal(result.candidates, 1);
  assert.equal(await readFile(join(root, 'data/offers.json'), 'utf8'), original);
  const health = JSON.parse(await readFile(join(root, 'work/health.json'), 'utf8'));
  assert.equal(health.sources[0].outcome, 'error');
});

test('RSS excludes expired/withdrawn offers and escapes source text', () => {
  const feed = createFeed(document([offer({ title: 'Free <credits> & gifts' }), offer({ id: 'expired', expiresAt: NOW }), offer({ id: 'withdrawn', status: 'withdrawn' })]), 'https://perks.example', Date.parse(NOW));
  assert.equal((feed.match(/<item>/g) ?? []).length, 1);
  assert(feed.includes('Free &lt;credits&gt; &amp; gifts'));
  assert(feed.includes('<link>https://example.com/free</link>'));
  assert(!feed.includes('perk-radar:withdrawn'));
});

test('RSS describes publication precision while retaining first discovery as pubDate', () => {
  const assessed = offer({ publication: { value: '2025-03', precision: 'month', certainty: 'approximate', basis: 'available_by', evidence: [{ url: 'https://example.com/news', quote: 'Available in March 2025.' }], reasoning: '只能确认当时已存在。', assessedAt: NOW, method: 'gpt-web-search' } });
  const feed = createFeed(document([assessed, offer({ id: 'unknown' })]), 'https://perks.example', Date.parse(NOW));
  assert(feed.includes('最晚已于2025年3月存在（发布时间估计）'));
  assert(feed.includes('消息发布时间：待查证'));
  assert.deepEqual([...feed.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map(match => match[1]), ['Sun, 25 Oct 2026 08:00:00 GMT', 'Sun, 25 Oct 2026 08:00:00 GMT']);
});

test('build packages reviewed data only and excludes candidates/source configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-radar-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(['data', 'src', 'public', 'work'].map(path => mkdir(join(root, path))));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Perks</title>');
  await writeFile(join(root, 'src/app.mjs'), 'export const test = true;');
  await writeFile(join(root, 'public/favicon.svg'), '<svg/>');
  await writeFile(join(root, 'data/offers.json'), JSON.stringify(document()));
  await writeFile(join(root, 'data/site.json'), JSON.stringify({ siteUrl: 'https://perks.example' }));
  await writeFile(join(root, 'data/sources.json'), '[]');
  await writeFile(join(root, 'work/candidates.json'), '{"private":"candidate"}');
  await build({ root, ...options });
  assert.deepEqual(await readdir(join(root, 'dist/data')), ['offers.json']);
  assert(!(await readdir(join(root, 'dist'))).includes('work'));
  assert.equal((JSON.parse(await readFile(join(root, 'dist/data/offers.json'), 'utf8'))).offers.length, 1);
});

test('preview path mapping rejects secrets and traversal', () => {
  assert.equal(resolvePublicPath('/data/sources.json', '/tmp/perks'), '/tmp/perks/public/data/sources.json');
  assert.equal(resolvePublicPath('/src/.env', '/tmp/perks'), null);
  assert.equal(resolvePublicPath('/%2e%2e/.env', '/tmp/perks'), null);
  assert.equal(resolvePublicPath('/.openai/hosting.json', '/tmp/perks', true), null);
  assert.equal(resolvePublicPath('/src/app.mjs', '/tmp/perks'), '/tmp/perks/src/app.mjs');
});


test('source text hashing ignores script/style asset churn and markup-only changes', () => {
  const first = sourceContent('<html><head><script src="v1.js">random 123</script></head><body><main><h1>Free 20 credits</h1><style>.color{color:red}</style></main></body></html>');
  const same = sourceContent('<html><head><script src="v2.js">random 456</script></head><body><main><h2>Free 20 credits</h2><style>.color{color:blue}</style></main></body></html>');
  assert.equal(first.contentHash, same.contentHash);
  assert.notEqual(first.contentHash, sourceContent('<main>Free 30 credits</main>').contentHash);
});

test('official offer changes retain baseline and review timestamps across changes, failures and recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-radar-observe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/sources.json'), JSON.stringify([{ id: 'official', name: 'Example official', url: 'https://example.com/free', kind: 'page', region: 'global' }]));
  const original = JSON.stringify(document());
  await writeFile(join(root, 'data/offers.json'), original);
  const moment = minute => `2026-10-26T08:0${minute}:00.000Z`;
  const page = (text, random = '') => async () => new Response(`<main><h1>${text}</h1><script>${random}</script></main>`, { headers: { 'content-type': 'text/html' } });
  const state = async name => JSON.parse(await readFile(join(root, `work/${name}.json`), 'utf8'));

  let result = await collect({ root, now: moment(0), fetchImpl: page('Free 20 credits', 'asset-one') });
  assert.equal(result.changes, 0, 'first observation only initializes a baseline');
  const baseline = (await state('health')).sources[0];
  assert.equal(baseline.baselineInitialized, true);
  assert.equal(baseline.lastSuccessAt, moment(0));
  assert.equal(baseline.consecutiveFailures, 0);
  assert.equal(result.candidates, 0, 'published URL remains absent from new candidate queue');

  result = await collect({ root, now: moment(1), fetchImpl: page('Free 20 credits', 'asset-two') });
  assert.equal(result.changes, 0, 'bundle churn does not create a content-change review');

  result = await collect({ root, now: moment(2), fetchImpl: page('Free 30 credits') });
  assert.equal(result.changes, 1, 'published URL still creates a change signal');
  const firstChange = (await state('changes')).changes[0];
  assert.equal(firstChange.firstDetectedAt, moment(2));
  assert.deepEqual(firstChange.affectedOfferIds, ['official-free-plan']);
  assert.equal(firstChange.previousHash, baseline.contentHash);

  await collect({ root, now: moment(3), fetchImpl: page('Free 40 credits') });
  const lastGood = (await state('health')).sources[0];
  const nextChange = (await state('changes')).changes[0];
  assert.equal((await state('changes')).changes.length, 1, 'successive changes merge into the pending source review');
  assert.equal(nextChange.firstDetectedAt, firstChange.firstDetectedAt);
  assert.equal(nextChange.lastDetectedAt, moment(3));
  assert.equal(nextChange.previousHash, baseline.contentHash);
  assert.equal(nextChange.currentHash, lastGood.contentHash);

  const unavailable = async () => new Response('Service unavailable', { status: 503 });
  await collect({ root, now: moment(4), fetchImpl: unavailable });
  await collect({ root, now: moment(5), fetchImpl: unavailable });
  const failed = (await state('health')).sources[0];
  assert.equal(failed.consecutiveFailures, 2);
  assert.equal(failed.contentHash, lastGood.contentHash);
  assert.equal(failed.lastSuccessAt, moment(3));
  assert.equal(failed.contentChanged, false);
  assert.equal((await state('changes')).changes.length, 1);

  await collect({ root, now: moment(6), fetchImpl: page('Free 40 credits') });
  const recovered = (await state('health')).sources[0];
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.lastSuccessAt, moment(6));
  assert.equal(recovered.contentChanged, false);
  const pending = (await state('changes')).changes[0];
  assert.equal(pending.firstDetectedAt, moment(2));
  assert.equal(pending.lastObservedAt, moment(6));
  assert.equal(pending.status, 'pending');
  assert.equal(await readFile(join(root, 'data/offers.json'), 'utf8'), original, 'automation never refreshes human verification or changes publication');
});


test('source byte limits default to 1 MiB and strictly cap every override at 4 MiB', async () => {
  assert.equal(sourceMaxBytes(), DEFAULT_MAX_BYTES);
  assert.equal(sourceMaxBytes({ maxBytes: 2 * DEFAULT_MAX_BYTES }), 2 * DEFAULT_MAX_BYTES);
  assert.equal(sourceMaxBytes({ maxBytes: MAX_SOURCE_BYTES }), MAX_SOURCE_BYTES);
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, null, '2097152', MAX_SOURCE_BYTES + 1]) {
    assert.throws(() => sourceMaxBytes({ maxBytes }), /source.maxBytes/);
  }
  let fetched = false;
  await assert.rejects(fetchText('https://example.com/free', { maxBytes: MAX_SOURCE_BYTES + 1, fetchImpl: async () => { fetched = true; return new Response('free'); } }), /source.maxBytes/);
  assert.equal(fetched, false, 'invalid limits are rejected before any request');
});

test('collector applies a per-source body limit override without raising the default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perk-radar-byte-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/sources.json'), JSON.stringify([
    { id: 'large', name: 'Large official page', url: 'https://example.com/large', kind: 'page', region: 'global', maxBytes: 2 * DEFAULT_MAX_BYTES },
    { id: 'default', name: 'Default official page', url: 'https://example.com/default', kind: 'page', region: 'global' }
  ]));
  const body = 'Free credits ' + 'x'.repeat(DEFAULT_MAX_BYTES);
  const result = await collect({ root, now: NOW, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(result.failures, 1);
  const health = JSON.parse(await readFile(join(root, 'work/health.json'), 'utf8'));
  assert.equal(health.sources.find(source => source.sourceId === 'large').outcome, 'ok');
  assert.equal(health.sources.find(source => source.sourceId === 'default').outcome, 'error');
  assert.match(health.sources.find(source => source.sourceId === 'default').message, /size limit/);
});
