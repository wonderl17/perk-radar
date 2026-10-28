import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichPublicationDates, publicationEvidence } from '../scripts/publication.mjs';
import { withDataLock } from '../scripts/lib.mjs';

const NOW = '2026-10-28T15:00:00.000Z';
const CONFIG = { model: 'gpt-test', apiKey: 'private-test-key' };
const DATE_QUOTE = 'Published March 12, 2025: Example introduces a free plan with 100 monthly credits.';
const base = { id: 'example-free', title: 'Example 免费100积分', provider: 'Example', benefit: '100积分', summary: '个人用户免费领取100积分。', category: 'ai', regions: ['global'], availability: '限支持地区', eligibility: ['个人用户'], steps: ['在官网领取'], caveats: ['每月有限额'], tags: [], publishedAt: null, expiresAt: null, offerType: 'ongoing', discoveredAt: '2026-10-20T08:00:00.000Z', verifiedAt: '2026-10-25T08:00:00.000Z', status: 'published', source: { name: 'Example', url: 'https://example.com/free', evidence: '官方提供免费计划。' } };
const unknown = { certainty: 'unknown', value: null, precision: null, basis: null, evidenceId: null, quote: null, reasoning: '当前可读资料未列同一权益的发布时间。' };
const known = { certainty: 'exact', value: '2025-03-12', precision: 'day', basis: 'published', evidenceId: 'page-2', quote: DATE_QUOTE, reasoning: '官方公告标注同一免费计划的发布日期。' };
async function fixture(t, offers = [base]) {
  const root = await mkdtemp(join(tmpdir(), 'perk-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data')); await mkdir(join(root, 'work'));
  const put = (path, value) => writeFile(join(root, path), JSON.stringify(value));
  const read = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
  await put('data/offers.json', { schemaVersion: 1, updatedAt: NOW, offers: structuredClone(offers) });
  await put('data/publication.json', { enabled: true, intervalMinutes: 60, maxOffersPerScan: 2, resultsPerQuery: 5, maxPagesPerOffer: 3, unknownRetryDays: 30, failureRetryMinutes: 60 });
  return { root, put, read };
}
function options(root, { draft = known, approved = true, hook, searchImpl, fetchPageImpl } = {}) {
  const calls = [], searches = [], fetched = [];
  return { calls, searches, fetched, root, config: CONFIG, nowFn: () => NOW,
    callImpl: async req => {
      calls.push(req.name); await hook?.(req);
      const value = req.name === 'publication_search_plan' ? { queries: JSON.parse(req.prompt).offers.map(x => ({ id: x.id, query: 'Example free plan announcement date' })) } : req.name === 'publication_date_extraction' ? structuredClone(draft) : { approved, reason: '独立核对原文。' };
      return { value };
    },
    searchImpl: searchImpl || (async req => { searches.push(req); return { status: 'ok', results: [{ title: 'Example announcement', url: 'https://example.com/news/free-plan' }] }; }),
    fetchPageImpl: fetchPageImpl || (async url => { fetched.push(url); return { url, text: `<body>${url.endsWith('/free') ? 'Example offers a free plan with 100 monthly credits. Registered users can claim it on the official dashboard.' : DATE_QUOTE + ' Registered individual users in supported regions can receive this free monthly plan.'}</body>` }; }),
  };
}

test('actual search, fetched dated evidence and an independent audit patch only publication', async t => {
  const fs = await fixture(t), run = options(fs.root);
  const report = await enrichPublicationDates(run);
  assert.equal(report.known, 1); assert.equal(report.failed, 0);
  assert.deepEqual(run.calls, ['publication_search_plan', 'publication_date_extraction', 'publication_date_audit']);
  assert.equal(run.searches.length, 1);
  const offer = (await fs.read('data/offers.json')).offers[0];
  assert.equal(offer.publication.value, '2025-03-12');
  assert.equal(offer.publication.evidence[0].url, 'https://example.com/news/free-plan');
  const { publication, ...unchanged } = offer;
  assert.deepEqual(unchanged, base, 'rule verification and first collection are untouched');
  assert.equal((await fs.read('work/publication-state.json')).running, undefined);
});

test('unknown assessments persist and are not repeatedly searched after restart or a manual batch', async t => {
  const fs = await fixture(t), run = options(fs.root, { draft: unknown });
  assert.equal((await enrichPublicationDates(run)).unknown, 1);
  const again = options(fs.root);
  assert.equal((await enrichPublicationDates({ ...again, manual: true, limit: 28 })).examined, 0);
  assert.deepEqual(again.calls, []);
  assert.equal((await fs.read('data/offers.json')).offers[0].publication.certainty, 'unknown');
});

