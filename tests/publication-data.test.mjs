import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePublication, publicationDateSupported } from '../scripts/publication-data.mjs';
import { validateOffers } from '../scripts/lib.mjs';

const NOW = Date.parse('2026-10-28T03:00:00Z');
const DISCOVERED = '2026-10-26T10:20:30Z';
const options = { now: NOW, discoveredAt: DISCOVERED };
function publication(overrides = {}) {
  return { value: '2024-02-29', precision: 'day', certainty: 'exact', basis: 'published', evidence: [{ url: 'https://example.com/launch', quote: 'Published February 29, 2024.' }], reasoning: '官方公告明确说明这项福利的发布日期。', assessedAt: '2026-10-28T03:00:00Z', method: 'gpt-web-search', model: 'test-gpt', ...overrides };
}
function unknown(overrides = {}) { return publication({ value: null, precision: null, certainty: 'unknown', basis: null, evidence: [], reasoning: '未找到能确认这项福利发布时间的公开依据。', ...overrides }); }

test('publication metadata distinguishes exact, approximate, available_by and unknown dates', () => {
  for (const value of [publication(), publication({ value: '2024', precision: 'year', certainty: 'approximate' }), publication({ value: '2024-02', precision: 'month', certainty: 'approximate' }), publication({ basis: 'available_by', certainty: 'approximate' }), unknown(), unknown({ method: 'manual', model: undefined })]) assert.deepEqual(validatePublication(value, options), []);
  assert(validatePublication(publication({ value: '2024', precision: 'year' }), options).some(error => /approximate/.test(error)));
  assert(validatePublication(publication({ basis: 'available_by' }), options).some(error => /approximate/.test(error)));
  assert(validatePublication(unknown({ value: '2024' }), options).some(error => /null/.test(error)));
});

test('publication dates reject calendar normalization, mismatched precision and invented seconds', () => {
  for (const [value, precision] of [['2023-02-29', 'day'], ['2024-02-30', 'day'], ['2024-04-31', 'day'], ['2024-00', 'month'], ['2024-13', 'month'], ['1969', 'year'], ['2024-2', 'month'], ['2024-02-29', 'month'], ['2024-02-29T12:00:00Z', 'minute'], ['2024-02-29T24:00Z', 'minute'], ['2024-02-29T12:60Z', 'minute'], ['2024-02-29T12:00+25:00', 'minute'], ['2024-02-29T12:00+14:01', 'minute'], ['2024-02-29T12:00-00:00', 'minute'], ['2024-02-29T12:00', 'minute']]) {
    assert(validatePublication(publication({ value, precision, certainty: 'approximate' }), options).some(error => /real date/.test(error)), `${precision}: ${value}`);
  }
  assert.deepEqual(validatePublication(publication({ value: '2024-02-29T12:30+08:00', precision: 'minute' }), options), []);
});

test('future and first-discovery boundaries use Shanghai calendar precision and exact instants', () => {
  const edge = { now: Date.parse('2026-10-27T16:05:00Z'), discoveredAt: '2026-10-26T16:05:00Z' };
  for (const [value, precision] of [['2026', 'year'], ['2026-10', 'month'], ['2026-10-27', 'day'], ['2026-10-27T00:05+08:00', 'minute']]) assert.deepEqual(validatePublication(publication({ value, precision, certainty: 'approximate', assessedAt: '2026-10-27T16:05:00Z' }), edge), []);
  assert(validatePublication(publication({ value: '2026-10-28', precision: 'day' }), edge).some(error => /first discovery/.test(error)));
  assert(validatePublication(publication({ value: '2026-10-27T00:06+08:00', precision: 'minute' }), edge).some(error => /first discovery/.test(error)));
  for (const [value, precision] of [['2027', 'year'], ['2026-11', 'month'], ['2026-10-29', 'day'], ['2026-10-28T00:06+08:00', 'minute']]) assert(validatePublication(publication({ value, precision, certainty: 'approximate' }), { now: edge.now }).some(error => /future/.test(error)), value);
});

test('publication metadata bounds public evidence and disallows extra fields or missing model', () => {
  const bad = [null, [], {}, publication({ privateKey: 'forbidden' }), publication({ model: undefined }), publication({ model: ' ' }), publication({ reasoning: '' }), publication({ reasoning: 'a'.repeat(601) }), publication({ evidence: [] }), publication({ evidence: Array(4).fill(publication().evidence[0]) }), publication({ evidence: [{ url: 'http://example.com', quote: '2024-02-29' }] }), publication({ evidence: [{ url: 'https://user:secret@example.com', quote: '2024-02-29' }] }), publication({ evidence: [{ url: 'https://example.com/' + 'a'.repeat(2000), quote: '2024-02-29' }] }), publication({ evidence: [{ url: 'https://example.com/\nlaunch', quote: '2024-02-29' }] }), publication({ evidence: [{ url: 'https://example.com', quote: 'ab' }] }), publication({ evidence: [{ url: 'https://example.com', quote: 'a'.repeat(261) }] }), publication({ evidence: [{ url: 'https://example.com', quote: '2024-02-29', rawResponse: 'forbidden' }] })];
  for (const value of bad) assert(validatePublication(value, options).length > 0, JSON.stringify(value));
  assert.deepEqual(validatePublication(publication({ method: 'manual', model: undefined }), options), []);
});

