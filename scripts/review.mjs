import { resolve } from 'node:path';
import { ROOT, canonicalUrl, isMain, readJson, validateOffers, writeJson, withDataLock } from './lib.mjs';

export function mergeReviewedOffer(document, offer, { replace = false, now = new Date().toISOString() } = {}) {
  const existing = document.offers.find(item => item.id === offer.id);
  if (existing && !replace) throw new Error('This id already exists. Use --replace for an intentional correction or re-verification.');
  const matchingUrl = document.offers.find(item => canonicalUrl(item.source.url) === canonicalUrl(offer.source?.url) && item.id !== offer.id);
  if (matchingUrl) throw new Error(`Source URL already belongs to ${matchingUrl.id}`);
  const reviewed = existing ? { ...offer, discoveredAt: existing.discoveredAt } : offer;
  const next = { schemaVersion: 1, updatedAt: now, offers: [...document.offers.filter(item => item.id !== offer.id), reviewed] };
  const errors = validateOffers(next, { now: Date.parse(now) });
  if (errors.length) throw new Error(errors.join('\n'));
  return next;
}
export async function review({ root = ROOT, file, replace = false, now = new Date().toISOString() }) {
  if (!file) throw new Error('Usage: npm run review -- --file work/reviewed-offer.json [--replace]');
  const offer = await readJson(resolve(file));
  await withDataLock(root, async () => {
    const document = await readJson(resolve(root, 'data/offers.json'), { schemaVersion: 1, updatedAt: now, offers: [] });
    const next = mergeReviewedOffer(document, offer, { replace, now });
    await writeJson(resolve(root, 'data/offers.json'), next);
  });
  return offer.id;
}
if (isMain(import.meta.url)) {
  try {
    const fileIndex = process.argv.indexOf('--file');
    if (fileIndex === -1 || !process.argv[fileIndex + 1]) throw new Error('Usage: npm run review -- --file work/reviewed-offer.json [--replace]');
    const id = await review({ file: process.argv[fileIndex + 1], replace: process.argv.includes('--replace') });
    console.log(`Reviewed ${id}. Local published dataset updated; deploy separately to update the website.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
