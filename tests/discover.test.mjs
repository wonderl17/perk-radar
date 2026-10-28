import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSources, loadDiscoveryConfig } from '../scripts/discover.mjs';
import { plainText } from '../scripts/lib.mjs';

const NOW = '2026-10-27T14:00:00.000Z';
const RULES = 'https://novacloud.example.com/free-plan';
const HOME = 'https://novacloud.example.com/';
const CONFIG = { model: 'gpt-test', apiKey: 'test-only', baseUrl: 'https://model.example.com', apiMode: 'chat_completions', reasoningEffort: 'medium' };
const ORIGINAL = { id: 'manual-source', name: 'Original official rules', url: 'https://original.example.com/free', kind: 'page', region: 'cn' };
const SETTINGS = { enabled: true, maxQueriesPerScan: 2, resultsPerQuery: 5, maxCandidatesPerScan: 3, maxNewSourcesPerScan: 2, maxSources: 200, intervalMinutes: 60, candidateCooldownHours: 24 };
const HOME_TEXT = 'NovaCloud by Nova Labs. Nova Labs develops and operates the NovaCloud product, customer account dashboard, billing and support. This official product website provides the current plans and terms for NovaCloud customers.';
const RULES_TEXT = 'Receive 500 free credits each month. Registered individual users in supported regions can open the dashboard and choose the free plan. No credit card is required. Unused credits expire at the end of the monthly billing period and cannot be exchanged for cash. Usage above the free quota requires a separate paid plan, and account abuse is prohibited.';
const html = text => `<html><body><main>${text}</main></body></html>`;
const HOMEPAGE = html(`<h1>${HOME_TEXT}</h1><a href="/free-plan">Read the current free-plan rules</a>`);
const BENEFIT_PAGE = html(`<h1>NovaCloud free plan</h1><p>${RULES_TEXT}</p><a href="/">NovaCloud product homepage</a>`);
const hash = text => createHash('sha256').update(text).digest('hex');
const plan = () => ({ queries: [{ query: '中国 新产品 官方 免费 积分', region: 'cn' }, { query: 'new product official free credits current terms', region: 'global' }] });
const audit = overrides => ({ decision: 'approve', official: true, confidence: 0.99, sourceName: 'NovaCloud 官方免费计划', region: 'global', reason: '本次首页身份、规则及页面关系一致。', identityQuote: 'NovaCloud by Nova Labs', benefitQuote: 'Receive 500 free credits each month', ...overrides });
const hit = (url = RULES, overrides = {}) => ({ title: 'NovaCloud free plan official rules', url, description: 'Review free credits and eligibility on the current official plan page.', ...overrides });

async function fixture(t, { sources = [ORIGINAL], settings = {}, candidates = [], state } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perk-discover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data')); await mkdir(join(root, 'work'));
  const put = async (path, value) => writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
  await put('data/sources.json', sources);
  await put('data/discovery.json', { ...SETTINGS, ...settings });
  await put('data/offers.json', { schemaVersion: 1, updatedAt: NOW, offers: [] });
  await put('work/candidates.json', { candidates });
  if (state) await put('work/discovery-state.json', state);
  return { root, put, read: async path => JSON.parse(await readFile(join(root, path), 'utf8')), text: async path => readFile(join(root, path), 'utf8') };
}
function fakeCalls({ queryPlan = plan(), followupPlan = { queries: [] }, selection = { candidates: [{ resultId: 0, region: 'global', reason: '新官方计划' }] }, sourceAudit = audit(), onAudit, onFollowup } = {}) {
  const calls = [];
  const callImpl = async request => {
    calls.push(request);
    let value;
    if (request.name === 'discovery_query_plan') value = queryPlan;
    else if (request.name === 'discovery_followup_plan') { await onFollowup?.(request); value = followupPlan; }
    else if (request.name === 'discovery_result_selection') value = selection;
    else if (request.name === 'discovery_official_source_audit') {
      await onAudit?.(request);
      value = typeof sourceAudit === 'function' ? sourceAudit(request) : sourceAudit;
    } else throw new Error('Unexpected model call');
    return { value: structuredClone(value), model: CONFIG.model };
  };
  return { calls, callImpl };
}
function options(root, { hits = [hit()], fetchPage, ...overrides } = {}) {
  const searches = [], fetched = [];
  const searchImpl = async request => {
    searches.push(request);
    return { provider: 'fake-search', results: typeof hits === 'function' ? hits(request) : structuredClone(hits) };
  };
  const fetchPageImpl = async (url, request) => {
    fetched.push({ url, request });
    if (fetchPage) return fetchPage(url, request);
    return { url, text: new URL(url).pathname === '/' ? HOMEPAGE : BENEFIT_PAGE };
  };
  return { searches, fetched, root, config: CONFIG, searchImpl, fetchPageImpl, nowFn: () => NOW, ...overrides };
}