test('an unavailable search remains a retryable failure rather than a fabricated unknown/date', async t => {
  const fs = await fixture(t);
  const report = await enrichPublicationDates(options(fs.root, { draft: unknown, searchImpl: async () => { throw Object.assign(new Error('secret network body private-test-key'), { code: 'SEARCH_UNAVAILABLE' }); } }));
  assert.equal(report.failed, 1); assert.equal(report.updated, 0);
  assert.equal((await fs.read('data/offers.json')).offers[0].publication, undefined);
  assert.ok(!(await readFile(join(fs.root, 'work/publication-report.json'), 'utf8')).includes('secret'));
  assert.equal((await fs.read('work/publication-state.json')).offers[base.id].nextAttemptAt, '2026-10-28T16:00:00.000Z');
  const skipped = await enrichPublicationDates(options(fs.root));
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.deferredFailures, 1, 'a skipped budget cannot hide unfinished failures');
});

test('a made-up date cannot pass merely because its quote exists', async t => {
  const fs = await fixture(t);
  const report = await enrichPublicationDates(options(fs.root, { draft: { ...known, value: '2024-03-12' } }));
  assert.equal(report.failed, 1); assert.equal(report.updated, 0);
  assert.equal((await fs.read('data/offers.json')).offers[0].publication, undefined);
});

test('an audit rejection retains a clear unknown rather than publishing the proposed date', async t => {
  const fs = await fixture(t);
  const report = await enrichPublicationDates(options(fs.root, { approved: false }));
  assert.equal(report.unknown, 1);
  const value = (await fs.read('data/offers.json')).offers[0].publication;
  assert.equal(value.value, null); assert.deepEqual(value.evidence, []);
});

test('manual dates and existing legacy release dates are never automatically selected', async t => {
  const publication = { value: '2025-03', precision: 'month', certainty: 'approximate', basis: 'published', evidence: [{ url: 'https://example.com/news', quote: 'March 2025 free plan announcement' }], reasoning: '编辑核对公告。', assessedAt: NOW, method: 'manual' };
  const fs = await fixture(t, [{ ...base, publication }, { ...base, id: 'legacy', source: { ...base.source, url: 'https://example.com/legacy' }, publishedAt: '2025-03-12T08:00:00.000Z' }]);
  const run = options(fs.root);
  assert.equal((await enrichPublicationDates(run)).examined, 0);
  assert.deepEqual(run.calls, []);
});

test('concurrent editor changes survive the date-only compare-and-swap', async t => {
  const fs = await fixture(t);
  const run = options(fs.root, { hook: async req => {
    if (req.name !== 'publication_date_audit') return;
    const doc = await fs.read('data/offers.json'); doc.offers[0].benefit = '人工更正后的权益'; await fs.put('data/offers.json', doc);
  } });
  const report = await enrichPublicationDates(run);
  assert.equal(report.updated, 0); assert.equal(report.results[0].outcome, 'conflict');
  const current = (await fs.read('data/offers.json')).offers[0];
  assert.equal(current.benefit, '人工更正后的权益'); assert.equal(current.publication, undefined);
});

test('a live cross-process claim cannot be bypassed by a manual backfill', async t => {
  const fs = await fixture(t); await fs.put('work/publication-state.json', { running: { pid: process.pid, token: 'other-run' } });
  const run = options(fs.root);
  assert.equal((await enrichPublicationDates({ ...run, manual: true, limit: 28 })).status, 'busy');
  assert.deepEqual(run.calls, []);
});

test('a temporarily empty newly created data lock is waited for rather than deleted', async t => {
  const fs = await fixture(t);
  await writeFile(join(fs.root, 'work/data-write.lock'), '');
  let entered = false;
  const waiting = withDataLock(fs.root, async () => { entered = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(entered, false);
  await writeFile(join(fs.root, 'work/data-write.lock'), JSON.stringify({ pid: process.pid }));
  await rm(join(fs.root, 'work/data-write.lock'));
  await waiting;
  assert.equal(entered, true);
});

test('a region-only editor correction during dating also survives the compare-and-swap', async t => {
  const fs = await fixture(t);
  const run = options(fs.root, { hook: async req => {
    if (req.name !== 'publication_date_audit') return;
    const doc = await fs.read('data/offers.json'); doc.offers[0].regions = ['cn']; await fs.put('data/offers.json', doc);
  } });
  assert.equal((await enrichPublicationDates(run)).results[0].outcome, 'conflict');
  assert.equal((await fs.read('data/offers.json')).offers[0].publication, undefined);
});

test('date evidence ignores modified/copyright metadata and preserves only actual publication metadata', () => {
  const body = '<body>This is a sufficiently readable example article describing a free plan for individual users, with official conditions.</body>';
  const text = publicationEvidence(`<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2025-03-12","dateModified":"2026-10-28"}</script><meta property="article:modified_time" content="2026-10-28">${body}`);
  assert.ok(text.includes('datePublished: 2025-03-12')); assert.ok(!text.includes('2026-10-28'));
  assert.equal(publicationEvidence('x'.repeat(42001)), null);
});