test('assessment timestamps require real calendars and allow at most five minutes clock skew', () => {
  for (const assessedAt of ['2026-02-30T12:00:00Z', '2026-10-28', '2026-10-28T12:00:00', '2026-10-28T03:05:01Z']) assert(validatePublication(unknown({ assessedAt }), options).some(error => /assessedAt/.test(error)), assessedAt);
  assert.deepEqual(validatePublication(unknown({ assessedAt: '2026-10-28T03:05:00Z' }), options), []);
});

test('public evidence rejects local hosts and IP literals before any DNS request', () => {
  for (const url of ['https://localhost/news', 'https://intranet/news', 'https://api.internal/news', 'https://app.local/news', 'https://localhost.localdomain/news', 'https://app.home/news', 'https://app.lan/news', 'https://127.0.0.1/news', 'https://10.1.2.3/news', 'https://8.8.8.8/news', 'https://[::1]/news', 'https://[2606:4700:4700::1111]/news', 'https://2130706433/news', 'https://0x7f000001/news', 'https://example.com./news']) {
    assert(validatePublication(publication({ evidence: [{ url, quote: 'Published February 29, 2024.' }] }), options).some(error => /evidence/.test(error)), url);
  }
  assert.deepEqual(validatePublication(publication({ evidence: [{ url: 'https://news.example.com/2024/02/29', quote: 'Published February 29, 2024.' }] }), options), []);
});

test('quoted dates support ISO, Chinese and English months without inventing precision', () => {
  for (const quote of ['Published 2024-02-29.', '发布日期：２０２４年２月２９日。', 'February 29, 2024', 'February 29,2024', '29 February 2024', 'Feb. 29th, 2024', '29th Feb. 2024', '2024/02/29']) {
    assert.equal(publicationDateSupported('2024-02-29', 'day', quote), true, quote);
    assert.equal(publicationDateSupported('2024-02', 'month', quote), true, quote);
    assert.equal(publicationDateSupported('2024', 'year', quote), true, quote);
  }
  for (const quote of ['February 2024', '2024年2月', '2024-02']) {
    assert.equal(publicationDateSupported('2024-02', 'month', quote), true, quote);
    assert.equal(publicationDateSupported('2024-02-01', 'day', quote), false, quote);
  }
  assert.equal(publicationDateSupported('2024', 'year', 'First announced in 2024.'), true);
  assert.equal(publicationDateSupported('2024-02', 'month', 'First announced in 2024.'), false);
  for (const quote of ['2024-02-30', 'February 30, 2024', '2024年2月30日', '20240229', '2024-02-28', '2024-02-290']) assert.equal(publicationDateSupported('2024-02-29', 'day', quote), false, quote);
});

test('minute quotes require a complete calendar date and explicit timezone, compared by instant', () => {
  for (const quote of ['2024-02-29T12:30:59+08:00', '2024年2月29日 12:30 北京时间', '2024年2月29日12:30北京时间', 'February 29, 2024 at 4:30 AM UTC', '29 February 2024 04:30 GMT', '2024-02-29T0430Z']) assert.equal(publicationDateSupported('2024-02-29T04:30Z', 'minute', quote), quote !== '2024-02-29T0430Z', quote);
  for (const quote of ['2024-02-29 04:30', 'February 29, 2024', '2024-02-29T04:31Z', '2024-02-30T04:30Z', '2024-02-29T24:30Z', '2024-02-29T04:30+25:00', '2024-02-29T04:30-00:00']) assert.equal(publicationDateSupported('2024-02-29T04:30Z', 'minute', quote), false, quote);
});

test('offer validation accepts legacy records and independently checks optional publication metadata', () => {
  const offer = { id: 'free-plan', title: '免费计划', provider: 'Example', summary: '基础免费权益', benefit: '免费额度', category: 'developer', regions: ['global'], availability: '限支持的地区', eligibility: ['注册账号'], steps: ['查看官方规则'], caveats: ['领取前核对'], tags: [], publishedAt: null, discoveredAt: DISCOVERED, verifiedAt: '2026-10-28T03:00:00Z', expiresAt: null, offerType: 'ongoing', source: { name: '官方', url: 'https://example.com/free', evidence: '官方页面说明基础免费权益' }, status: 'published' };
  const document = offers => ({ schemaVersion: 1, updatedAt: '2026-10-28T03:00:00Z', offers });
  assert.deepEqual(validateOffers(document([offer]), { now: NOW }), []);
  assert.deepEqual(validateOffers(document([{ ...offer, publication: publication() }]), { now: NOW }), []);
  assert(validateOffers(document([{ ...offer, publication: unknown({ value: '2024' }) }]), { now: NOW }).some(error => /publication/.test(error)));
  assert.equal(offer.publishedAt, null);
});