test('GPT queries use real search results and append an auditable official source plus a pending candidate', async t => {
  const fs = await fixture(t);
  const model = fakeCalls();
  const run = options(fs.root, model);
  const beforeOffers = await fs.text('data/offers.json');
  const report = await discoverSources(run);
  assert.equal(report.status, 'completed');
  assert.equal(report.added, 1);
  assert.equal(report.searchResults, 1, 'same result from two searches is deduplicated');
  assert.equal(report.failed, 0);
  assert.deepEqual(model.calls.map(x => x.name), ['discovery_query_plan', 'discovery_result_selection', 'discovery_official_source_audit']);
  assert.deepEqual(run.searches.map(x => x.query), plan().queries.map(x => x.query));
  assert.deepEqual(run.fetched.map(x => x.url), [RULES, HOME]);
  assert.deepEqual(run.fetched[0].request.allowedHosts, ['novacloud.example.com', 'www.novacloud.example.com']);
  const sources = await fs.read('data/sources.json');
  assert.deepEqual(sources[0], ORIGINAL);
  const added = sources[1];
  assert.match(added.id, /^auto-source-[a-f0-9]{20}$/);
  assert.equal(added.url, RULES);
  assert.equal(added.kind, 'page');
  assert.equal(added.discovery.method, 'gpt-web-search');
  assert.equal(added.discovery.model, CONFIG.model);
  assert.equal(added.discovery.searchUrl, RULES);
  assert.equal(added.discovery.homepageUrl, HOME);
  assert.equal(added.discovery.identityQuote, audit().identityQuote);
  assert.equal(added.discovery.benefitQuote, audit().benefitQuote);
  assert.equal(added.discovery.evidenceHash, hash(plainText(BENEFIT_PAGE.match(/<main>([\s\S]*)<\/main>/)[1])));
  const queue = (await fs.read('work/candidates.json')).candidates;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'pending', 'admitting a source must not directly publish a benefit');
  assert.equal(queue[0].sourceId, added.id);
  assert.equal(queue[0].discoveryMethod, 'gpt-web-search');
  assert.equal(await fs.text('data/offers.json'), beforeOffers);
  assert.equal((await fs.read('work/discovery-report.json')).added, 1);
});

test('a discovery interval and a failed attempt both prevent immediate repeated model/search calls', async t => {
  for (const failure of [false, true]) await t.test(failure ? 'failed attempt' : 'successful attempt', async st => {
    const fs = await fixture(st);
    let calls = 0;
    const model = fakeCalls();
    const run = options(fs.root, { callImpl: async request => { calls++; if (failure) throw new Error('raw provider secret'); return model.callImpl(request); } });
    const first = await discoverSources(run);
    assert.equal(first.status, failure ? 'failed' : 'completed');
    const beforeCalls = calls, beforeSearches = run.searches.length;
    const skipped = await discoverSources(run);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.nextRunAt, '2026-10-27T15:00:00.000Z');
    assert.equal(calls, beforeCalls);
    assert.equal(run.searches.length, beforeSearches);
    assert(!JSON.stringify(first).includes('raw provider secret'));
  });
});

test('simultaneous discovery triggers share the attempt cooldown before any model or search work', async t => {
  const fs = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const model = fakeCalls();
  const run = options(fs.root, { callImpl: async request => {
    if (request.name === 'discovery_query_plan') { entered(); await paused; }
    return model.callImpl(request);
  } });
  const active = discoverSources(run);
  await started;
  try {
    const duplicate = await discoverSources(run);
    assert.equal(duplicate.status, 'skipped');
    assert.equal(run.searches.length, 0);
  } finally { release(); }
  assert.equal((await active).added, 1);
  assert.deepEqual(model.calls.map(x => x.name), ['discovery_query_plan', 'discovery_result_selection', 'discovery_official_source_audit']);
});

test('candidate cooldown skips fetching and auditing an unchanged held result in the next round', async t => {
  const fs = await fixture(t);
  const firstModel = fakeCalls({ sourceAudit: audit({ decision: 'review', official: false }) });
  const firstRun = options(fs.root, firstModel);
  assert.equal((await discoverSources(firstRun)).held, 1);
  const secondModel = fakeCalls();
  const secondRun = options(fs.root, { ...secondModel, nowFn: () => '2026-10-27T15:01:00.000Z' });
  const report = await discoverSources(secondRun);
  assert.equal(report.searchResults, 0);
  assert.equal(report.added, 0);
  assert.deepEqual(secondModel.calls.map(x => x.name), ['discovery_query_plan']);
  assert.equal(secondRun.searches.length, 2);
  assert.equal(secondRun.fetched.length, 0);
  assert.equal(JSON.parse(secondModel.calls[0].prompt).coolingCandidates[0].code, 'SOURCE_AUDIT_REVIEW');
  const thirdModel = fakeCalls();
  await discoverSources(options(fs.root, { ...thirdModel, nowFn: () => '2026-10-27T16:02:00.000Z' }));
  assert.equal(JSON.parse(thirdModel.calls[0].prompt).coolingCandidates[0].code, 'SOURCE_AUDIT_REVIEW', 'a filtered round must not erase the outstanding evidence hold');
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
});

