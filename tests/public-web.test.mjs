import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchPublicText } from '../scripts/public-web.mjs';

const URL = 'https://official.example.com/free/';
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const lookupImpl = async () => PUBLIC;
function fakeRequests(responses = [{ body: '<main>Free credits</main>' }]) {
  const calls = [];
  const requestImpl = (url, options, callback) => {
    const req = new EventEmitter();
    const call = { url: url.href, options, destroyed: false };
    calls.push(call);
    let response;
    req.end = () => queueMicrotask(() => {
      if (call.destroyed) return;
      const result = typeof responses === 'function' ? responses(calls.length - 1) : responses.shift();
      if (!result) return;
      response = Readable.from(result.chunks ?? [Buffer.from(result.body ?? '')]);
      response.statusCode = result.status ?? 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8', ...result.headers };
      callback(response);
      if (result.aborted) queueMicrotask(() => response.emit('aborted'));
    });
    req.destroy = () => { call.destroyed = true; response?.destroy(); };
    return req;
  };
  return { calls, requestImpl };
}

test('public evidence uses validated DNS addresses at the TLS connection and sends no ambient credentials', async () => {
  const requests = fakeRequests();
  const answers = [...PUBLIC, { address: '2001:4860:4860::8888', family: 6 }];
  let lookups = 0;
  const result = await fetchPublicText(URL + '?campaign=offer#part', { lookupImpl: async (host, options) => {
    lookups++;
    assert.equal(host, 'official.example.com');
    assert.deepEqual(options, { all: true, verbatim: true });
    return answers;
  }, requestImpl: requests.requestImpl });
  assert.equal(result.text, '<main>Free credits</main>');
  assert.equal(result.url, URL + '?campaign=offer');
  assert.equal(lookups, 1);
  const options = requests.calls[0].options;
  assert.equal(options.agent, false);
  assert.equal(options.servername, 'official.example.com');
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  assert(!Object.keys(options.headers).some(key => /authorization|cookie|proxy/i.test(key)));
  const pinned = await new Promise((resolve, reject) => options.lookup('official.example.com', { all: true }, (error, values) => error ? reject(error) : resolve(values)));
  assert.deepEqual(pinned, answers);
  const single = await new Promise((resolve, reject) => options.lookup('official.example.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, PUBLIC[0]);
  assert.equal(lookups, 1, 'connection lookup must not resolve the host for a second time');
});

test('unsafe URL forms never perform DNS or network requests', async () => {
  for (const url of [
    'http://official.example.com/free', 'file:///etc/passwd', 'https://user:secret@official.example.com/free',
    'https://official.example.com:444/free', 'https://127.0.0.1/free', 'https://2130706433/free',
    'https://0x7f000001/free', 'https://[::1]/free', 'https://localhost/free', 'https://host.local/free',
    'https://host.internal/free', 'https://official.example.com./free', 'https://unknown.example.com/free',
  ]) {
    let touched = false;
    await assert.rejects(fetchPublicText(url, {
      allowedHosts: ['official.example.com'],
      lookupImpl: async () => { touched = true; return PUBLIC; },
      requestImpl: () => { touched = true; throw new Error('Must not request'); },
    }), /URL is not allowed/);
    assert.equal(touched, false, url);
  }
});

test('private, reserved, translated and mixed DNS answers cannot become requests', async () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.1', '192.0.2.1',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.254', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::808:808', '2001::1', '2001:2::1', '2001:db8::1', '2002:7f00:1::1', '3ffe::1', '3fff::1',
  ];
  for (const address of blocked) {
    const family = address.includes(':') ? 6 : 4;
    let requested = false;
    await assert.rejects(fetchPublicText(URL, {
      lookupImpl: async () => [...PUBLIC, { address, family }],
      requestImpl: () => { requested = true; throw new Error('Must not request'); },
    }), /DNS is not globally routable/);
    assert.equal(requested, false, address);
  }
});

test('ordinary globally routable IPv4 and IPv6 answers remain usable', async () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1', '2001:4860::1', '2606:4700:4700::1111', '2a00:1450::1']) {
    const requests = fakeRequests();
    const result = await fetchPublicText(URL, { lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }], requestImpl: requests.requestImpl });
    assert.equal(result.text, '<main>Free credits</main>');
  }
});

test('a redirect resolves its new host again and cannot escape the allowed policy', async () => {
  const requests = fakeRequests([{ status: 302, headers: { location: 'https://www.example.com/offer/' } }, { body: 'Public rules', headers: { 'content-type': 'text/plain' } }]);
  const seen = [];
  const result = await fetchPublicText(URL, {
    allowedHosts: ['official.example.com', 'www.example.com'],
    lookupImpl: async host => { seen.push(host); return PUBLIC; }, requestImpl: requests.requestImpl,
  });
  assert.equal(result.url, 'https://www.example.com/offer/');
  assert.deepEqual(seen, ['official.example.com', 'www.example.com']);
  const offsite = fakeRequests([{ status: 302, headers: { location: 'https://other.example.com/free' } }]);
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: offsite.requestImpl }), /redirect is not allowed/);
  assert.equal(offsite.calls.length, 1);
});

