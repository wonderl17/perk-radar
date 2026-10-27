import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGithub, validateSources } from '../scripts/sync-github.mjs';

const OLD = '1'.repeat(40), NEW = '2'.repeat(40);
function dataset() {
  return { schemaVersion: 1, updatedAt: '2026-10-26T08:00:00Z', offers: [{ id: 'official-free-plan', title: '官方免费计划', provider: 'Example', summary: '可以申请基础免费权益。', benefit: '免费基础额度', category: 'ai', regions: ['global'], availability: '限官方支持的地区', eligibility: ['注册账号'], steps: ['查看官方页面'], caveats: ['额度及限制以官方为准'], tags: ['免费'], publishedAt: null, discoveredAt: '2026-10-25T08:00:00Z', verifiedAt: '2026-10-26T08:00:00Z', expiresAt: null, offerType: 'ongoing', source: { name: 'Example 官方', url: 'https://example.com/free', evidence: '官方页面列出免费基础套餐。' }, status: 'published' }] };
}
async function fixture(t, { document = dataset(), config = { repository: 'wonderl17/perk-radar', branch: 'luke/main' }, sources } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perk-github-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(join(root, 'data/offers.json'), bytes);
  await writeFile(join(root, 'data/github.json'), JSON.stringify(config));
  let sourceBytes;
  if (sources !== undefined) { sourceBytes = Buffer.from(`${JSON.stringify(sources, null, 2)}\n`); await writeFile(join(root, 'data/sources.json'), sourceBytes); }
  return { root, bytes, sourceBytes };
}
function sha(bytes) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }

test('identical public data skips the write and requests only the branch file SHA', async t => {
  const { root, bytes } = await fixture(t);
  const calls = [];
  const result = await syncGithub({ root, runGh: async (...args) => { calls.push(args); return `${sha(bytes)}\n`; } });
  assert.deepEqual(result, { repo: 'wonderl17/perk-radar', updated: false, commitUrl: null });
  assert.equal(calls.length, 1);
  assert(calls[0][0].includes('repos/wonderl17/perk-radar/contents/data/offers.json?ref=luke%2Fmain'));
  assert.deepEqual(calls[0][0].slice(-2), ['--jq', '.sha']);
  assert.equal(calls[0][1], undefined);
});
test('a changed reviewed dataset updates only offers via stdin and the exact old SHA', async t => {
  const { root, bytes } = await fixture(t);
  const calls = [];
  const result = await syncGithub({ root, runGh: async (args, input) => {
    calls.push({ args, input });
    return input ? JSON.stringify({ commit: { sha: NEW, html_url: `https://github.com/wonderl17/perk-radar/commit/${NEW}` } }) : OLD;
  } });
  assert.equal(calls.length, 2);
  const put = calls[1];
  assert(put.args.includes('PUT'));
  assert(put.args.includes('repos/wonderl17/perk-radar/contents/data/offers.json'));
  assert.deepEqual(put.args.slice(-2), ['--input', '-']);
  assert(!put.args.includes(put.input));
  const body = JSON.parse(put.input);
  assert.equal(body.sha, OLD);
  assert.equal(body.branch, 'luke/main');
  assert.deepEqual(Buffer.from(body.content, 'base64'), bytes);
  assert.deepEqual(body.author, { name: 'Perk Radar', email: 'wonderl17@users.noreply.github.com' });
  assert.deepEqual(body.committer, body.author);
  assert.match(body.message, /^Update reviewed benefits at /);
  assert.deepEqual(result, { repo: 'wonderl17/perk-radar', updated: true, commitUrl: `https://github.com/wonderl17/perk-radar/commit/${NEW}` });
});
test('invalid reviewed data is rejected before reading repository configuration or making requests', async t => {
  const bad = dataset(); bad.offers[0].source.evidence = '';
  const { root } = await fixture(t, { document: bad });
  await rm(join(root, 'data/github.json'));
  let calls = 0;
  await assert.rejects(syncGithub({ root, runGh: async () => { calls++; } }), /failed validation/);
  assert.equal(calls, 0);
});
test('repository and branch validation rejects path or query injection without external calls', async t => {
  for (const config of [
    { repository: 'https://github.com/wonderl17/perk-radar', branch: 'luke/main' },
    { repository: 'wonderl17/../private', branch: 'luke/main' },
    { repository: 'wonderl17/..', branch: 'luke/main' },
    { repository: 'wonderl17/perk-radar?token=secret', branch: 'luke/main' },
    { repository: 'wonderl17/perk-radar', branch: 'main?ref=private' },
    { repository: 'wonderl17/perk-radar', branch: '../main' },
    { repository: 'wonderl17/perk-radar', branch: 'luke/.private' },
    { repository: 'wonderl17/perk-radar', branch: 'luke/main.lock' },
    { repository: 'wonderl17/perk-radar', branch: 'refs/heads/main' },
  ]) {
    const { root } = await fixture(t, { config });
    let calls = 0;
    await assert.rejects(syncGithub({ root, runGh: async () => { calls++; } }), /valid GitHub/);
    assert.equal(calls, 0);
  }
});
test('a conflicting PUT is not retried and never reflects sensitive CLI output', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  await assert.rejects(syncGithub({ root, runGh: async (args, input) => {
    calls++;
    if (!input) return OLD;
    throw Object.assign(new Error('secret-token provider contents'), { statusCode: 409 });
  } }), error => /changed concurrently/.test(error.message) && !/secret-token/.test(error.message));
  assert.equal(calls, 2);
});
test('failed reads and writes sanitize arbitrary error bodies without blind retry', async t => {
  for (const phase of ['get', 'put']) {
    const { root } = await fixture(t);
    let calls = 0;
    await assert.rejects(syncGithub({ root, runGh: async (args, input) => {
      calls++;
      if (phase === 'get' || input) throw new Error('private-credential and raw API body');
      return OLD;
    } }), error => !/private-credential|raw API body/.test(error.message));
    assert.equal(calls, phase === 'get' ? 1 : 2);
  }
});
test('invalid remote revisions cannot trigger writes, and unverified commit responses fail safely', async t => {
  const { root } = await fixture(t);
  let calls = 0;
  await assert.rejects(syncGithub({ root, runGh: async () => { calls++; return 'not-a-sha'; } }), /invalid file revision/);
  assert.equal(calls, 1);
  await assert.rejects(syncGithub({ root, runGh: async (args, input) => input ? JSON.stringify({ commit: { sha: NEW, html_url: 'javascript:secret' } }) : OLD }), /could not be verified/);
});