test('invented result IDs and model-invented URLs cannot authorize a fetch', async t => {
  const fs = await fixture(t);
  const model = fakeCalls({ selection: { candidates: [{ resultId: 9000, region: 'global', reason: 'invented', url: 'https://invented.example.com/free' }] } });
  const run = options(fs.root, model);
  const report = await discoverSources(run);
  assert.equal(report.added, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.held, 0);
  assert.equal(report.failures[0].code, 'MODEL_SELECTION_INVALID');
  assert.equal(run.fetched.length, 0);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
});

test('missing literal identity or benefit evidence and audit refusals cannot append a source', async t => {
  for (const patch of [
    { identityQuote: 'An invented provider identity' }, { benefitQuote: '99999 free credits' },
    { benefitQuote: '' }, { official: false }, { decision: 'review' }, { confidence: 0.96 },
  ]) await t.test(JSON.stringify(patch), async st => {
    const fs = await fixture(st);
    const model = fakeCalls({ sourceAudit: audit(patch) });
    const report = await discoverSources(options(fs.root, model));
    assert.equal(report.added, 0);
    assert.equal(report.held, 1);
    assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
    assert.deepEqual((await fs.read('work/candidates.json')).candidates, []);
  });
});

test('private source metadata rejected by the public registry validator is never written', async t => {
  const fs = await fixture(t);
  const model = fakeCalls({ sourceAudit: audit({ sourceName: '/Users/private/credentials official' }) });
  const report = await discoverSources(options(fs.root, model));
  assert.equal(report.added, 0);
  assert.equal(report.held, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].code, 'SOURCE_METADATA_INVALID');
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
});

test('private addresses, credential URLs and shared publishers are excluded before page requests', async t => {
  const blocked = [
    'https://127.0.0.1/free', 'https://[::1]/free', 'https://host.local/free', 'https://host.internal/free',
    'http://provider.com/free', 'https://user:secret@provider.com/free',
    'https://github.com/provider/project', 'https://tenant.github.io/free', 'https://medium.com/free',
    'https://tenant.vercel.app/free', 'https://tenant.netlify.app/free', 'https://tenant.pages.dev/free',
    'https://tenant.web.app/free', 'https://tenant.firebaseapp.com/free', 'https://tenant.azurewebsites.net/free',
  ];
  for (const url of blocked) await t.test(url, async st => {
    const fs = await fixture(st);
    const model = fakeCalls();
    const run = options(fs.root, { ...model, hits: [hit(url)] });
    const report = await discoverSources(run);
    assert.equal(report.added, 0);
    assert.equal(run.fetched.length, 0);
    assert.deepEqual(model.calls.map(x => x.name), ['discovery_query_plan']);
  });
});

test('a redirect to an unrelated source or homepage is held before the source audit', async t => {
  for (const phase of ['rules', 'homepage']) await t.test(phase, async st => {
    const fs = await fixture(st);
    const model = fakeCalls();
    const run = options(fs.root, { ...model, fetchPage: async url => ({ url: (phase === 'rules' ? url === RULES : url === HOME) ? 'https://unrelated.example.com/free' : url, text: url === HOME ? HOMEPAGE : BENEFIT_PAGE }) });
    const report = await discoverSources(run);
    assert.equal(report.added, 0);
    assert.equal(report.held, 1);
    assert.equal(model.calls.length, 2);
    assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
  });
});

test('homepage and rules need a literal page relationship, not only matching branding', async t => {
  const fs = await fixture(t);
  const model = fakeCalls();
  const report = await discoverSources(options(fs.root, { ...model, fetchPage: async url => ({ url, text: html(url === HOME ? HOME_TEXT : RULES_TEXT) }) }));
  assert.equal(report.added, 0);
  assert.equal(report.held, 1);
  assert.equal(model.calls.length, 2);
});

test('links embedded only in scripts, styles, noscript or comments cannot prove an official page relationship', async t => {
  for (const wrap of [value => `<script>const fake = '${value}'</script>`, value => `<style>/* ${value} */</style>`, value => `<noscript>${value}</noscript>`, value => `<!-- ${value} -->`]) await t.test(wrap.name || wrap('x').slice(0, 12), async st => {
    const fs = await fixture(st);
    const model = fakeCalls();
    const report = await discoverSources(options(fs.root, { ...model, fetchPage: async url => ({ url, text: html(url === HOME ? HOME_TEXT : RULES_TEXT) + wrap(`<a href="${url === HOME ? RULES : HOME}">Official link</a>`) }) }));
    assert.equal(report.added, 0);
    assert.equal(report.held, 1);
    assert.equal(model.calls.length, 2);
  });
});

test('oversized official identity or rules are held whole and never truncated into an audit', async t => {
  for (const phase of ['rules', 'homepage']) await t.test(phase, async st => {
    const fs = await fixture(st);
    const model = fakeCalls();
    const run = options(fs.root, { ...model, fetchPage: async url => ({ url, text: (phase === 'rules' ? url === RULES : url === HOME) ? html('a'.repeat(42001) + `<a href="${url === HOME ? RULES : HOME}">Official link</a>`) : url === HOME ? HOMEPAGE : BENEFIT_PAGE }) });
    const report = await discoverSources(run);
    assert.equal(report.held, 1);
    assert.equal(report.added, 0);
    assert.equal(model.calls.length, 2);
  });
});