test('same-host redirects cannot rebind DNS to a private address', async () => {
  const requests = fakeRequests([{ status: 302, headers: { location: '/next' } }]);
  let count = 0;
  await assert.rejects(fetchPublicText(URL, {
    lookupImpl: async () => ++count === 1 ? PUBLIC : [{ address: '127.0.0.1', family: 4 }],
    requestImpl: requests.requestImpl,
  }), /DNS is not globally routable/);
  assert.equal(count, 2);
  assert.equal(requests.calls.length, 1);
});

test('redirects cannot introduce HTTP, credentials, IP literals or a nonstandard port', async () => {
  for (const location of ['http://official.example.com/free', 'https://user:secret@official.example.com/free', 'https://127.0.0.1/free', 'https://official.example.com:444/free']) {
    const requests = fakeRequests([{ status: 302, headers: { location } }]);
    await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: requests.requestImpl }), /redirect is not allowed/);
    assert.equal(requests.calls.length, 1);
  }
});

test('response bytes, media types and encoding remain bounded', async () => {
  const cases = [
    { body: 'large', headers: { 'content-length': '5' } },
    { chunks: [Buffer.from('ab'), Buffer.from('cd')] },
    { body: 'ok', headers: { 'content-type': 'image/svg+xml' } },
    { body: 'ok', headers: { 'content-type': undefined } },
    { body: 'ok', headers: { 'content-encoding': 'gzip' } },
    { body: 'ok', headers: { 'content-length': 'invalid' } },
  ];
  for (const response of cases) {
    const requests = fakeRequests([response]);
    await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: requests.requestImpl, maxBytes: 3 }), /unsupported|too large/);
    assert.equal(requests.calls[0].destroyed, true);
  }
  for (const type of ['application/rss+xml', 'application/atom+xml', 'application/json', 'application/xml', 'application/xhtml+xml']) {
    const requests = fakeRequests([{ body: '{}', headers: { 'content-type': type } }]);
    assert.equal((await fetchPublicText(URL, { lookupImpl, requestImpl: requests.requestImpl })).text, '{}');
  }
});

test('redirect loops have a finite request count', async () => {
  const requests = fakeRequests(() => ({ status: 302, headers: { location: '/again' } }));
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: requests.requestImpl }), /redirect limit exceeded/);
  assert.equal(requests.calls.length, 6);
});

test('timeouts cover DNS and network waits and late DNS completion cannot issue a request', async () => {
  let requested = false;
  await assert.rejects(fetchPublicText(URL, {
    timeoutMs: 5,
    lookupImpl: () => new Promise(resolve => setTimeout(() => resolve(PUBLIC), 20)),
    requestImpl: () => { requested = true; throw new Error('Must not request'); },
  }), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(requested, false);
  const requests = fakeRequests([]);
  await assert.rejects(fetchPublicText(URL, { timeoutMs: 5, lookupImpl, requestImpl: requests.requestImpl }), /timed out/);
  assert.equal(requests.calls[0].destroyed, true);
});

test('connection, HTTP and body failures cannot echo secret response or exception text', async () => {
  await assert.rejects(fetchPublicText(URL, { lookupImpl: async () => { throw new Error('private-token-123'); } }), error => !error.message.includes('private-token-123'));
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: () => { throw new Error('private-token-123'); } }), error => error.message === 'Public source request failed.');
  for (const response of [{ status: 403, body: 'private-token-123' }, { body: 'ok', aborted: true }]) {
    const requests = fakeRequests([response]);
    await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: requests.requestImpl }), error => error.message === 'Public source request failed.');
  }
});

test('transport errors expose only fixed diagnostic codes while preserving the same request boundaries', async () => {
  const hasCode = code => error => error.code === code && !error.message.includes('private-token-123');
  await assert.rejects(fetchPublicText(URL, { lookupImpl: async () => { throw new Error('private-token-123'); } }), hasCode('SOURCE_DNS'));
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: () => { throw new Error('private-token-123'); } }), hasCode('SOURCE_NETWORK'));
  const http = fakeRequests([{ status: 503, body: 'private-token-123' }]);
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: http.requestImpl }), hasCode('SOURCE_HTTP'));
  const unsupported = fakeRequests([{ body: 'private-token-123', headers: { 'content-type': 'application/octet-stream' } }]);
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: unsupported.requestImpl }), hasCode('SOURCE_RESPONSE'));
  const redirected = fakeRequests([{ status: 302, headers: { location: 'https://other.example.com/' } }]);
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: redirected.requestImpl }), hasCode('SOURCE_POLICY'));
  assert.equal(redirected.calls.length, 1);
  const stalled = fakeRequests([]);
  await assert.rejects(fetchPublicText(URL, { lookupImpl, requestImpl: stalled.requestImpl, timeoutMs: 1 }), hasCode('SOURCE_TIMEOUT'));
  await assert.rejects(fetchPublicText(URL, { timeoutMs: 0 }), hasCode('SOURCE_CONFIG'));
});

test('invalid fetch limits and host policies are rejected before network access', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 120001 }, { maxBytes: 0 }, { maxBytes: 4_194_305 }, { allowedHosts: [] }, { allowedHosts: ['official.example.com', 1] }]) {
    await assert.rejects(fetchPublicText(URL, { ...options, lookupImpl: () => { throw new Error('Must not resolve'); } }), /invalid/);
  }
});
