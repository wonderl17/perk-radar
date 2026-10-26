import { resolve } from 'node:path';
import { ROOT, isMain, readJson, validateOffers } from './lib.mjs';
export { validateOffers } from './lib.mjs';
if (isMain(import.meta.url)) {
  try {
    const data = await readJson(resolve(ROOT, 'data/offers.json'));
    const errors = validateOffers(data);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`Validated ${data.offers.length} offers.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