test('a configured account is verified before repository access and controls the public commit identity', async t => {
  const { root, bytes } = await fixture(t, { config: { account: 'wonderl17', repository: 'public-org/perk-radar', branch: 'luke/main' } });
  const calls = [];
  const result = await syncGithub({ root, runGh: async (args, input) => {
    calls.push({ args, input });
    if (args[3] === 'user') return 'WONDERL17\n';
    return input ? JSON.stringify({ commit: { sha: NEW, html_url: `https://github.com/public-org/perk-radar/commit/${NEW}` } }) : OLD;
  } });
  assert.deepEqual(calls[0], { args: ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], input: undefined });
  assert.equal(calls.length, 3);
  assert(calls[1].args.includes('repos/public-org/perk-radar/contents/data/offers.json?ref=luke%2Fmain'));
  const payload = JSON.parse(calls[2].input);
  assert.deepEqual(Buffer.from(payload.content, 'base64'), bytes);
  assert.deepEqual(payload.author, { name: 'Perk Radar', email: 'wonderl17@users.noreply.github.com' });
  assert.deepEqual(payload.committer, payload.author);
  assert.equal(result.updated, true);
});

test('a mismatched or malformed authenticated identity cannot read or write the repository', async t => {
  for (const login of ['different-user', '', 'wonderl17/private', 'unexpected raw response']) {
    const { root } = await fixture(t, { config: { account: 'wonderl17', repository: 'wonderl17/perk-radar', branch: 'luke/main' } });
    const calls = [];
    await assert.rejects(syncGithub({ root, runGh: async args => { calls.push(args); return login; } }), /active GitHub account does not match/);
    assert.deepEqual(calls, [['api', '--hostname', 'github.com', 'user', '--jq', '.login']]);
  }
});

