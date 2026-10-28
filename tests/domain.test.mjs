import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOffers, statusOf, isEnding, dateKey, verificationLabel, publicationLabel } from '../src/domain.mjs';
const now = Date.parse('2026-10-26T10:00:00Z');
const base = { id: 'one', title: 'AI 积分', provider: 'Manus', summary: '', benefit: '', availability: '', tags: [], category: 'ai', regions: ['global'], status: 'published', offerType: 'ongoing', discoveredAt: '2026-10-26T09:00:00Z', verifiedAt: '2026-10-26T09:00:00Z', publishedAt: null, expiresAt: null };
test('expiry wins over stale verification, withdrawn never leaks to feed', () => {
  const expired = { ...base, id: 'expired', expiresAt: '2026-10-25T23:00:00Z', verifiedAt: '2026-10-01T00:00:00Z' };
  const withdrawn = { ...base, id: 'withdrawn', status: 'withdrawn' };
  assert.equal(statusOf(expired, now), 'expired');
  assert.deepEqual(filterOffers([base, expired, withdrawn], {}, now).map(x => x.id), ['one']);
  assert.deepEqual(filterOffers([base, expired, withdrawn], { view: 'archive' }, now).map(x => x.id), ['expired']);
});
test('stale data stays visible with explicit status, unknown deadline never becomes ending soon', () => {
  assert.equal(statusOf({ ...base, verifiedAt: '2026-10-18T09:00:00Z' }, now), 'stale');
  assert.equal(isEnding(base, now), false);
  assert.equal(isEnding({ ...base, expiresAt: '2026-10-30T10:00:00Z' }, now), true);
  assert.equal(isEnding({ ...base, expiresAt: '2026-11-30T10:00:00Z' }, now), false);
});
test('filters intersect and multiword search matches provider and title', () => {
  assert.equal(filterOffers([base], { query: 'manus 积分', region: 'global', category: 'ai' }, now).length, 1);
  assert.equal(filterOffers([base], { region: 'cn' }, now).length, 0);
  assert.equal(filterOffers([base], { view: 'saved', saved: ['one'] }, now).length, 1);
  assert.equal(filterOffers([base], { view: 'saved', saved: [] }, now).length, 0);
});
test('timeline uses first discovery, Shanghai date and deadline ordering keeps unknown last', () => {
  assert.equal(dateKey('2026-10-25T18:00:00Z'), '2026-10-26');
  const ending = { ...base, id: 'two', expiresAt: '2026-10-28T10:00:00Z', discoveredAt: '2026-10-25T00:00:00Z' };
  assert.deepEqual(filterOffers([ending, base], {}, now).map(x => x.id), ['one', 'two']);
  assert.deepEqual(filterOffers([base, ending], { sort: 'ending' }, now).map(x => x.id), ['two', 'one']);
});
test('saved offers remain accessible after expiry, with expired status', () => {
  const expired = { ...base, expiresAt: '2026-10-25T23:00:00Z' };
  assert.equal(filterOffers([expired], { view: 'saved', saved: ['one'] }, now).length, 1);
  assert.equal(statusOf(expired, now), 'expired');
});
test('official publication date is not an offer activation date', () => {
  assert.equal(statusOf({ ...base, publishedAt: '2026-10-28T09:00:00Z' }, now), 'active');
});

test('verification provenance distinguishes GPT from legacy manual records without changing freshness', () => {
  const automatic = { ...base, verification: { method: 'gpt', model: 'hermes-model', verifiedAt: base.verifiedAt, evidenceHash: 'evidence-hash', evidenceQuotes: [{ field: 'benefit', quote: '300 credits' }] } };
  assert.equal(verificationLabel(base), '人工核验');
  assert.equal(verificationLabel(automatic), 'GPT 自动核验');
  assert.equal(statusOf(automatic, now), statusOf(base, now));
  assert.equal(statusOf({ ...automatic, verifiedAt: '2026-10-18T09:00:00Z' }, now), 'stale');
});

