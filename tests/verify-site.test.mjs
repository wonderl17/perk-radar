import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySite } from '../scripts/verify-site.mjs';

const COMMIT = 'a'.repeat(40), NEXT = 'b'.repeat(40);
const ORIGIN = 'https://perk-radar.vercel.app';
const DEPLOYMENT = 'https://vercel.com/public-team/perk-radar/deployment123';
const nowFn = () => '2026-10-29T00:00:00Z';
const dataset = () => ({ schemaVersion: 1, updatedAt: '2026-10-28T10:00:00Z', offers: [] });
const rss = (link = ORIGIN) => `<?xml version="1.0"?><rss version="2.0"><channel><title>福利雷达</title><link>${link}</link><item><title>官方福利</title><link>${ORIGIN}</link></item></channel></rss>`;

async function fixture(t, { config = { repository: 'wonderl17/perk-radar', account: 'wonderl17', branch: 'luke/main' }, siteUrl = ORIGIN, document = dataset() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perk-site-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/github.json'), JSON.stringify(config));
  await writeFile(join(root, 'data/site.json'), JSON.stringify({ siteUrl }));
  await writeFile(join(root, 'data/offers.json'), JSON.stringify(document));
  return { root, document };
}

function github({ login = 'wonderl17', state = 'success', statuses, head = () => COMMIT } = {}) {
  const calls = []; let reads = 0;
  const runGh = async (args, input) => {
    calls.push(args);
    assert.equal(input, undefined, 'verification must never send a remote mutation');
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    if (args[3] === 'user') {
      assert.equal(calls.length, 1, 'account identity must be the first remote access');
      assert.deepEqual(args.slice(4), ['--jq', '.login']);
      return login;
    }
    assert.equal(calls[0][3], 'user');
    if (args[3] === 'repos/wonderl17/perk-radar/git/ref/heads/luke%2Fmain') {
      assert.deepEqual(args.slice(4), ['--jq', '.object.sha']);
      return head(++reads);
    }
    assert.equal(args[3], `repos/wonderl17/perk-radar/commits/${COMMIT}/status?per_page=100`);
    return JSON.stringify({ sha: COMMIT, state: 'success', statuses: statuses ?? [{ context: 'Vercel', state, target_url: DEPLOYMENT }] });
  };
  return { runGh, calls };
}

function website(document, { homepage = '<!doctype html><title>福利雷达 · Perk Radar</title>', offers = JSON.stringify(document), feed = rss(), status = 200, onFetch } = {}) {
  const calls = [];
  const fetchPageImpl = async (url, options) => {
    calls.push(url);
    assert.deepEqual(options.allowedHosts, ['perk-radar.vercel.app']);
    assert(options.timeoutMs >= 12000 && options.timeoutMs <= 20000);
    assert(options.maxBytes <= 5 * 1_048_576);
    await onFetch?.(url);
    const text = { '/': homepage, '/data/offers.json': offers, '/feed.xml': feed }[new URL(url).pathname];
    assert.equal(typeof text, 'string');
    return { text, url, status };
  };
  return { fetchPageImpl, calls };
}

test('success verifies the bound account, latest Vercel status and three public artifacts without writing', async t => {
  const { root, document } = await fixture(t);
  const gh = github();
  const web = website(document, { offers: JSON.stringify({ offers: [], updatedAt: document.updatedAt, schemaVersion: 1 }, null, 2) });
  const result = await verifySite({ root, ...gh, ...web, nowFn });
  assert.deepEqual(result, { status: 'success', commit: COMMIT, deploymentUrl: DEPLOYMENT, checks: {
    githubAccount: true, vercel: 'success', homepage: true, offers: true, rss: true, localSnapshot: true, branchStable: true,
  } });
  assert.equal(gh.calls.length, 4);
  assert.deepEqual(web.calls, [`${ORIGIN}/`, `${ORIGIN}/data/offers.json`, `${ORIGIN}/feed.xml`]);
});

test('account mismatch stops before any repository access or public request', async t => {
  const { root, document } = await fixture(t);
  const gh = github({ login: 'another-account' }), web = website(document);
  const result = await verifySite({ root, ...gh, ...web, nowFn });
  assert.deepEqual(result, { status: 'failed', checks: { githubAccount: false }, code: 'ACCOUNT_MISMATCH' });
  assert.equal(gh.calls.length, 1);
  assert.equal(web.calls.length, 0);
});

test('a missing account binding, invalid repository or unsafe origin fails before remote access', async t => {
  const cases = [
    { config: { repository: 'wonderl17/perk-radar', branch: 'luke/main' } },
    { config: { repository: 'wonderl17/perk-radar?private', branch: 'luke/main', account: 'wonderl17' } },
    ...['http://example.com', 'https://user:password@example.com', 'https://localhost', 'https://127.0.0.1', 'https://host.internal', 'https://example.com:9443'].map(siteUrl => ({ siteUrl })),
  ];
  for (const options of cases) {
    const { root } = await fixture(t, options);
    let touched = false;
    const fail = () => { touched = true; throw new Error('Must not be called'); };
    assert.equal((await verifySite({ root, runGh: fail, fetchPageImpl: fail, nowFn })).code, 'LOCAL_DATA_INVALID');
    assert.equal(touched, false);
  }
});

test('pending and unrelated successful checks cannot report a deployment success', async t => {
  for (const state of ['pending', 'queued', 'in_progress', 'in progress', 'unknown']) {
    const { root, document } = await fixture(t);
    const gh = github({ state }), web = website(document);
    const result = await verifySite({ root, ...gh, ...web, nowFn });
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'DEPLOYMENT_PENDING');
    assert.equal(result.checks.vercel, 'pending');
    assert.equal(web.calls.length, 0);
  }
  const { root, document } = await fixture(t);
  const gh = github({ statuses: [{ context: 'CI / Vercel smoke test', state: 'success' }, { context: 'Vercel – another-project', state: 'success' }] });
  const web = website(document);
  assert.equal((await verifySite({ root, ...gh, ...web, nowFn })).status, 'pending');
  assert.equal(web.calls.length, 0);
});

