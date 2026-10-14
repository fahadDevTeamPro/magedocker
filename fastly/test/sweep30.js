const { chromium } = require('playwright');
// Shared config for the cart-age gate tests. Override with env vars when testing another store.
// Boundary sweep of the 30 s tier (PUT …/order, POST …/payment-information) from the /checkout/ page
// context with a fresh valid stamp. Expect 429 below 30 s, origin status above. No order is placed.
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const R = `/rest/${STORE}/V1`;
const PRODUCT_URL = process.env.PRODUCT_URL || '/products/gentle-facial-brush-with-cover/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
  await page.goto(BASE + PRODUCT_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#product-addtocart-button').first().click();
  await page.waitForResponse((r) => /checkout\/cart\/add/.test(r.url()), { timeout: 30000 });
  await sleep(2000);
  await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#customer-email', { timeout: 60000 });
  const cartId = await page.evaluate(() => window.checkoutConfig.quoteData.entity_id);
  // fresh stamp, obtained without leaving the /checkout/ page context
  await ctx.clearCookies({ name: 'scq' });
  await page.evaluate(() => fetch('/checkout/', { credentials: 'include' }));
  await sleep(1000);
  const scq = (await ctx.cookies(BASE)).find((c) => c.name === 'scq');
  const ts = parseInt(scq.value.split('.')[0], 10);
  console.log('page context: ' + page.url() + '\nfresh stamp: ' + scq.value);
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) });
    return r.status + ' ' + (await r.text()).slice(0, 70);
  }, { method, path, body });
  const addr = { firstname: 'Scq', lastname: 'Gatetest', street: ['123 Main St'], city: 'Chicago', region_id: 23, country_id: 'US', postcode: '60601', telephone: '3125551234' };
  const calls = {
    'POST payment-information (30s tier)': () => call('POST', `${R}/guest-carts/${cartId}/payment-information`, { email: 't@example.com', paymentMethod: { method: 'rootways_chase_option' }, billingAddress: addr }),
    'PUT  order               (30s tier)': () => call('PUT', `${R}/guest-carts/${cartId}/order`, { paymentMethod: { method: 'rootways_chase_option' } }),
  };
  for (const age of [5, 15, 25, 29, 31, 35]) {
    const wait = ts + age - Date.now() / 1000; if (wait > 0) await sleep(wait * 1000);
    for (const [name, fn] of Object.entries(calls)) {
      const s = await fn(); console.log(`age ${(Date.now() / 1000 - ts).toFixed(1).padStart(5)}s  ${name}  -> ${s}`);
    }
    console.log('');
  }
  await b.close();
})();
