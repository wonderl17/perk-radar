import { resolve } from 'node:path';
import { ROOT, isMain, readJson, validateOffers } from './lib.mjs';
import { validateSources } from './sources.mjs';
export { validateOffers } from './lib.mjs';
if (isMain(import.meta.url)) {
  try {
    const data = await readJson(resolve(ROOT, 'data/offers.json'));
    const errors = validateOffers(data);
    if (errors.length) throw new Error(errors.join('\n'));
    const sources = await readJson(resolve(ROOT, 'data/sources.json'));
    if (!validateSources(sources)) throw new Error('Official source registry failed validation.');
    console.log(`Validated ${data.offers.length} offers and ${sources.length} official sources.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