test('late source append preserves concurrent manual source edits and newly queued candidates', async t => {
  const fs = await fixture(t);
  const edited = { ...ORIGINAL, name: 'Editor corrected official name' };
  const manual = { id: 'manual-added', name: 'Manual new source', url: 'https://editor.example.com/free', kind: 'page', region: 'global' };
  const candidate = { url: 'https://editor.example.com/another', sourceId: manual.id, status: 'pending', firstDiscoveredAt: NOW, title: 'Manual queue entry' };
  const model = fakeCalls({ onAudit: async () => {
    await fs.put('data/sources.json', [edited, manual]);
    await fs.put('work/candidates.json', { candidates: [candidate] });
  } });
  const report = await discoverSources(options(fs.root, model));
  assert.equal(report.added, 1);
  const sources = await fs.read('data/sources.json');
  assert.deepEqual(sources.slice(0, 2), [edited, manual]);
  assert.equal(sources.length, 3);
  assert((await fs.read('work/candidates.json')).candidates.some(item => item.url === candidate.url && item.title === candidate.title));
});

test('a concurrently registered matching source is preserved without overwriting or duplicating it', async t => {
  const fs = await fixture(t);
  const manual = { id: 'editor-version', name: 'Human-approved provider source', url: RULES, kind: 'page', region: 'cn' };
  const model = fakeCalls({ onAudit: () => fs.put('data/sources.json', [ORIGINAL, manual]) });
  const report = await discoverSources(options(fs.root, model));
  assert.equal(report.added, 0);
  assert.equal(report.results[0].outcome, 'duplicate');
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL, manual]);
});

test('registry capacity prevents model/search work and late capacity changes prevent append', async t => {
  const full = await fixture(t, { settings: { maxSources: 1 } });
  const noCalls = options(full.root, { callImpl: async () => { throw new Error('Must not call GPT'); } });
  const fullReport = await discoverSources(noCalls);
  assert.equal(fullReport.atCapacity, true);
  assert.equal(fullReport.failed, 0);
  assert.equal(noCalls.searches.length, 0);
  const fs = await fixture(t, { settings: { maxSources: 2 } });
  const manual = { id: 'editor-capacity', name: 'Manual source at capacity', url: 'https://editor.example.com/free', kind: 'page', region: 'cn' };
  const model = fakeCalls({ onAudit: () => fs.put('data/sources.json', [ORIGINAL, manual]) });
  const report = await discoverSources(options(fs.root, model));
  assert.equal(report.added, 0);
  assert.equal(report.atCapacity, true);
  assert.equal(report.results[0].outcome, 'capacity');
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL, manual]);
});

test('query, search-result, selected-candidate and new-source budgets bound paid work and requests', async t => {
  const fs = await fixture(t, { settings: { maxQueriesPerScan: 2, resultsPerQuery: 2, maxCandidatesPerScan: 3, maxNewSourcesPerScan: 1 } });
  const model = fakeCalls({ selection: { candidates: [0, 1, 2].map(resultId => ({ resultId, region: 'global', reason: 'Potential source' })) } });
  const run = options(fs.root, { ...model, hits: ({ query }) => Array.from({ length: 10 }, (_, index) => hit(`https://novacloud.example.com/free-plan?group=${query.includes('中国') ? 'cn' : 'global'}&id=${index}`)) });
  const report = await discoverSources(run);
  assert.equal(report.queries.length, 2);
  assert.equal(report.searchResults, 4);
  assert.deepEqual(run.searches.map(request => request.limit), [2, 2]);
  assert.equal(report.added, 1);
  assert.equal(report.considered, 1);
  assert.equal(run.fetched.length, 2);
  assert.equal(model.calls.length, 3);

  const over = await fixture(t, { settings: { maxQueriesPerScan: 2 } });
  const tooMany = fakeCalls({ queryPlan: { queries: [...plan().queries, { query: 'third query', region: 'global' }] } });
  const overRun = options(over.root, tooMany);
  const overReport = await discoverSources(overRun);
  assert.equal(overReport.status, 'failed');
  assert.equal(overRun.searches.length, 0);
  assert.equal(overRun.fetched.length, 0);

  const overSelection = await fixture(t, { settings: { maxCandidatesPerScan: 1 } });
  const excessiveSelection = fakeCalls({ selection: { candidates: [0, 1].map(resultId => ({ resultId, region: 'global', reason: 'Too many choices' })) } });
  const overSelectionRun = options(overSelection.root, { ...excessiveSelection, hits: [hit(), hit('https://another.example.com/free')] });
  const overSelectionReport = await discoverSources(overSelectionRun);
  assert.equal(overSelectionReport.status, 'failed');
  assert.equal(overSelectionReport.added, 0);
  assert.equal(overSelectionRun.fetched.length, 0);
  assert.equal(excessiveSelection.calls.length, 2);
});

