import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb } from '../scripts/search.mjs';

test('search bridge preserves the generated query and bounds results without passing model credentials', async () => {
  let call;
  const result = await searchWeb({ query: ' 免费 AI 积分 official ', limit: 2, env: { PATH: '/bin', HTTPS_PROXY: 'http://proxy.example', PERK_SEARCH_PYTHON: '/isolated/python', PERK_LLM_API_KEY: 'private-model-key', OPENAI_API_KEY: 'private-openai-key' }, bridgeImpl: async args => {
    call = args;
    return JSON.stringify({ provider: 'ddgs', results: [
      { title: 'First', url: 'https://example.com/offer#details', description: ' Public terms ' },
      { title: 'Duplicate', url: 'https://example.com/offer#other' },
      { title: 'HTTP', url: 'http://example.com/other' },
      { title: 'Credential', url: 'https://user:password@example.com/other' },
      { title: 'Second', url: 'https://other.example/free' },
      { title: 'Third', url: 'https://third.example/free' },
    ] });
  } });
  assert.equal(call.query, '免费 AI 积分 official');
  assert.equal(call.limit, 2);
  assert.equal(call.python, '/isolated/python');
  assert.equal(call.timeoutMs, 45000);
  assert.match(call.scriptPath, /scripts[/\\]web-search\.py$/);
  assert.equal(call.env.PATH, '/bin');
  assert.equal(call.env.HTTPS_PROXY, 'http://proxy.example');
  assert.equal(call.env.PERK_LLM_API_KEY, undefined);
  assert.equal(call.env.OPENAI_API_KEY, undefined);
  assert.equal(call.env.PERK_SEARCH_PYTHON, undefined);
  assert.deepEqual(result, { provider: 'ddgs', status: 'ok', attempts: [], results: [
    { title: 'First', url: 'https://example.com/offer', description: 'Public terms' },
    { title: 'Second', url: 'https://other.example/free', description: '' },
  ] });
});

test('search inputs reject unbounded query, limits, timeout and malformed runtime before calling a provider', async () => {
  let calls = 0;
  const bridgeImpl = async () => { calls++; return {}; };
  for (const options of [{ query: '' }, { query: 'a'.repeat(241) }, { query: 'hello\nworld' }, { query: 'valid', limit: 9 }, { query: 'valid', limit: 0 }, { query: 'valid', timeoutMs: 45001 }, { query: 'valid', env: { PERK_SEARCH_PYTHON: 'python\narg' } }]) {
    await assert.rejects(searchWeb({ ...options, bridgeImpl }));
  }
  assert.equal(calls, 0);
});

test('search failures, malformed JSON and oversized output never expose provider diagnostics', async () => {
  for (const bridgeImpl of [
    async () => { throw new Error('secret-key in provider URL'); },
    async () => '{invalid private-url',
    async () => ({ provider: 'ddgs', error: 'secret', results: [] }),
    async () => ({ provider: 'unexpected', results: [] }),
    async () => 'a'.repeat(256 * 1024 + 1),
  ]) {
    await assert.rejects(searchWeb({ query: 'benefits', bridgeImpl }), error => /Web search unavailable/.test(error.message) && !/secret|private-url|provider URL/.test(error.message));
  }
});

test('an unresponsive search bridge is bounded and its late result cannot publish leads', async () => {
  await assert.rejects(searchWeb({ query: 'free credits', timeoutMs: 10, bridgeImpl: () => new Promise(() => {}) }), /Web search unavailable/);
});

test('a successful empty search remains distinct from a failed request and strings are bounded', async () => {
  assert.deepEqual(await searchWeb({ query: 'new perks', bridgeImpl: async () => ({ provider: 'ddgs', status: 'empty', results: [] }) }), { provider: 'ddgs', status: 'empty', attempts: [], results: [] });
  const result = await searchWeb({ query: 'new perks', bridgeImpl: async () => ({ provider: 'ddgs', results: [{ title: 'a'.repeat(300), url: 'https://example.com', description: 'b'.repeat(1500) }] }) });
  assert.equal(result.results[0].title.length, 240);
  assert.equal(result.results[0].description.length, 1200);
});

test('typed provider failures retain only controlled codes and bounded attempt metadata', async () => {
  const attempts = [{ backend: 'yahoo', status: 'blocked', resultCount: 0, httpStatus: 429, diagnostic: 'private URL and secret' }, { backend: 'private-url', status: 'unknown', resultCount: 0 }];
  await assert.rejects(searchWeb({ query: 'free credits', bridgeImpl: async () => ({ provider: 'ddgs', status: 'unavailable', error: 'SEARCH_UNAVAILABLE', results: [], attempts }) }), error => {
    assert.equal(error.code, 'SEARCH_UNAVAILABLE');
    assert.deepEqual(error.attempts, [{ backend: 'yahoo', status: 'blocked', resultCount: 0, httpStatus: 429 }]);
    assert.doesNotMatch(JSON.stringify(error), /private|secret|diagnostic/);
    return true;
  });
  await assert.rejects(searchWeb({ query: 'credits', bridgeImpl: async () => { throw Object.assign(new Error('private'), { code: 'secret-value' }); } }), error => error.code === 'SEARCH_UNAVAILABLE' && !JSON.stringify(error).includes('secret'));
  await assert.rejects(searchWeb({ query: 'credits', bridgeImpl: async () => 'malformed private JSON' }), error => error.code === 'SEARCH_INVALID_RESPONSE');
  await assert.rejects(searchWeb({ query: 'credits', timeoutMs: 10, bridgeImpl: () => new Promise(() => {}) }), error => error.code === 'SEARCH_TIMEOUT');
});

test('successful fallback reports failed attempts without treating them as a failed logical query', async () => {
  const attempts = [{ backend: 'yahoo', status: 'unparsed', resultCount: 0, httpStatus: 200 }, { backend: 'brave', status: 'ok', resultCount: 1, httpStatus: 200 }];
  const result = await searchWeb({ query: 'site:example.com free credits', bridgeImpl: async () => ({ provider: 'ddgs', status: 'ok', results: [{ title: 'Free credits', url: 'https://example.com/credits' }], attempts }) });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.attempts, attempts);
  assert.equal(result.results.length, 1);
});

test('explicit provider states cannot turn malformed or unsafe results into a healthy empty search', async () => {
  for (const response of [
    { status: 'ok', results: [] },
    { status: 'empty', results: [{ title: 'Unexpected result', url: 'https://example.com' }] },
    { status: 'ok', results: [{ title: 'Unsafe', url: 'http://example.com' }] },
  ]) {
    await assert.rejects(searchWeb({ query: 'free credits', bridgeImpl: async () => ({ provider: 'ddgs', ...response }) }), error => error.code === 'SEARCH_INVALID_RESPONSE');
  }
});

test('healthy empty responses retain evidence of empty and blocked fallback attempts', async () => {
  const attempts = [{ backend: 'yahoo', status: 'empty', resultCount: 0, httpStatus: 200 }, { backend: 'brave', status: 'blocked', resultCount: 0, httpStatus: 429 }];
  const result = await searchWeb({ query: 'free credits', bridgeImpl: async () => ({ provider: 'ddgs', status: 'empty', results: [], attempts }) });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.attempts, attempts);
});
