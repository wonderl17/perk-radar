import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGithub } from '../scripts/sync-github.mjs';

const OLD = '1'.repeat(40), NEW = '2'.repeat(40);
function dataset() {
  return { schemaVersion: 1, updatedAt: '2026-10-26T08:00:00Z', offers: [{ id: 'official-free-plan', title: '官方免费计划', provider: 'Example', summary: '可以申请基础免费权益。', benefit: '免费基础额度', category: 'ai', regions: ['global'], availability: '限官方支持的地区', eligibility: ['注册账号'], steps: ['查看官方页面'], caveats: ['额度及限制以官方为准'], tags: ['免费'], publishedAt: null, discoveredAt: '2026-10-25T08:00:00Z', verifiedAt: '2026-10-26T08:00:00Z', expiresAt: null, offerType: 'ongoing', source: { name: 'Example 官方', url: 'https://example.com/free', evidence: '官方页面列出免费基础套餐。' }, status: 'published' }] };
}
async function fixture(t, { document = dataset(), config = { repository: 'wonderl17/perk-radar', branch: 'luke/main' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perk-github-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(join(root, 'data/offers.json'), bytes);
  await writeFile(join(root, 'data/github.json'), JSON.stringify(config));
  return { root, bytes };
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
