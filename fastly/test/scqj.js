const { chromium } = require('playwright');
const { DEBUG_HEADERS, TOKEN } = require('./debug');
// Shared config for the cart-age gate tests. Override with env vars when testing another store.
// Checkout-JS proof (scqj). Real browser, real cart, no order placed (no card data, no reCAPTCHA token:
// a payment call that passes the gate is rejected by Magento with a 400).
// Needs scqj_mode = monitor or block on the service under test, and SCQ_DEBUG_TOKEN (see debug.js).
//   1. the checkout page's own JS calls issue scqj            -> cookie present after /checkout/
//   2. payment without scqj                                    -> scqj-missing
//   3. scqj presented for another cart                         -> scqj-bad
//   4. scqj presented with another User-Agent                  -> scqj-bad
//   5. fresh scqj (cookie dropped, estimate call), pay at once -> scqj-too-early (secret wait 25-44 s)
//   6. reload of /checkout/ keeps a valid scqj                 -> cookie unchanged
//   7. 45 s after that scqj, everything valid                  -> no verdict, origin answers
// The stamp (scq) must be >= 30 s old first, or its own verdict (too-early) would win the header.
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const R = `/rest/${STORE}/V1`;
const PRODUCT_URL = process.env.PRODUCT_URL || '/products/gentle-facial-brush-with-cover/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s] ${m}`);
let fail = 0;
const expect = (label, got, want) => { const ok = got.verdict === want; if (!ok) fail++; log(`${ok ? 'OK  ' : 'FAIL'} ${label} -> ${got.blocked ? 'BLOCKED' : got.status} verdict=${got.verdict} (expected ${want})`); };

(async () => {
  if (!TOKEN) { console.error('SCQ_DEBUG_TOKEN is required for this test'); process.exit(2); }
  const args = process.env.HOST_IP ? [`--host-resolver-rules=MAP ${new URL(BASE).host} ${process.env.HOST_IP}`] : [];
  const b = await chromium.launch({ args });
  const ctx = await b.newContext({ extraHTTPHeaders: DEBUG_HEADERS });
  const page = await ctx.newPage();
  const cookie = async (n) => (await ctx.cookies(BASE)).find((c) => c.name === n);
  const addr = { firstname: 'Scq', lastname: 'Gatetest', street: ['123 Main St'], city: 'Chicago', region_id: 23, region: 'Illinois', country_id: 'US', postcode: '60601', telephone: '3125551234' };
  const pay = (cartId) => page.evaluate(async ({ R, cartId, addr }) => {
    const r = await fetch(`${R}/guest-carts/${cartId}/payment-information`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ email: 'scqj-test@example.com', paymentMethod: { method: 'rootways_chase_option' }, billingAddress: addr }) });
    return { status: r.status, blocked: !!r.headers.get('x-scq-blocked'), verdict: r.headers.get('x-scq-verdict') || '-' };
  }, { R, cartId, addr });
  const estimate = (cartId) => page.evaluate(async ({ R, cartId, addr }) => {
    const r = await fetch(`${R}/guest-carts/${cartId}/estimate-shipping-methods`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ address: addr }) });
    return r.status;
  }, { R, cartId, addr });

  // real cart, real checkout page: its own JS calls estimate-shipping-methods / totals-information
  await page.goto(BASE + PRODUCT_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#product-addtocart-button').first().click();
  const added = await page.waitForResponse((r) => /checkout\/cart\/add/.test(r.url()), { timeout: 30000 });
  // let the add finish completely: UAT writes the session after the response starts, and a /checkout/
  // request that reads it too early is redirected to the cart and loses the quote for this session
  await added.finished();
  await sleep(3000);
  await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#customer-email', { timeout: 120000 }).catch(async (e) => { log(`checkout page did not render, at ${page.url()}`); throw e; });
  const cartId = await page.evaluate(() => window.checkoutConfig.quoteData.entity_id);
  let scqj = null;
  for (let i = 0; i < 30 && !scqj; i++) { await sleep(1000); scqj = await cookie('scqj'); }
  const ok1 = !!scqj; if (!ok1) fail++;
  log(`${ok1 ? 'OK  ' : 'FAIL'} 1. scqj issued by the checkout page's own calls: ${scqj ? scqj.value : 'none'}  cart=${cartId}`);
  if (!scqj) { await b.close(); process.exit(1); }

  const scq = await cookie('scq');
  const stampAge = Date.now() / 1000 - parseInt(scq.value, 10);
  if (stampAge < 31) { log(`waiting ${Math.ceil(31 - stampAge)} s so the 30 s stamp check passes`); await sleep((31 - stampAge) * 1000); }

  // 2. no scqj
  await ctx.clearCookies({ name: 'scqj' });
  expect('2. payment without scqj', await pay(cartId), 'scqj-missing');
  await ctx.addCookies([{ ...scqj }]);

  // 3. scqj for another cart: a throwaway guest cart, same cookies
  const other = await page.evaluate(async (R) => (await (await fetch(`${R}/guest-carts`, { method: 'POST' })).text()).replace(/"/g, ''), R);
  expect('3. scqj presented for another cart', await pay(other), 'scqj-bad');

  // 4. same cookies, another User-Agent
  await page.setExtraHTTPHeaders({ ...DEBUG_HEADERS, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.0.0 Safari/537.36 scqj-test' });
  expect('4. scqj presented with another User-Agent', await pay(cartId), 'scqj-bad');
  await page.setExtraHTTPHeaders(DEBUG_HEADERS);

  // 5. fresh scqj, pay at once
  await ctx.clearCookies({ name: 'scqj' });
  log(`estimate-shipping-methods from the page -> ${await estimate(cartId)}`);
  const fresh = await cookie('scqj');
  log(`fresh scqj: ${fresh ? fresh.value : 'none'}`);
  expect('5. fresh scqj, payment at once', await pay(cartId), 'scqj-too-early');

  // 6. reload keeps a valid scqj
  await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#customer-email', { timeout: 120000 });
  await sleep(5000);
  const after = await cookie('scqj');
  const ok6 = after && fresh && after.value === fresh.value; if (!ok6) fail++;
  log(`${ok6 ? 'OK  ' : 'FAIL'} 6. reload of /checkout/ keeps scqj (${after ? after.value : 'none'})`);

  // 7. after the longest possible wait, everything valid
  const wait = parseInt(fresh.value, 10) + 46 - Date.now() / 1000;
  if (wait > 0) { log(`waiting ${Math.ceil(wait)} s (longest per-cart wait is 44 s)`); await sleep(wait * 1000); }
  expect('7. everything valid after the wait (origin then rejects: no card, no captcha)', await pay(cartId), '-');

  await b.close();
  console.log(`\n${fail === 0 ? 'ALL OK' : fail + ' FAILED'}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { log('ERROR ' + e.message); process.exit(1); });
