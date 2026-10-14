const { chromium } = require('playwright');
// Shared config for the cart-age gate tests. Override with env vars when testing another store.
// Boundary sweep of the 10 s tier (shipping-information, set-payment-information): one valid stamp,
// each endpoint hit at several ages. Expect 429 below the threshold, origin status above.
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const R = `/rest/${STORE}/V1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
  await page.goto(BASE + '/checkout/cart/', { waitUntil: 'domcontentloaded' });
  const scq = (await ctx.cookies(BASE)).find((c) => c.name === 'scq');
  const ts = parseInt(scq.value.split('.')[0], 10);
  console.log('valid stamp:', scq.value);
  const post = (path, body) => page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) });
    return r.status;
  }, { path, body });
  const cartId = (await page.evaluate(async (R) => (await (await fetch(R + '/guest-carts', { method: 'POST' })).text()).replace(/"/g, ''), R));
  const addr = { firstname: 'Scq', lastname: 'Gatetest', street: ['123 Main St'], city: 'Chicago', region_id: 23, country_id: 'US', postcode: '60601', telephone: '3125551234' };
  const calls = {
    'shipping-information     (10s tier)': () => post(`${R}/guest-carts/${cartId}/shipping-information`, { addressInformation: { shipping_address: addr, shipping_carrier_code: 'flatrate', shipping_method_code: 'flatrate' } }),
    'set-payment-information  (10s tier)': () => post(`${R}/guest-carts/${cartId}/set-payment-information`, { paymentMethod: { method: 'rootways_chase_option' } }),
    'payment-information      (30s tier)': () => post(`${R}/guest-carts/${cartId}/payment-information`, { email: 't@example.com', paymentMethod: { method: 'rootways_chase_option' }, billingAddress: addr }),
  };
  const at = async (age) => {
    const wait = ts + age - Date.now() / 1000; if (wait > 0) await sleep(wait * 1000);
    for (const [name, fn] of Object.entries(calls)) {
      const s = await fn(); const realAge = (Date.now() / 1000 - ts).toFixed(1);
      console.log(`age ${String(realAge).padStart(5)}s  ${name}  -> ${s}${s === 429 ? '  BLOCKED by gate' : '  passed gate (origin answered)'}`);
    }
    console.log('');
  };
  for (const age of [3, 7, 9, 11, 14, 25, 29, 31, 35]) await at(age);
  await b.close();
})();