test('adaptive followup searches use actual media leads to find a new official source within the same four-query budget', async t => {
  const fs = await fixture(t, { settings: { maxQueriesPerScan: 4 } });
  const media = hit('https://medium.com/product-news/novacloud-free', { title: 'NovaCloud announces a new free plan', description: 'Nova Labs says the NovaCloud free plan includes monthly credits; consult the official rules.' });
  const community = hit('https://reddit.com/r/newproducts/novacloud', { title: 'New NovaCloud free credits discussion' });
  const followupPlan = { queries: [{ query: 'NovaCloud Nova Labs official free plan pricing', region: 'global' }, { query: 'NovaCloud 官方 免费方案 领取条件', region: 'cn' }] };
  let followupContext;
  const model = fakeCalls({ followupPlan, onFollowup: request => { followupContext = JSON.parse(request.prompt); } });
  const run = options(fs.root, { ...model, hits: ({ query }) => plan().queries.some(item => item.query === query) ? [media, community] : [hit()] });
  const report = await discoverSources(run);
  assert.equal(report.added, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.searchResults, 1, 'media/community metadata are leads, never eligible official evidence');
  assert.equal(report.queries.length, 4);
  assert.deepEqual(run.searches.map(item => item.query), [...plan().queries, ...followupPlan.queries].map(item => item.query));
  assert.equal(JSON.parse(model.calls[0].prompt).maxQueries, 2);
  assert.equal(followupContext.maxQueries, 2);
  assert.deepEqual(followupContext.executedQueries, plan().queries);
  assert.deepEqual(followupContext.searchLeads.map(item => item.url), [media.url, community.url]);
  assert.equal(followupContext.searchLeads[0].description, media.description);
  const selectionContext = JSON.parse(model.calls.find(item => item.name === 'discovery_result_selection').prompt);
  assert.deepEqual(selectionContext.results.map(item => item.url), [RULES]);
  assert.deepEqual(run.fetched.map(item => item.url), [RULES, HOME]);
  assert.deepEqual(model.calls.map(item => item.name), ['discovery_query_plan', 'discovery_followup_plan', 'discovery_result_selection', 'discovery_official_source_audit']);
  const added = (await fs.read('data/sources.json'))[1];
  assert.equal(added.discovery.query, followupPlan.queries[0].query);
  assert.equal(report.results[0].query, followupPlan.queries[0].query);
  assert.equal(report.results[0].stage, 'registry-validation');
});

test('malformed, duplicate and overbudget adaptive plans cannot execute partial extra searches or fetch invented URLs', async t => {
  const cases = [
    { label: 'invented URL instead of queries', value: { candidates: [{ resultId: 0, url: RULES }] } },
    { label: 'missing query text', value: { queries: [{ url: RULES, region: 'global' }] } },
    { label: 'duplicate initial query', value: { queries: [{ query: 'new refined official query', region: 'global' }, { ...plan().queries[0] }] } },
    { label: 'duplicate within followup batch', value: { queries: [{ query: 'refined official query', region: 'global' }, { query: '  REFINED   OFFICIAL QUERY  ', region: 'cn' }] } },
    { label: 'overbudget', value: { queries: [0, 1, 2].map(index => ({ query: `refined official query ${index}`, region: 'global' })) } },
    { label: 'invalid region', value: { queries: [{ query: 'refined official query', region: 'all' }] } },
  ];
  for (const { label, value } of cases) await t.test(label, async st => {
    const fs = await fixture(st, { settings: { maxQueriesPerScan: 4 } });
    const model = fakeCalls({ followupPlan: value });
    const run = options(fs.root, { ...model, hits: [hit('https://medium.com/product-news/unverified-offer')] });
    const report = await discoverSources(run);
    assert.equal(report.failed, 1);
    assert.equal(report.added, 0);
    assert.equal(report.queries.length, 2);
    assert.equal(run.searches.length, 2, 'validate the complete followup batch before searching any of it');
    assert.equal(run.fetched.length, 0);
    assert.deepEqual(model.calls.map(item => item.name), ['discovery_query_plan', 'discovery_followup_plan']);
    assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
  });
});

test('a followup model failure preserves vetted initial candidates and records a safe failure count', async t => {
  const fs = await fixture(t, { settings: { maxQueriesPerScan: 4 } });
  const model = fakeCalls({ onFollowup: () => { throw new Error('private-provider-error-text'); } });
  const run = options(fs.root, model);
  const report = await discoverSources(run);
  assert.equal(report.failed, 1);
  assert.equal(report.status, 'partial');
  assert.equal(report.partial, true);
  assert.equal(report.added, 1);
  assert.equal(run.searches.length, 2);
  assert.equal(report.queries.length, 2);
  assert.deepEqual(run.fetched.map(item => item.url), [RULES, HOME]);
  assert(!JSON.stringify(report).includes('private-provider-error-text'));
  assert.equal((await fs.read('data/sources.json'))[1].url, RULES);
});

