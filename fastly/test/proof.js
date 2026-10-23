const { chromium } = require('playwright');
const { DEBUG_HEADERS, label } = require('./debug');
// Shared config for the cart-age gate tests. Override with env vars when testing another store.
// Checkout-proof and session-binding checks. Real browser, real cart, no order placed.
//   1. cart page only (stamp, no proof)      -> shipping-information must be BLOCKED no-proof
//   2. after loading /checkout/              -> same call reaches origin
//   3. proof cookie tampered                 -> BLOCKED bad-proof
//   4. stamp timestamp backdated (forged age) -> BLOCKED bad-sig
//   5. PHPSESSID removed                     -> BLOCKED no-session
//   6. empty-cart /checkout/ (302)           -> no proof cookie issued
// In monitor mode every call reaches origin; compare X-SCQ-Verdict on the responses instead.
// BLOCKED = Fastly refused the call (X-SCQ-Blocked); needs SCQ_DEBUG_TOKEN, see debug.js.
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const R = `/rest/${STORE}/V1`;
const PRODUCT_URL = process.env.PRODUCT_URL || '/products/gentle-facial-brush-with-cover/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s] ${m}`);

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ extraHTTPHeaders: DEBUG_HEADERS });
  const page = await ctx.newPage();
  const cookie = async (c, name) => (await c.cookies(BASE)).find((x) => x.name === name);
  const addr = { firstname: 'Scq', lastname: 'Gatetest', street: ['123 Main St'], city: 'Chicago', region_id: 23, country_id: 'US', postcode: '60601', telephone: '3125551234' };
  const ship = async (p, cartId) => { const x = await p.evaluate(async ({ R, cartId, addr }) => {
    const r = await fetch(`${R}/guest-carts/${cartId}/shipping-information`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ addressInformation: { shipping_address: addr, shipping_carrier_code: 'flatrate', shipping_method_code: 'flatrate' } }) });
    return { s: r.status, b: r.headers.get('x-scq-blocked'), v: r.headers.get('x-scq-verdict') || '-' };
  }, { R, cartId, addr }); return `${label(x.s, x.b)} verdict=${x.v}`; };
  const expect = (label, got, want) => log(`${got.startsWith(want) ? 'OK  ' : 'FAIL'} ${label} -> ${got} (expected ${want})`);

  // --- 6. empty cart: /checkout/ redirects, must not issue a proof. Own browser session: on UAT a
  // session that starts on the empty-cart redirect intermittently keeps redirecting /checkout/ to the
  // cart after an add to cart, which would break the rest of this test (not a gate effect).
  const ctx6 = await b.newContext({ extraHTTPHeaders: DEBUG_HEADERS });
  const page6 = await ctx6.newPage();
  await page6.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded' });
  log(`empty-cart /checkout/ landed on ${page6.url()}; scqc=${(await cookie(ctx6, 'scqc')) ? 'ISSUED (FAIL)' : 'not issued (OK)'}`);
  await ctx6.close();

  // add to cart, read the masked cart id from the cart page (no /checkout/ yet)
  await page.goto(BASE + PRODUCT_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#product-addtocart-button').first().click();
  await page.waitForResponse((r) => /checkout\/cart\/add/.test(r.url()), { timeout: 30000 });
  await sleep(2000);
  await page.goto(BASE + '/checkout/cart/', { waitUntil: 'domcontentloaded' });
  const cartId = await page.evaluate(async (R) => {
    // the cart page has no masked id; a throwaway guest cart is enough, the gate decides before origin
    const r = await fetch(`${R}/guest-carts`, { method: 'POST' });
    return (await r.text()).replace(/"/g, '');
  }, R);
  log(`stamp scq=${(await cookie(ctx, 'scq'))?.value || 'none'}  scqc=${(await cookie(ctx, 'scqc'))?.value || 'none'}  cart=${cartId}`);

  // --- 1. stamp old enough, but no checkout page seen
  log('waiting 12 s so the timing tier passes');
  await sleep(12000);
  expect('1. cart page only, no proof', await ship(page, cartId), 'BLOCKED verdict=no-proof');

  // --- 2. load /checkout/ for real, then the same call
  const co = await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded' });
  log(`GET /checkout/ -> ${co.status()} final url ${page.url()}`);
  await page.waitForSelector('#customer-email', { timeout: 120000 }).catch(() => log('checkout page did not render'));
  const checkoutCart = await page.evaluate(() => window.checkoutConfig && window.checkoutConfig.quoteData && window.checkoutConfig.quoteData.entity_id);
  const scqc = await cookie(ctx, 'scqc');
  log(`after /checkout/: scqc=${scqc ? scqc.value : 'none'}  cart=${checkoutCart}`);
  const got2 = await ship(page, checkoutCart);
  log(`${got2.startsWith('BLOCKED') ? 'FAIL' : 'OK  '} 2. with proof -> ${got2} (expected origin status, not BLOCKED)`);

  // --- 3. tampered proof
  const bad = scqc.value.slice(0, -2) + (scqc.value.endsWith('A') ? 'B=' : 'A=');
  await ctx.addCookies([{ name: 'scqc', value: bad, domain: new URL(BASE).host, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  expect('3. tampered proof', await ship(page, checkoutCart), 'BLOCKED verdict=bad-proof');
  await ctx.addCookies([{ ...scqc }]);

  // --- 4. stamp backdated by 10 min to fake an old cart (signature no longer matches)
  const scq = await cookie(ctx, 'scq');
  const [ts, sig] = scq.value.split('.');
  await ctx.addCookies([{ ...scq, value: `${parseInt(ts, 10) - 600}.${sig}` }]);
  expect('4. backdated stamp', await ship(page, checkoutCart), 'BLOCKED verdict=bad-sig');
  await ctx.addCookies([{ ...scq }]);

  // --- 5. no session cookie at all
  const sess = await cookie(ctx, 'PHPSESSID');
  await ctx.clearCookies({ name: 'PHPSESSID' });
  expect('5. no PHPSESSID', await ship(page, checkoutCart), 'BLOCKED verdict=no-session');
  if (sess) await ctx.addCookies([{ ...sess }]);

  await b.close();
})().catch((e) => { log('ERROR ' + e.message); process.exit(1); });
