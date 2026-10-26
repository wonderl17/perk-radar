import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROOT, escapeXml, isMain, readJson, validateOffers } from './lib.mjs';

export function createFeed(document, siteUrl, now = Date.now()) {
  const available = document.offers.filter(offer => offer.status === 'published' && (!offer.expiresAt || Date.parse(offer.expiresAt) > now)).sort((a, b) => Date.parse(b.discoveredAt) - Date.parse(a.discoveredAt));
  if (!siteUrl) throw new Error('Set SITE_URL or data/site.json siteUrl to the actual website origin before building RSS.');
  const channelUrl = siteUrl;
  const items = available.map(offer => `    <item>\n      <title>${escapeXml(offer.title)}</title>\n      <link>${escapeXml(offer.source.url)}</link>\n      <guid isPermaLink="false">perk-radar:${escapeXml(offer.id)}</guid>\n      <pubDate>${new Date(offer.discoveredAt).toUTCString()}</pubDate>\n      <category>${escapeXml(offer.category)}</category>\n      <description>${escapeXml(`${offer.benefit}。${offer.summary}\n适用范围：${offer.availability}\n领取条件：${offer.eligibility.join('；')}\n注意：${offer.caveats.join('；')}\n核验时间：${offer.verifiedAt}。截止：${offer.expiresAt ?? '官方未公布'}。`)}</description>\n    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>福利雷达 · 官方福利信息流</title>\n    <link>${escapeXml(channelUrl)}</link>\n    <description>全球与中国的官方福利、免费权益和活动线索。按首次收录时间排列，领取前请复核官方条款。</description>\n    <language>zh-CN</language>\n    <lastBuildDate>${new Date(document.updatedAt).toUTCString()}</lastBuildDate>\n${items}\n  </channel>\n</rss>\n`;
}
export async function build({ root = ROOT, now = Date.now() } = {}) {
  const document = await readJson(resolve(root, 'data/offers.json'));
  const errors = validateOffers(document, { now });
  if (errors.length) throw new Error(errors.join('\n'));
  const site = await readJson(resolve(root, 'data/site.json'), {});
  const siteUrl = process.env.SITE_URL || site.siteUrl;
  if (!siteUrl) throw new Error('Set SITE_URL or data/site.json siteUrl before building.');
  if (!/^https?:$/.test(new URL(siteUrl).protocol)) throw new Error('SITE_URL must use HTTP(S)');
  const output = resolve(root, 'dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(resolve(output, 'data'), { recursive: true });
  await cp(resolve(root, 'index.html'), resolve(output, 'index.html'));
  await cp(resolve(root, 'src'), resolve(output, 'src'), { recursive: true });
  await cp(resolve(root, 'public'), output, { recursive: true });
  await writeFile(resolve(output, 'data/offers.json'), `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(resolve(output, 'feed.xml'), createFeed(document, siteUrl, now));
  console.log(`Built ${document.offers.length} reviewed offers into dist/. No candidates or health logs included.`);
}
if (isMain(import.meta.url)) {
  try { await build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