test('GPT may stop adaptive investigation with an empty plan and cannot directly nominate a page to fetch', async t => {
  const fs = await fixture(t, { settings: { maxQueriesPerScan: 4 } });
  const model = fakeCalls({ followupPlan: { queries: [], url: 'https://invented.example.com/credits' } });
  const run = options(fs.root, { ...model, hits: [] });
  const report = await discoverSources(run);
  assert.equal(report.failed, 0);
  assert.equal(report.added, 0);
  assert.equal(report.queries.length, 2);
  assert.equal(run.fetched.length, 0);
  assert.deepEqual(model.calls.map(item => item.name), ['discovery_query_plan', 'discovery_followup_plan']);
});

test('query diagnostics distinguish empty results, filtered results and complete search failures', async t => {
  for (const kind of ['empty', 'known', 'failed']) await t.test(kind, async st => {
    const fs = await fixture(st);
    const model = fakeCalls();
    const run = options(fs.root, { ...model, hits: kind === 'known' ? [hit(ORIGINAL.url)] : [] });
    if (kind === 'failed') run.searchImpl = async () => { throw Object.assign(new Error('private-provider-details'), { code: 'SEARCH_TIMEOUT' }); };
    const report = await discoverSources(run);
    assert.equal(report.nextRunAt, '2026-10-27T15:00:00.000Z');
    assert.equal(report.status, kind === 'failed' ? 'failed' : 'empty');
    assert.equal(report.failed, kind === 'failed' ? 2 : 0);
    assert.deepEqual(report.queryResults.map(query => query.status), [kind === 'failed' ? 'failed' : kind === 'known' ? 'ok' : 'empty'].flatMap(status => [status, status]));
    if (kind === 'known') {
      assert.equal(report.rawSearchResults, 2);
      assert.equal(report.excluded.known, 2);
      assert.equal(report.noCandidatesReason, 'all-results-filtered');
    } else if (kind === 'empty') assert.equal(report.noCandidatesReason, 'no-search-results');
    else assert(report.failures.every(failure => failure.stage === 'search' && failure.code === 'SEARCH_TIMEOUT'));
    assert(!JSON.stringify(await fs.read('work/discovery-state.json')).includes('private-provider-details'));
    assert.equal(run.fetched.length, 0);
  });
});

test('partial search failure retains safe provider attempts and gives accurate query outcomes to the followup planner', async t => {
  const fs = await fixture(t, { settings: { maxQueriesPerScan: 4 } });
  let followupContext;
  const model = fakeCalls({ onFollowup: request => { followupContext = JSON.parse(request.prompt); } });
  const run = options(fs.root, { ...model, searchImpl: async ({ query }) => {
    if (query.includes('中国')) throw Object.assign(new Error('private-query-error'), {
      code: 'SEARCH_UNAVAILABLE', attempts: [{ backend: 'yahoo', status: 'blocked', resultCount: 0, httpStatus: 429, raw: 'private-query-error' }, { backend: 'untrusted', status: 'timeout' }],
    });
    return { provider: 'ddgs', results: [hit()], attempts: [{ backend: 'brave', status: 'ok', resultCount: 1, httpStatus: 200, response: 'private-body' }] };
  } });
  const report = await discoverSources(run);
  assert.equal(report.status, 'partial');
  assert.equal(report.failed, 1);
  assert.equal(report.added, 1);
  assert.deepEqual(followupContext.queryResults.map(query => query.status), ['failed', 'ok']);
  assert.deepEqual(report.queryResults[0].attempts, [{ backend: 'yahoo', status: 'blocked', resultCount: 0, httpStatus: 429 }]);
  assert.deepEqual(report.queryResults[1].attempts, [{ backend: 'brave', status: 'ok', resultCount: 1, httpStatus: 200 }]);
  assert(!JSON.stringify(report).includes('private-query-error'));
  assert(!JSON.stringify(await fs.read('work/discovery-state.json')).includes('private-body'));
});

test('a single remaining query can refine real leads without increasing the search budget', async t => {
  const fs = await fixture(t, { settings: { maxQueriesPerScan: 3 } });
  const followupPlan = { queries: [{ query: 'NovaCloud official pricing free plan rules', region: 'global' }] };
  const model = fakeCalls({ followupPlan });
  const run = options(fs.root, { ...model, hits: ({ query }) => query === followupPlan.queries[0].query ? [hit()] : [] });
  const report = await discoverSources(run);
  assert.equal(report.added, 1);
  assert.equal(report.failed, 0);
  assert.equal(run.searches.length, 3);
  assert.equal(JSON.parse(model.calls.find(call => call.name === 'discovery_followup_plan').prompt).maxQueries, 1);
});

