import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOffers, statusOf, isEnding, dateKey, verificationLabel } from '../src/domain.mjs';
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
