import { categories, statusOf, filterOffers, groupByDay, dateLabel, dateKey, verificationLabel, publicationLabel } from './domain.mjs';

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
  book: '<path d="M12 6C8 3 5 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-6-1-10 2v15"/>',
  coffee: '<path d="M4 8h13v8a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Zm13 1h2a3 3 0 0 1 0 6h-2M7 2v3m5-3v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  archive: '<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M9 11h6"/>',
  rss: '<circle cx="5" cy="19" r="1" fill="currentColor"/><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8H7a3 3 0 1 1 3-3l2 3Zm0 0h5a3 3 0 1 0-3-3l-2 3Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sort: '<path d="M7 4v16m-3-3 3 3 3-3M13 5h8m-8 5h6m-6 5h4"/>',
  bookmark: '<path d="M6 3h12v19l-6-4-6 4Z"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.5"/>',
  file: '<path d="M14 2H4v20h16V8Zm0 0v6h6M8 13h8m-8 4h5"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.gift}</svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
function safeLink(value) { try { const url = new URL(value); return url.protocol === 'https:' ? esc(url.href) : '#'; } catch { return '#'; } }
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
const $ = (id) => document.getElementById(id);
const logos = {
  'Qoder CN': ['Q', '#f2eefb', '#8c75b7'], 'Qoder': ['Q', '#f3eefc', '#9479bb'],
  'TRAE CN': ['T', '#edf7ee', '#6b9d74'], 'Manus': ['m', '#f2f0ed', '#8f8575'],
  'Lovable': ['♥', '#fff0ec', '#da9686'], '阿里云百炼': ['云', '#fff3e6', '#d29b62'],
  'GitHub Education': ['GH', '#eeedf4', '#7e728d'], 'Notion': ['N', '#f2f1f2', '#7b747e'],
  'Microsoft Azure': ['A', '#edf4fc', '#6c9bc6'], 'Microsoft Learn': ['M', '#edf4fb', '#799fc6'],
  'Libby / OverDrive': ['L', '#f9edf0', '#bd8d9c'],
};
function providerIcon(offer) {
  const [letter, bg, color] = logos[offer.provider] || [offer.provider.slice(0, 1), '#f1edf8', '#a28abd'];
  return `<span class="provider-icon" style="--logo-bg:${bg};--logo-color:${color}" aria-hidden="true">${esc(letter)}</span>`;
}
let offers = [];
let dataUpdatedAt;
let boundaryTimer;
let statusSignature = "";
let storageAvailable = true;
let saved;
try { const parsed = JSON.parse(localStorage.getItem('perk-radar:saved') || '[]'); saved = Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []; } catch { saved = []; storageAvailable = false; }
const params = new URLSearchParams(location.search);
const allowed = (key, values, fallback) => values.includes(params.get(key)) ? params.get(key) : fallback;
const state = {
  category: allowed('category', Object.keys(categories), 'all'),
  region: allowed('region', ['all', 'cn', 'global'], 'all'),
  type: allowed('type', ['all', 'limited', 'ongoing'], 'all'),
  view: allowed('view', ['all', 'saved', 'ending', 'archive'], 'all'),
  sort: allowed('sort', ['latest', 'ending'], 'latest'),
  query: params.get('q') || '',
};
let toastTimer;
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}
function persistUrl() {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (key === 'query') { if (value) query.set('q', value); }
    else if (value !== 'all' && !(key === 'sort' && value === 'latest')) query.set(key, value);
  }
  const detail = $('detail-dialog').open && $('detail-dialog').dataset.offer;
  if (detail) query.set('offer', detail);
  history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
}
function updateSavedButtons() {
  document.querySelectorAll('[data-save]').forEach(button => {
    const yes = saved.includes(button.dataset.save);
    button.classList.toggle('saved', yes);
    button.setAttribute('aria-pressed', yes ? 'true' : 'false');
    button.setAttribute('aria-label', yes ? '取消收藏' : '收藏此福利');
    if (button.classList.contains('detail-save')) button.innerHTML = `${icon('bookmark')}<span>${yes ? '已收藏' : '收藏'}</span>`;
  });
  $('saved-count').textContent = saved.filter(id => offers.some(x => x.id === id && x.status !== 'withdrawn')).length;
}
function toggleSave(id) {
  if (!offers.some(offer => offer.id === id)) return;
  const added = !saved.includes(id);
  saved = added ? [...saved, id] : saved.filter(x => x !== id);
  try { localStorage.setItem('perk-radar:saved', JSON.stringify(saved)); } catch { storageAvailable = false; }
  if (state.view === 'saved') renderFeed();
  updateSavedButtons();
  toast(added ? (storageAvailable ? '已收藏，留给下次慢慢看' : '已暂存；当前浏览器无法持久保存收藏') : '已取消收藏');
}
function statusLabel(offer) {
  const status = statusOf(offer);
  if (status === 'expired') return { text: '活动已截止', warn: true };
  if (status === 'withdrawn') return { text: '已撤回', warn: true };
  if (status === 'stale') return { text: '待复核 · 上次 ' + dateLabel(offer.verifiedAt), warn: true };
  return { text: verificationLabel(offer), warn: false };
}
function deadlineLabel(offer) {
  const status = statusOf(offer);
  if (status === 'expired') return '已截止';
  if (status === 'stale') return '待复核';
  if (offer.expiresAt) return `${dateLabel(offer.expiresAt)}截止`;
  return '截止未公布';
}
function card(offer) {
  const verification = statusLabel(offer);
  const hasSaved = saved.includes(offer.id);
  return `<article class="offer-card" aria-label="${esc(offer.title)}">
    <div class="card-top">${providerIcon(offer)}<div class="provider-line"><span class="provider-name">${esc(offer.provider)}</span><span class="verified${verification.warn ? ' warn-text' : ''}">${icon(verification.warn ? 'clock' : 'check-circle')}${esc(verification.text)}</span></div><button class="save-button${hasSaved ? ' saved' : ''}" data-save="${esc(offer.id)}" aria-label="${hasSaved ? '取消收藏' : '收藏此福利'}" aria-pressed="${hasSaved}">${icon('bookmark')}</button></div>
    <button class="offer-title" data-offer="${esc(offer.id)}">${esc(offer.title)}</button>
    <p class="offer-summary">${esc(offer.summary)}</p>
    <div class="benefit-line${offer.offerType === 'limited' ? ' limited' : ''}">${icon('gift')}${esc(offer.benefit)}</div>
    <div class="card-tags"><span class="category-tag">${esc(categories[offer.category]?.label || '其他福利')}</span><span>${icon('globe')}${offer.regions.includes('cn') ? '中国' : '全球 / 海外'}</span><span class="tag-divider">·</span><span>${offer.offerType === 'limited' ? '限时活动' : '长期权益'}</span><span class="deadline${statusOf(offer) === 'stale' ? ' stale' : ''}">${icon('clock')}${esc(deadlineLabel(offer))}</span></div>
    <div class="card-footer"><div class="card-meta"><span class="publication-label">${esc(publicationLabel(offer))}</span><span class="card-keywords">${esc(offer.tags.slice(0, 2).join(' · '))}</span></div><button data-offer="${esc(offer.id)}">${statusOf(offer) === 'expired' ? '查看历史规则' : '查看领取方式'} ${icon('arrow')}</button></div>
  </article>`;
}
function emptyState() {
  const views = {
    saved: ['bookmark', '先收藏一份小确幸', '点击福利卡片右上角的书签，<br>感兴趣的福利就会留在这里。'],
    ending: ['clock', '暂时没有即将截止的福利', '这里只显示未来 7 天内截止的活动。<br>没有写明期限的权益，不会制造倒计时。'],
    archive: ['archive', '过期归档还是空的', '福利过期后会自动移入这里，<br>领取前仍请查看官方实时规则。'],
    all: ['search', '还没找到这份小确幸', '试试换个关键词，或放宽地区和类型筛选。<br>宁可少一点，也要把条件查清楚。'],
  };
  const isFiltered = state.query || state.category !== 'all' || state.region !== 'all' || state.type !== 'all';
  const [name, title, description] = views[isFiltered ? 'all' : state.view] || views.all;
  return `<div class="empty-state">${icon(name)}<h3>${title}</h3><p>${description}</p><button data-action="reset">查看全部福利</button></div>`;
}
function renderFeed() {
  const visible = filterOffers(offers, { ...state, saved });
  const title = state.view === 'saved' ? '我的福利收藏' : state.view === 'ending' ? '即将截止' : state.view === 'archive' ? '过期归档' : state.category !== 'all' ? categories[state.category].label : '福利时间流';
  $('feed-title').innerHTML = `${title}<span class="heading-dot"></span>`;
  $('feed-subtitle').textContent = state.view === 'saved' ? '收藏保存在当前浏览器，留给想用的时候。' : state.view === 'ending' ? '未来 7 天内截止，别让值得的福利溜走。' : state.view === 'archive' ? '保留原始出处，过期活动不再出现在发现页。' : state.sort === 'ending' ? '有明确截止时间的排在前面，未知期限放在后面。' : '按首次收录时间排列，消息发布时间单独标注。';
  const groups = state.sort === 'ending' ? [{ key: 'deadlines', date: null, offers: visible }] : groupByDay(visible);
  $('feed-content').innerHTML = visible.length ? groups.map(group => `<div class="date-heading"><i class="date-marker"></i><b>${group.date ? esc(dateLabel(group.date)) : '按截止时间排列'}</b><span>${group.date ? (dateKey(group.date) === dateKey(new Date()) ? '今天收录' : '首次收录') : '未知期限置后'}</span><div class="date-rule"></div><span>${group.offers.length} 份福利</span></div><div class="timeline-group">${group.offers.map(card).join('')}</div>`).join('') : emptyState();
  $('feed-end').hidden = !visible.length;
  const filters = [state.query ? `“${state.query}”` : '', state.category !== 'all' ? categories[state.category].label : '', state.region === 'cn' ? '中国' : state.region === 'global' ? '全球 / 海外' : '', state.type === 'limited' ? '限时活动' : state.type === 'ongoing' ? '长期权益' : ''].filter(Boolean);
  $('active-filter').hidden = !filters.length;
  $('active-filter').innerHTML = `${esc(filters.join(' / '))} · ${visible.length} 份福利<button data-action="reset">清除筛选</button>`;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === state.view));
  document.querySelectorAll('[data-region]').forEach(el => { const yes = state.region === el.dataset.region; el.classList.toggle('selected', yes); el.setAttribute('aria-pressed', String(yes)); });
  document.querySelectorAll('[data-category]').forEach(el => { const yes = state.category === el.dataset.category && state.view === 'all'; el.classList.toggle('active', yes); el.setAttribute('aria-pressed', String(yes)); });
  $('search').value = state.query; $('sort').value = state.sort; $('type').value = state.type;
  updateSavedButtons(); persistUrl();
}
function renderShell() {
  const active = offers.filter(x => !['expired', 'withdrawn'].includes(statusOf(x)));
  $('category-nav').innerHTML = Object.entries(categories).map(([id, category]) => `<button class="category-btn" data-category="${id}" aria-pressed="false">${icon(category.icon)}${category.label}<span class="category-count">${id === 'all' ? active.length : active.filter(x => x.category === id).length}</span></button>`).join('');
  $('offer-count').textContent = active.length;
  $('source-count').textContent = new Set(active.map(x => new URL(x.source.url).hostname)).size;
  $('last-updated').textContent = dataUpdatedAt ? `${dateLabel(dataUpdatedAt)}更新 · 核验时效见卡片` : '核验时间见每条福利';
  $('featured-list').innerHTML = active.filter(x => x.featured).slice(0, 3).map(offer => `<button class="featured-item" data-offer="${esc(offer.id)}">${providerIcon(offer)}<span class="featured-info"><strong>${esc(offer.benefit)}</strong><p>${esc(offer.provider)}</p><span>${offer.offerType === 'limited' ? esc(deadlineLabel(offer)) : esc(offer.tags[0] || '长期权益')}</span></span>${icon('arrow-up-right')}</button>`).join('');
  $('year').textContent = new Date().getFullYear();
  renderFeed();
}
function refreshTimeSensitiveState() {
  clearTimeout(boundaryTimer);
  if (!offers.length) return;
  const now = Date.now();
  const signature = offers.map(offer => `${offer.id}:${statusOf(offer, now)}`).join('|');
  if (signature !== statusSignature) {
    statusSignature = signature;
    const openOffer = $('detail-dialog').open && $('detail-dialog').dataset.offer;
    const scroll = $('detail-dialog').scrollTop;
    renderShell();
    if (openOffer) { showDetail(openOffer); $('detail-dialog').scrollTop = scroll; }
  }
  const boundaries = offers.flatMap(offer => [offer.expiresAt ? Date.parse(offer.expiresAt) : Infinity, Date.parse(offer.verifiedAt) + 7 * 86400000 + 1]).filter(value => value > now);
  const next = Math.min(...boundaries);
  if (Number.isFinite(next)) boundaryTimer = setTimeout(refreshTimeSensitiveState, Math.max(100, Math.min(next - now + 25, 2147483647)));
}
function publicationDetails(offer) {
  const publication = offer.publication;
  let details;
  if (publication) {
    const evidence = (publication.evidence || []).map((item, index) => `<li><a href="${safeLink(item.url)}" target="_blank" rel="noopener noreferrer">日期依据 ${index + 1} ↗</a>${item.quote ? `<blockquote>${esc(item.quote.slice(0, 220))}${item.quote.length > 220 ? '…' : ''}</blockquote>` : ''}</li>`).join('');
    const checkedAt = Number.isFinite(Date.parse(publication.assessedAt)) ? dateLabel(publication.assessedAt, { year: 'numeric' }) : null;
    details = `${publication.reasoning ? `<p>${esc(publication.reasoning)}</p>` : ''}${evidence ? `<ul class="publication-evidence">${evidence}</ul>` : ''}${checkedAt ? `<p class="publication-checked">${publication.method === 'gpt-web-search' ? 'GPT 搜索查证' : '人工查证'}于 ${esc(checkedAt)}</p>` : ''}`;
  } else {
    details = `<p>${offer.publishedAt ? '此日期沿用已收录记录，尚未补充单独的时间查证依据。' : '尚未查证消息发布时间；首次收录日不能代替发布时间。'}</p>`;
  }
  return `<section class="detail-section publication-section"><h3>${icon('clock')}消息何时发布</h3><p class="publication-result">${esc(publicationLabel(offer))}</p>${details}</section>`;
}
function showDetail(id) {
  const offer = offers.find(item => item.id === id && item.status !== 'withdrawn');
  if (!offer) { toast('这条福利暂未收录或已撤回'); return; }
  const status = statusLabel(offer);
  $('detail-content').innerHTML = `<div class="detail-inner"><div class="dialog-topline"><div class="dialog-provider">${providerIcon(offer)}<span>${esc(offer.provider)}</span></div><button class="dialog-close" data-close="detail-dialog" aria-label="关闭福利详情">${icon('close')}</button></div><h2 id="detail-title" class="dialog-title">${esc(offer.title)}</h2><p class="detail-lead">${esc(offer.summary)}</p><div class="detail-benefit">${icon('gift')}${esc(offer.benefit)}</div><div class="detail-status"><span class="status-chip${status.warn ? ' warn' : ''}">${esc(status.text)}</span><span class="status-chip warn">${offer.expiresAt ? '截止 ' + esc(dateLabel(offer.expiresAt, { year: 'numeric', hour: '2-digit', minute: '2-digit' })) + '（北京时间）' : '官方未公布截止时间'}</span></div><section class="detail-section"><h3>${icon('globe')}谁可以领</h3><p>${esc(offer.availability)}</p><ul>${offer.eligibility.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section><section class="detail-section"><h3>${icon('gift')}怎么领</h3><ol>${offer.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol></section><section class="detail-section caveats"><h3>${icon('alert')}领取前，再留意一下</h3><ul>${offer.caveats.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>${publicationDetails(offer)}<section class="source-box"><strong>有出处，才放心。</strong><p>官方来源：<a href="${safeLink(offer.source.url)}" target="_blank" rel="noopener noreferrer">${esc(offer.source.name)} ↗</a></p><p>${esc(offer.source.evidence)}</p><p>首次收录 ${esc(dateLabel(offer.discoveredAt, { year: 'numeric' }))} · ${esc(verificationLabel(offer))} ${esc(dateLabel(offer.verifiedAt, { year: 'numeric' }))}${offer.verification?.method === 'gpt' ? `<br>核验模型：${esc(offer.verification.model)}<br>GPT 依据官方页面提取并校验公开规则，未经人工实领。` : '<br>人工核验指核对公开规则，未经逐个登录实领。'}<br>个人资格、地区与库存以领取时官方规则为准。</p><button class="text-link" data-action="report" data-report="${esc(offer.id)}">信息有变化？生成反馈内容 ↗</button></section></div><div class="detail-actions"><a class="primary-button" href="${safeLink(offer.source.url)}" target="_blank" rel="noopener noreferrer">${statusOf(offer) === 'expired' ? '查看官方规则' : '前往官方规则与领取入口'}${icon('arrow-up-right')}</a><button class="secondary-button detail-save" data-save="${esc(offer.id)}" aria-pressed="false">${icon('bookmark')}<span>收藏</span></button><button class="secondary-button" data-share="${esc(offer.id)}" aria-label="复制福利链接">${icon('copy')}<span>分享</span></button></div>`;
  $('detail-dialog').dataset.offer = offer.id;
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
  updateSavedButtons(); persistUrl();
}
function closeDialog(id) { $(id).close(); }
function infoShell(title, content) {
  $('info-content').innerHTML = `<div class="dialog-topline"><span class="mini-eyebrow">PERK RADAR / 福利雷达</span><button class="dialog-close" data-close="info-dialog" aria-label="关闭说明">${icon('close')}</button></div><h2 id="info-title" class="dialog-title">${title}</h2>${content}`;
  if (!$('info-dialog').open) $('info-dialog').showModal();
}
function showMethod() {
  infoShell('好福利，也要有好标准。', `<p>福利雷达独立整理中国与全球的活动、免费额度、学生权益和实用资源。我们更在意你能否看清条件、顺利领取。</p><h3>每条收录，至少说明这四件事</h3><ol><li>领什么：具体权益，不把“最高可得”写成保证到手。</li><li>谁能领：地区、账号、认证和付费门槛。</li><li>何时领：截止与奖励有效期分开，没有公告就写未公布。</li><li>去哪里领：可追溯的官方规则和入口。</li></ol><h3>发现 → 去重 → GPT 核验 → 自动收录</h3><p>采集官方页面或 RSS 后，由 GPT 提取权益、领取条件和期限。证据完整并通过校验的福利自动收录，证据不足、含糊或冲突的线索留待复核。社区消息帮助发现，正式结论以官方出处为依据。</p><p>卡片明确区分“GPT 自动核验”和“人工核验”。GPT 根据官方页面提取与校验规则，不代表人工实领；首批人工条目也只核对公开页面，未逐个登录领取。</p><p>时间流按首次收录时间排列，不能把收录日当作活动上线日。超过 7 天未复核会标记“待复核”；到期自动移入归档。只有完成规则核验才更新核验时间，抓取成功本身不会刷新。</p><h3>发布时间如何查证</h3><p>每条福利单独标注消息发布时间。GPT 通过网页搜索寻找公告、文章和其他可追溯的日期依据，结合原文判断；搜索结果和判断仍可能有误，详情保留依据链接、原文片段、判断说明和查证日期。</p><p>只查到年份或月份时标注“约”；只能确认某时已存在时写“最晚已于…存在（发布时间估计）”，不能据此确定最初发布日。证据不足就写“未知”，尚未查证则写“待查证”。沿用历史记录的日期会单独说明，不能当作已经搜索查证。</p><p>消息发布时间、首次收录、规则核验、活动开始与截止各自独立。精确到分钟的发布时间统一显示北京时间；时间流和 RSS 仍按首次收录时间排列。</p><h3>我们坚持</h3><p>无推广链接、无付费排名，不收录拉人头、套现、批量注册和来源不明的活动。全球 / 海外不代表所有国家和地区均可使用。</p><h3>关于你的数据</h3><p>本版本不设账号，不采集邮箱。收藏仅保存在当前浏览器，清理浏览器数据后会消失。分享与反馈先在本地生成内容，不会自动发送。</p><p><a href="/feed.xml" target="_blank" rel="noopener">订阅 RSS ↗</a>　<a href="/data/offers.json" target="_blank" rel="noopener">查看公开数据 ↗</a></p>`);
}
function showSubmission(id) {
  const offer = offers.find(x => x.id === id);
  const template = offer ? `【福利信息纠错】\n标题：${offer.title}\n链接：${offer.source.url}\n变化或错误：\n新的官方出处：\n` : '【福利线索】\n活动名称：\n官方链接：\n具体权益：\n适用地区 / 人群：\n领取门槛：\n截止时间及奖励有效期：\n';
  infoShell(offer ? '一起把信息核对得更准。' : '发现好福利，一起分享。', `<p>${offer ? '请补充变化和新的官方出处，方便复核。' : '优先提供官方规则页，清楚说明权益、门槛与有效期。'}</p><p>当前版本尚未接通在线投稿。你可以编辑并复制这份内容，发给站点维护者；本页不会自动提交。</p><label class="form-label" for="submission-text">${offer ? '反馈内容' : '福利线索'}</label><textarea id="submission-text" spellcheck="false">${esc(template)}</textarea><button class="secondary-button" data-action="copy-submission">${icon('copy')}复制${offer ? '反馈' : '投稿'}内容</button><p class="copy-help" id="copy-help" hidden>浏览器未授权复制，请选中文本手动复制。</p>`);
}
async function copyText(value, success) {
  try { await navigator.clipboard.writeText(value); toast(success); return true; }
  catch { return false; }
}
function reset() { Object.assign(state, { query: '', category: 'all', region: 'all', type: 'all', view: 'all', sort: 'latest' }); renderFeed(); }
document.addEventListener('click', async event => {
  const button = event.target.closest('button, a');
  if (!button) return;
  if (button.dataset.save) { toggleSave(button.dataset.save); return; }
  if (button.dataset.offer) { showDetail(button.dataset.offer); return; }
  if (button.dataset.close) { closeDialog(button.dataset.close); return; }
  if (button.dataset.share) {
    const url = new URL(location.origin + location.pathname); url.searchParams.set('offer', button.dataset.share);
    if (!await copyText(url.href, '福利链接已复制')) infoShell('分享这份福利', `<p>复制下方链接，把福利分享出去。</p><textarea readonly aria-label="福利分享链接">${esc(url.href)}</textarea>`);
    return;
  }
  if (button.dataset.category) { state.category = button.dataset.category; state.view = 'all'; renderFeed(); return; }
  if (button.dataset.region) { state.region = button.dataset.region; renderFeed(); return; }
  if (button.dataset.view) { state.view = button.dataset.view; state.category = 'all'; renderFeed(); if (window.innerWidth < 650) $('feed').scrollIntoView({ block: 'start' }); return; }
  const action = button.dataset.action;
  if (action === 'reset') reset();
  if (action === 'method') showMethod();
  if (action === 'submit') showSubmission();
  if (action === 'report') showSubmission(button.dataset.report);
  if (action === 'copy-submission') {
    if (!await copyText($('submission-text').value, '内容已复制，可发给站点维护者')) { $('copy-help').hidden = false; $('submission-text').select(); }
  }
});
$('search').addEventListener('input', event => { state.query = event.target.value; renderFeed(); });
$('sort').addEventListener('change', event => { state.sort = event.target.value; renderFeed(); });
$('type').addEventListener('change', event => { state.type = event.target.value; renderFeed(); });
$('detail-dialog').addEventListener('close', () => { delete $('detail-dialog').dataset.offer; persistUrl(); });
for (const id of ['detail-dialog', 'info-dialog']) {
  $(id).addEventListener('click', event => { if (event.target === $(id)) { const box = $(id).getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDialog(id); } });
}
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('detail-dialog').open && !$('info-dialog').open) { event.preventDefault(); $('search').focus(); }
});
window.addEventListener('storage', event => { if (event.key === 'perk-radar:saved') { try { const value = JSON.parse(event.newValue || '[]'); saved = Array.isArray(value) ? value.filter(x => typeof x === 'string') : []; renderFeed(); } catch {} } });
window.addEventListener('popstate', () => location.reload());
window.addEventListener('focus', refreshTimeSensitiveState);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTimeSensitiveState(); });
hydrateIcons();
try {
  const response = await fetch('/data/offers.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('data-fetch');
  const data = await response.json();
  if (data.schemaVersion !== 1 || !Array.isArray(data.offers)) throw new Error('data-shape');
  offers = data.offers; dataUpdatedAt = data.updatedAt;
  const initialOffer = params.get('offer');
  renderShell();
  refreshTimeSensitiveState();
  if (initialOffer) showDetail(initialOffer);
} catch {
  $('feed-content').innerHTML = `<div class="empty-state">${icon('alert')}<h3>福利暂时没有加载出来</h3><p>请稍后刷新重试，或通过 RSS 查看已收录的内容。</p><button data-action="reload">重新加载</button></div>`;
  $('last-updated').textContent = '数据暂时不可用';
  document.querySelector('[data-action="reload"]')?.addEventListener('click', () => location.reload());
}
