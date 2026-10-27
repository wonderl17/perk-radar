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
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
});

test('invented result IDs and model-invented URLs cannot authorize a fetch', async t => {
  const fs = await fixture(t);
  const model = fakeCalls({ selection: { candidates: [{ resultId: 9000, region: 'global', reason: 'invented', url: 'https://invented.example.com/free' }] } });
  const run = options(fs.root, model);
  const report = await discoverSources(run);
  assert.equal(report.added, 0);
  assert.equal(report.held, 1);
  assert.equal(run.fetched.length, 0);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(await fs.read('data/sources.json'), [ORIGINAL]);
});

test('missing literal identity or benefit evidence and audit refusals cannot append a source', async t => {
  for (const patch of [
    { identityQuote: 'An invented provider identity' }, { benefitQuote: '99999 free credits' },
    { benefitQuote: '' }, { official: false }, { decision: 'review' }, { confidence: 0.96 },
    { region: 'everywhere' },
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
  assert.equal(report.held, 1);
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
  assert.equal(report.status, 'completed');
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
