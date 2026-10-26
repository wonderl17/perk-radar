export const categories = {
  all: { label: '全部福利', icon: 'grid' },
  ai: { label: 'AI 与效率', icon: 'sparkles' },
  developer: { label: '开发者工具', icon: 'code' },
  learning: { label: '学习与成长', icon: 'book' },
  life: { label: '生活与娱乐', icon: 'coffee' },
};
export const DAY = 86400000;
export function verificationLabel(offer) {
  return offer.verification?.method === 'gpt' ? 'GPT 自动核验' : '人工核验';
}
export function statusOf(offer, now = Date.now()) {
  if (offer.status === 'withdrawn') return 'withdrawn';
  if (offer.expiresAt && Date.parse(offer.expiresAt) <= now) return 'expired';
  if (offer.reviewRequired === true) return 'stale';
  if (now - Date.parse(offer.verifiedAt) > 7 * DAY) return 'stale';
  return 'active';
}
export function isEnding(offer, now = Date.now()) {
  return offer.status === 'published' && !!offer.expiresAt && Date.parse(offer.expiresAt) > now && Date.parse(offer.expiresAt) <= now + 7 * DAY;
}
export function filterOffers(offers, filters = {}, now = Date.now()) {
  const { query = '', category = 'all', region = 'all', type = 'all', view = 'all', saved = [], sort = 'latest' } = filters;
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return offers.filter(offer => {
    const state = statusOf(offer, now);
    if (state === 'withdrawn') return false;
    if (view === 'saved' && !saved.includes(offer.id)) return false;
    if (view === 'ending' && !isEnding(offer, now)) return false;
    if (view === 'archive' && state !== 'expired') return false;
    if (view !== 'archive' && view !== 'saved' && state === 'expired') return false;
    if (category !== 'all' && offer.category !== category) return false;
    if (region !== 'all' && !offer.regions.includes(region)) return false;
    if (type !== 'all' && offer.offerType !== type) return false;
    const haystack = [offer.title, offer.provider, offer.summary, offer.benefit, offer.availability, ...(offer.tags || [])].join(' ').toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  }).sort((a, b) => {
    if (sort === 'ending') return (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) || Date.parse(b.discoveredAt) - Date.parse(a.discoveredAt);
    return Date.parse(b.discoveredAt) - Date.parse(a.discoveredAt);
  });
}
export function dateKey(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export function dateLabel(value, options = {}) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', ...options }).format(new Date(value));
}
export function groupByDay(offers) {
  const groups = [];
  for (const offer of offers) {
    const key = dateKey(offer.discoveredAt);
    const previous = groups.at(-1);
    if (previous?.key === key) previous.offers.push(offer);
    else groups.push({ key, date: offer.discoveredAt, offers: [offer] });
  }
  return groups;
}