test('fetch, model and registry failures are recorded as failures while policy and evidence holds remain reviews', async t => {
  for (const kind of ['fetch', 'audit', 'malformed-audit', 'registry', 'policy', 'response']) await t.test(kind, async st => {
    const fs = await fixture(st);
    const model = fakeCalls({ sourceAudit: kind === 'malformed-audit' ? null : audit(), onAudit: async () => {
      if (kind === 'audit') throw new Error('private-audit-error');
      if (kind === 'registry') await writeFile(join(fs.root, 'work/candidates.json'), 'malformed private queue');
    } });
    const run = options(fs.root, { ...model, fetchPage: async url => {
      if (['fetch', 'policy', 'response'].includes(kind)) throw Object.assign(new Error('private-fetch-error'), { code: kind === 'policy' ? 'SOURCE_POLICY' : kind === 'response' ? 'SOURCE_RESPONSE' : 'SOURCE_TIMEOUT' });
      return { url, text: url === HOME ? HOMEPAGE : BENEFIT_PAGE };
    } });
    const report = await discoverSources(run);
    const held = ['policy', 'response'].includes(kind);
    assert.equal(report.failed, held ? 0 : 1);
    assert.equal(report.held, held ? 1 : 0);
    assert.equal(report.results[0].outcome, held ? 'review' : 'failed');
    assert.equal(report.results[0].code, { fetch: 'SOURCE_TIMEOUT', audit: 'MODEL_REQUEST_FAILED', 'malformed-audit': 'MODEL_AUDIT_INVALID', registry: 'SOURCE_REGISTRY_WRITE_FAILED', policy: 'SOURCE_POLICY', response: 'SOURCE_RESPONSE' }[kind]);
    assert.equal(report.results[0].retryable, !held);
    assert.equal(report.added, 0);
    assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
    assert(!JSON.stringify(report).includes('private-'));
  });
});

test('typed model planning errors retain safe codes and status numbers without exposing their original response', async t => {
  for (const [code, httpStatus, retryable] of [['MODEL_CONFIG', undefined, false], ['MODEL_AUTH', 401, false], ['MODEL_UPSTREAM', 503, true]]) await t.test(code, async st => {
    const fs = await fixture(st);
    const run = options(fs.root, { callImpl: async () => { throw Object.assign(new Error('private response ' + CONFIG.apiKey), { code, httpStatus, retryable: !retryable, response: 'private provider body' }); } });
    const report = await discoverSources(run);
    assert.equal(report.status, 'failed');
    assert.equal(report.failed, 1);
    assert.equal(report.held, 0);
    assert.equal(report.failures[0].stage, 'query-plan');
    assert.equal(report.failures[0].code, code);
    assert.equal(report.failures[0].httpStatus, httpStatus);
    assert.equal(report.failures[0].retryable, retryable, 'retryability comes from the code allowlist');
    assert.equal(run.searches.length, 0);
    assert(!JSON.stringify(report).includes('private'));
    assert(!JSON.stringify(await fs.read('work/discovery-state.json')).includes(CONFIG.apiKey));
  });
});

test('all recognized model audit error codes remain failures and only controlled numeric HTTP statuses survive', async t => {
  const cases = [
    ['MODEL_CONFIG', undefined, false], ['MODEL_AUTH', 403, false], ['MODEL_RATE_LIMIT', 429, true], ['MODEL_UPSTREAM', 502, true],
    ['MODEL_NETWORK', undefined, true], ['MODEL_TIMEOUT', undefined, true], ['MODEL_RESPONSE_INVALID', 200, true], ['MODEL_INCOMPLETE', 200, true],
    ['MODEL_REFUSAL', 200, false], ['MODEL_OUTPUT_INVALID', 200, true], ['MODEL_HTTP', 400, false], ['untrusted-provider-code', 'private status', true],
  ];
  for (const [code, httpStatus, retryable] of cases) await t.test(code, async st => {
    const fs = await fixture(st);
    const model = fakeCalls({ onAudit: () => { throw Object.assign(new Error('private provider response'), { code, httpStatus, retryable: !retryable }); } });
    const report = await discoverSources(options(fs.root, model));
    const safeCode = code === 'untrusted-provider-code' ? 'MODEL_REQUEST_FAILED' : code;
    assert.equal(report.failed, 1);
    assert.equal(report.held, 0);
    assert.equal(report.results[0].outcome, 'failed');
    assert.equal(report.results[0].code, safeCode);
    assert.equal(report.results[0].retryable, retryable);
    assert.equal(report.results[0].httpStatus, typeof httpStatus === 'number' ? httpStatus : undefined);
    assert.equal(report.failures[0].httpStatus, report.results[0].httpStatus);
    const state = await fs.read('work/discovery-state.json');
    assert.equal(state.history[0].failures[0].code, safeCode);
    assert.equal(state.history[0].failures[0].httpStatus, report.results[0].httpStatus);
    assert(!JSON.stringify(report).includes('private'));
  });
});