test('a new rule-review flag overrides a fresh verification, while expiry and withdrawal still take precedence', () => {
  const flagged = { ...base, reviewRequired: true, reviewRequestedAt: base.verifiedAt, reviewNote: '官方规则已变化，需要重新确认。' };
  assert.equal(statusOf(flagged, now), 'stale');
  assert.equal(statusOf({ ...flagged, expiresAt: '2026-10-25T23:00:00Z' }, now), 'expired');
  assert.equal(statusOf({ ...flagged, status: 'withdrawn' }, now), 'withdrawn');
  assert.equal(statusOf({ ...base, reviewRequired: false }, now), 'active');
  assert.equal(filterOffers([flagged], {}, now).length, 1, 'a disputed rule remains visible with a stale label rather than disappearing');
});

const publication = (overrides = {}) => ({ value: '2025-03-12', precision: 'day', certainty: 'exact', basis: 'published', evidence: [{ url: 'https://example.com/news', quote: 'Published March 12, 2025.' }], reasoning: '公告标有发布日期。', assessedAt: '2026-10-26T09:00:00Z', method: 'gpt-web-search', ...overrides });

test('publication dates preserve supported precision and visibly mark estimates', () => {
  const label = overrides => publicationLabel({ ...base, publication: publication(overrides) });
  assert.equal(label({ value: '2025', precision: 'year', certainty: 'approximate' }), '消息发布：约2025年');
  assert.equal(label({ value: '2025-03', precision: 'month', certainty: 'approximate' }), '消息发布：约2025年3月');
  assert.equal(label({ value: '2025-03', precision: 'month' }), '消息发布：约2025年3月', 'month-level evidence must never look exact');
  assert.equal(label({}), '消息发布：2025年3月12日');
  assert.equal(label({ certainty: 'approximate' }), '消息发布：约2025年3月12日');
});

test('minute precision converts timezone offsets and day boundaries to Beijing time', () => {
  assert.equal(publicationLabel({ ...base, publication: publication({ value: '2025-03-11T18:07:00Z', precision: 'minute' }) }), '消息发布：2025年3月12日 02:07（北京时间）');
  assert.equal(publicationLabel({ ...base, publication: publication({ value: '2024-12-31T12:05:00-08:00', precision: 'minute' }) }), '消息发布：2025年1月1日 04:05（北京时间）');
});

test('available-by evidence states an upper bound without inventing a launch date', () => {
  assert.equal(publicationLabel({ ...base, publication: publication({ value: '2025-03', precision: 'month', certainty: 'approximate', basis: 'available_by' }) }), '最晚已于2025年3月存在（发布时间估计）');
  assert.equal(publicationLabel({ ...base, publication: publication({ basis: 'available_by', certainty: 'approximate' }) }), '最晚已于2025年3月12日存在（发布时间估计）');
});

test('unknown assessment supersedes legacy publication; absent assessments retain full legacy date', () => {
  const legacy = { ...base, publishedAt: '2025-03-11T18:00:00Z' };
  assert.equal(publicationLabel(legacy), '消息发布：2025年3月12日');
  assert.equal(publicationLabel(base), '消息发布时间：待查证');
  assert.equal(publicationLabel({ ...legacy, publication: publication({ value: null, precision: null, certainty: 'unknown', basis: null, evidence: [] }) }), '消息发布时间：未知');
});

test('invalid publication dates display unknown without rolling into a different date', () => {
  for (const overrides of [{ value: '2025-02-29' }, { value: '2025-04-31' }, { value: '2025-13', precision: 'month' }, { value: '2025-03-12T12:30', precision: 'minute' }, { value: null }]) {
    assert.equal(publicationLabel({ ...base, publication: publication(overrides) }), '消息发布时间：未知');
  }
  assert.equal(publicationLabel({ ...base, publication: publication({ value: '2024-02-29' }) }), '消息发布：2024年2月29日');
});

test('publication estimates cannot change first-discovery ordering or verification freshness', () => {
  const newerDiscovery = { ...base, publication: publication({ value: '2020', precision: 'year', certainty: 'approximate' }) };
  const olderDiscovery = { ...base, id: 'older', discoveredAt: '2026-10-25T09:00:00Z', publication: publication({ value: '2026-10-25' }) };
  assert.deepEqual(filterOffers([olderDiscovery, newerDiscovery], {}, now).map(item => item.id), ['one', 'older']);
  assert.equal(statusOf(newerDiscovery, now), statusOf(base, now));
});