test('only the newest status in a Vercel context counts; a later pending status blocks old success', async t => {
  const { root, document } = await fixture(t);
  for (const [state, expected] of [['pending', 'pending'], ['failure', 'failed'], ['success', 'success']]) {
    const gh = github({ statuses: [
      { id: 1, context: 'Vercel', state: 'success', updated_at: '2026-10-28T00:00:00Z' },
      { id: 2, context: 'Vercel', state, updated_at: '2026-10-28T01:00:00Z' },
      { id: 3, context: 'CI', state: 'success' },
    ] });
    assert.equal((await verifySite({ root, ...gh, ...website(document), nowFn })).status, expected);
  }
});

test('Vercel error or failure remains failed even when the old public website would match', async t => {
  for (const state of ['error', 'failure']) {
    const { root, document } = await fixture(t);
    const web = website(document);
    const result = await verifySite({ root, ...github({ state }), ...web, nowFn });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'DEPLOYMENT_FAILED');
    assert.equal(web.calls.length, 0);
  }
});

test('old data, an incorrect homepage title and a wrong RSS channel link each fail verification', async t => {
  const { root, document } = await fixture(t);
  const cases = [
    { options: { offers: JSON.stringify({ ...document, updatedAt: '2026-10-27T00:00:00Z' }) }, check: 'offers' },
    { options: { homepage: '<title>Another app</title><h1>福利雷达</h1>' }, check: 'homepage' },
    { options: { homepage: '<!-- <title>福利雷达</title> --><script>"<title>福利雷达</title>"</script>' }, check: 'homepage' },
    { options: { feed: rss('https://old.example.com') }, check: 'rss' },
    { options: { feed: `<rss><channel><item><link>${ORIGIN}</link></item></channel></rss>` }, check: 'rss' },
    { options: { feed: `<rss><channel><description><link>${ORIGIN}</link></description></channel></rss>` }, check: 'rss' },
  ];
  for (const { options, check } of cases) {
    const result = await verifySite({ root, ...github(), ...website(document, options), nowFn });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'SITE_MISMATCH');
    assert.equal(result.checks[check], false);
  }
});

test('only explicit HTTP 200 responses on the configured origin can pass', async t => {
  const { root, document } = await fixture(t);
  for (const status of [204, 206, undefined]) {
    const web = website(document, { status });
    const fetchPageImpl = async (...args) => ({ ...await web.fetchPageImpl(...args), status });
    assert.equal((await verifySite({ root, ...github(), fetchPageImpl, nowFn })).status, 'failed');
  }
  const web = website(document);
  const fetchPageImpl = async (...args) => ({ ...await web.fetchPageImpl(...args), url: 'https://other.example.com/' });
  assert.equal((await verifySite({ root, ...github(), fetchPageImpl, nowFn })).status, 'failed');
});

test('production branch advancing during a mismatched response returns pending instead of stale failure', async t => {
  const { root, document } = await fixture(t);
  const result = await verifySite({ root, ...github({ head: read => read === 1 ? COMMIT : NEXT }), ...website(document, { offers: '{}' }), nowFn });
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'BRANCH_CHANGED');
  assert.equal(result.checks.branchStable, false);
});

test('a concurrent local update during HTTP returns pending, including changed configuration bytes', async t => {
  for (const path of ['data/offers.json', 'data/site.json', 'data/github.json']) {
    const { root, document } = await fixture(t);
    const web = website(document, { onFetch: async url => {
      if (new URL(url).pathname === '/') await writeFile(join(root, path), '{"changedDuringVerification":true}');
    } });
    const result = await verifySite({ root, ...github(), ...web, nowFn });
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'LOCAL_CHANGED');
    assert.equal(result.checks.localSnapshot, false);
  }
});

test('CLI and public-page failures expose only fixed codes and never reflect secret messages or bodies', async t => {
  const { root, document } = await fixture(t);
  const secret = 'ghp_private-secret-token-from-provider';
  const gh = github();
  const githubFailure = await verifySite({ root, runGh: args => args[3] === 'user' ? gh.runGh(args) : Promise.reject(new Error(secret)), nowFn });
  assert.equal(githubFailure.code, 'GITHUB_UNAVAILABLE');
  assert(!JSON.stringify(githubFailure).includes(secret));
  for (const fetchPageImpl of [() => { throw new Error(secret); }, async () => { throw new Error(secret); }, async url => ({ url, status: 200, text: secret })]) {
    const result = await verifySite({ root, ...github(), fetchPageImpl, nowFn });
    assert.equal(result.status, 'failed');
    assert(!JSON.stringify(result).includes(secret));
  }
  for (const target_url of [`https://user:${secret}@vercel.com/team/perk-radar/deploy`, `https://vercel.com/team/perk-radar/deploy?token=${secret}`, `https://evil.example.com/${secret}`]) {
    const result = await verifySite({ root, ...github({ statuses: [{ context: 'Vercel', state: 'success', target_url, description: secret }] }), ...website(document), nowFn });
    assert.equal(result.status, 'success');
    assert.equal(result.deploymentUrl, undefined);
    assert(!JSON.stringify(result).includes(secret));
  }
});