test('retryable candidates wait one hour, preserve feedback for GPT and do not inherit the evidence hold cooldown', async t => {
  const fs = await fixture(t, { settings: { intervalMinutes: 30 } });
  const failed = options(fs.root, { ...fakeCalls(), fetchPage: async () => { throw Object.assign(new Error('private-fetch-error'), { code: 'SOURCE_TIMEOUT' }); } });
  assert.equal((await discoverSources(failed)).failed, 1);
  const secondModel = fakeCalls();
  const second = await discoverSources(options(fs.root, { ...secondModel, nowFn: () => '2026-10-27T14:31:00.000Z' }));
  assert.equal(second.status, 'empty');
  assert.equal(second.excluded.cooldown, 2);
  const previous = JSON.parse(secondModel.calls[0].prompt).previousDiscovery;
  assert.equal(previous.candidates[0].code, 'SOURCE_TIMEOUT');
  assert.equal(previous.candidates[0].stage, 'rules-fetch');
  assert.equal(previous.queryResults[0].status, 'ok');
  const third = await discoverSources(options(fs.root, { ...fakeCalls(), nowFn: () => '2026-10-27T15:02:00.000Z' }));
  assert.equal(third.added, 1);
  const state = await fs.read('work/discovery-state.json');
  assert.equal(state.history.length, 3);
  assert.equal(state.history[0].candidates[0].code, 'SOURCE_TIMEOUT');
  assert(!JSON.stringify(state.history).includes('private-fetch-error'));
  assert(!JSON.stringify(state.history).includes(RULES_TEXT));
});

test('a failed queue or registry write never strands a known source without a candidate and can recover next hour', async t => {
  for (const target of ['work/candidates.json', 'data/sources.json']) await t.test(target, async st => {
    const fs = await fixture(st);
    const blockedTemp = join(fs.root, `${target}.${process.pid}.tmp`);
    const model = fakeCalls({ onAudit: () => mkdir(blockedTemp) });
    const failed = await discoverSources(options(fs.root, model));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.results[0].code, 'SOURCE_REGISTRY_WRITE_FAILED');
    assert.equal(failed.added, 0);
    assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
    assert.equal((await fs.read('work/candidates.json')).candidates.length, target.startsWith('work/') ? 0 : 1);
    await rm(blockedTemp, { recursive: true });
    const recovered = await discoverSources(options(fs.root, { ...fakeCalls(), nowFn: () => '2026-10-27T15:01:00.000Z' }));
    assert.equal(recovered.added, 1);
    assert.equal(recovered.failed, 0);
    assert.equal((await fs.read('work/candidates.json')).candidates.length, 1);
  });
});

test('round history stays bounded and an unfinished due claim preserves prior diagnostics', async t => {
  const fs = await fixture(t, { state: { round: 60, seen: [], history: Array.from({ length: 60 }, (_, round) => ({ round })), feedback: { status: 'partial', failures: [{ code: 'SEARCH_TIMEOUT' }] } } });
  const model = fakeCalls();
  const run = options(fs.root, { callImpl: async request => {
    if (request.name === 'discovery_query_plan') {
      const claimed = await fs.read('work/discovery-state.json');
      assert.equal(claimed.history.length, 48);
      assert.equal(claimed.feedback.failures[0].code, 'SEARCH_TIMEOUT');
    }
    return model.callImpl(request);
  } });
  await discoverSources(run);
  const state = await fs.read('work/discovery-state.json');
  assert.equal(state.history.length, 48);
  assert.equal(state.history.at(-1).round, 61);
  const before = await fs.text('work/discovery-state.json');
  assert.equal((await discoverSources(run)).status, 'skipped');
  assert.equal(await fs.text('work/discovery-state.json'), before);
});

test('standard encoded and unquoted links prove a relationship while data attributes and quoted prose do not', async t => {
  for (const kind of ['entities', 'unquoted', 'data-attribute', 'quoted-prose']) await t.test(kind, async st => {
    const fs = await fixture(st);
    const rules = kind === 'entities' ? `${RULES}?a=1&b=2` : RULES;
    const links = { entities: '<a href="/free-plan?a=1&amp;b=2">Plan rules</a>', unquoted: '<a href=/free-plan>Plan rules</a>', 'data-attribute': '<a data-href="/free-plan">Plan rules</a>', 'quoted-prose': '<a title=" href=\'/free-plan\'">Plan rules</a>' };
    const report = await discoverSources(options(fs.root, { ...fakeCalls(), hits: [hit(rules)], fetchPage: async url => ({ url, text: html(url === HOME ? HOME_TEXT + links[kind] : RULES_TEXT) }) }));
    const accepted = ['entities', 'unquoted'].includes(kind);
    assert.equal(report.added, accepted ? 1 : 0);
    assert.equal(report.held, accepted ? 0 : 1);
    if (!accepted) assert.equal(report.results[0].code, 'SOURCE_RELATIONSHIP_MISSING');
  });
});

test('disabled and invalid discovery configuration cannot silently perform network/model work', async t => {
  const fs = await fixture(t, { settings: { enabled: false } });
  const run = options(fs.root, { callImpl: async () => { throw new Error('Must not call'); } });
  assert.equal((await discoverSources(run)).status, 'disabled');
  assert.equal(run.searches.length, 0);
  for (const settings of [{ maxQueriesPerScan: 1 }, { resultsPerQuery: 9 }, { maxCandidatesPerScan: 7 }, { maxNewSourcesPerScan: 5 }, { maxSources: 501 }, { intervalMinutes: 29 }, { candidateCooldownHours: 0 }]) {
    await fs.put('data/discovery.json', { ...SETTINGS, ...settings });
    await assert.rejects(loadDiscoveryConfig(fs.root), /Invalid discovery setting/);
  }
});