test('invalid configured accounts fail before any GitHub request', async t => {
  for (const account of ['', null, 17, '-wonderl17', 'wonderl17-', 'wonder--l17', 'wonder_l17', 'wonderl17/private', 'a'.repeat(40), 'wonderl17\n']) {
    const { root } = await fixture(t, { config: { account, repository: 'wonderl17/perk-radar', branch: 'luke/main' } });
    let calls = 0;
    await assert.rejects(syncGithub({ root, runGh: async () => { calls++; } }), /valid GitHub/);
    assert.equal(calls, 0);
  }
});

test('identity API failures are sanitized and never continue to repository access', async t => {
  const { root } = await fixture(t, { config: { account: 'wonderl17', repository: 'wonderl17/perk-radar', branch: 'luke/main' } });
  const calls = [];
  await assert.rejects(syncGithub({ root, runGh: async args => { calls.push(args); throw new Error('secret-token and raw identity API body'); } }), error => /Unable to verify/.test(error.message) && !/secret-token|raw identity/.test(error.message));
  assert.deepEqual(calls, [['api', '--hostname', 'github.com', 'user', '--jq', '.login']]);
});


function sourceRegistry() {
  return [{ id: 'example-official-free', name: 'Example 官方免费计划', url: 'https://example.com/free', kind: 'page', region: 'global', allowedHosts: ['example.com', 'www.example.com'], maxBytes: 1048576,
    discovery: { method: 'gpt-web-search', model: 'gpt-test', discoveredAt: '2026-10-27T12:00:00Z', query: 'official free developer credits', homepageUrl: 'https://example.com/', searchUrl: 'https://example.com/free', evidenceHash: 'a'.repeat(64), homepageHash: 'b'.repeat(64), identityQuote: 'Example develops useful software.', benefitQuote: 'Free developer credits are available.' },
  }];
}
function pathFrom(args) { return args.find(value => value.startsWith('repos/'))?.split('?')[0]; }

test('unchanged offers and official registry skip every PUT after verifying the bound identity', async t => {
  const { root, bytes, sourceBytes } = await fixture(t, { sources: sourceRegistry(), config: { account: 'wonderl17', repository: 'wonderl17/perk-radar', branch: 'luke/main' } });
  const calls = [];
  const result = await syncGithub({ root, runGh: async (args, input) => {
    calls.push({ args, input });
    if (args[3] === 'user') return 'wonderl17';
    assert.equal(input, undefined);
    return sha(pathFrom(args).endsWith('sources.json') ? sourceBytes : bytes);
  } });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
  assert.deepEqual(result, { repo: 'wonderl17/perk-radar', updated: false, commitUrl: null, files: [
    { path: 'data/offers.json', updated: false, commitUrl: null },
    { path: 'data/sources.json', updated: false, commitUrl: null },
  ] });
});

test('source-only changes persist the exact validated registry without modifying unchanged offers', async t => {
  const { root, bytes, sourceBytes } = await fixture(t, { sources: sourceRegistry() });
  const calls = [];
  const result = await syncGithub({ root, runGh: async (args, input) => {
    calls.push({ args, input });
    if (input) return JSON.stringify({ commit: { sha: NEW, html_url: `https://github.com/wonderl17/perk-radar/commit/${NEW}` } });
    return pathFrom(args).endsWith('sources.json') ? OLD : sha(bytes);
  } });
  assert.equal(calls.length, 3, 'both file SHAs precede the single write');
  assert(calls.slice(0, 2).every(call => !call.input));
  assert.equal(pathFrom(calls[2].args), 'repos/wonderl17/perk-radar/contents/data/sources.json');
  const body = JSON.parse(calls[2].input);
  assert.deepEqual(Buffer.from(body.content, 'base64'), sourceBytes);
  assert.equal(body.sha, OLD);
  assert.equal(body.branch, 'luke/main');
  assert.equal(body.author.email, 'wonderl17@users.noreply.github.com');
  assert.deepEqual(calls[2].args.slice(-2), ['--input', '-']);
  assert.equal(result.updated, true);
  assert.equal(result.commitUrl, `https://github.com/wonderl17/perk-radar/commit/${NEW}`);
  assert.deepEqual(result.files.map(({ path, updated }) => ({ path, updated })), [{ path: 'data/offers.json', updated: false }, { path: 'data/sources.json', updated: true }]);
});

