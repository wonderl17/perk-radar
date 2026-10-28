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
function publicationDateText(value, precision) {
  if (typeof value !== 'string') return null;
  if (precision === 'year' && /^[1-9]\d{3}$/.test(value)) return `${value}年`;
  if (precision === 'month' && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) return `${value.slice(0, 4)}年${Number(value.slice(5))}月`;
  if (precision === 'day' && /^[1-9]\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
    return `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`;
  }
  if (precision === 'minute' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${fields.year}年${Number(fields.month)}月${Number(fields.day)}日 ${fields.hour}:${fields.minute}（北京时间）`;
  }
  return null;
}
export function publicationLabel(offer) {
  const publication = offer.publication;
  if (publication) {
    if (publication.certainty === 'unknown') return '消息发布时间：未知';
    const date = publicationDateText(publication.value, publication.precision);
    if (!date || !['exact', 'approximate'].includes(publication.certainty) || !['published', 'available_by'].includes(publication.basis)) return '消息发布时间：未知';
    if (publication.basis === 'available_by') return `最晚已于${date}存在（发布时间估计）`;
    const approximate = publication.certainty === 'approximate' || ['year', 'month'].includes(publication.precision);
    return `消息发布：${approximate ? '约' : ''}${date}`;
  }
  if (offer.publishedAt && Number.isFinite(Date.parse(offer.publishedAt))) return `消息发布：${dateLabel(offer.publishedAt, { year: 'numeric' })}`;
  return '消息发布时间：待查证';
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