test('invalid source fields, duplicate URLs, private endpoints and unsafe metadata are rejected before ANY GitHub call', async t => {
  const cases = [
    sources => { sources[0].credentials = 'private-config'; },
    sources => { sources[0].url = 'http://example.com/free'; },
    sources => { sources[0].url = 'https://name:password@example.com/free'; },
    sources => { sources[0].url = 'https://127.0.0.1/free'; },
    sources => { sources[0].url = 'https://0x7f000001/free'; },
    sources => { sources[0].url = 'https://[::ffff:127.0.0.1]/free'; },
    sources => { sources[0].url = 'https://host.local/free'; },
    sources => { sources[0].url = 'https://metadata.internal/free'; },
    sources => { sources[0].url = 'https://example.com:9443/free'; },
    sources => { sources[0].url = 'https://example.com/free?api_key=hidden'; },
    sources => { sources[0].name = '/Users/private/runtime.log'; },
    sources => { sources[0].maxBytes = 4194305; },
    sources => { sources[0].allowedHosts = ['other.example.com']; },
    sources => { sources[0].allowedHosts = ['example.com', 'localhost']; },
    sources => { sources[0].discovery.extra = 'arbitrary model output'; },
    sources => { sources[0].discovery.homepageHash = 'not-proof'; },
    sources => { sources[0].discovery.identityQuote = 'ghp_' + 'a'.repeat(36); },
    sources => { sources[0].discovery.homepageUrl = 'https://localhost/'; },
    sources => { sources[0].discovery.discoveredAt = 'not-a-date'; },
    sources => { sources[0].discovery.query = 'x'.repeat(241); },
    sources => { sources.push({ ...structuredClone(sources[0]), id: 'another-id', url: 'https://example.com/free/?utm_source=search' }); },
    sources => { sources.push({ ...structuredClone(sources[0]), url: 'https://example.com/another-free-plan' }); },
  ];
  for (const mutate of cases) {
    const sources = sourceRegistry(); mutate(sources);
    const { root } = await fixture(t, { sources, config: { account: 'wonderl17', repository: 'wonderl17/perk-radar', branch: 'luke/main' } });
    let calls = 0;
    await assert.rejects(syncGithub({ root, runGh: async () => { calls++; return OLD; } }), /source data failed validation/);
    assert.equal(calls, 0);
  }
  assert.equal(validateSources(Array.from({ length: 501 }, (_, i) => ({ id: `source-${i}`, name: 'Official', kind: 'page', region: 'global', url: `https://example.com/${i}` }))), false);
});

test('a source registry read failure cannot publish an otherwise changed offers file', async t => {
  const { root } = await fixture(t, { sources: sourceRegistry() });
  const calls = [];
  await assert.rejects(syncGithub({ root, runGh: async (args, input) => {
    calls.push({ args, input });
    assert.equal(input, undefined);
    if (pathFrom(args).endsWith('sources.json')) throw new Error('private provider response');
    return OLD;
  } }), error => /read an existing public data file/.test(error.message) && !/private provider/.test(error.message));
  assert.equal(calls.length, 2);
});

test('a later registry conflict preserves completed offers update and exposes safe per-file progress without retry', async t => {
  const { root } = await fixture(t, { sources: sourceRegistry() });
  const calls = [];
  await assert.rejects(syncGithub({ root, runGh: async (args, input) => {
    calls.push({ args, input });
    if (!input) return OLD;
    if (pathFrom(args).endsWith('sources.json')) throw Object.assign(new Error('secret-token from registry provider'), { statusCode: 409 });
    return JSON.stringify({ commit: { sha: NEW, html_url: `https://github.com/wonderl17/perk-radar/commit/${NEW}` } });
  } }), error => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /changed concurrently/);
    assert(!error.message.includes('secret-token'));
    assert.deepEqual(error.completedFiles, [{ path: 'data/offers.json', updated: true, commitUrl: `https://github.com/wonderl17/perk-radar/commit/${NEW}` }]);
    return true;
  });
  assert.equal(calls.length, 4);
  assert(calls.slice(0, 2).every(call => !call.input), 'preflight completes before either PUT');
  assert.equal(calls.filter(call => call.input && pathFrom(call.args).endsWith('sources.json')).length, 1);
});
