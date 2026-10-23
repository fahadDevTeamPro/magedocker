// Real guest checkout with headless Chromium; logs every guest-carts REST call with its status and age
// relative to the scq stamp; also reports when the scqc checkout proof appears. Ends with a fresh-stamp
// replay that must be BLOCKED (needs SCQ_DEBUG_TOKEN, see debug.js). No order is placed.
// Usage: node checkout.js [slow]   env: BASE_URL, STORE_CODE, PRODUCT_URL, HOST_IP, PW_CHANNEL, PW_UA
const { chromium } = require('playwright');
const { DEBUG_HEADERS, label } = require('./debug');

// Shared config for the cart-age gate tests. Override with env vars when testing another store.
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const R = `/rest/${STORE}/V1`;
const PRODUCT_URL = process.env.PRODUCT_URL || '/products/gentle-facial-brush-with-cover/';
const SLOW = process.argv.includes('slow');
const t0 = Date.now();
const log = (m) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const args = process.env.HOST_IP ? [`--host-resolver-rules=MAP ${new URL(BASE).host} ${process.env.HOST_IP}`] : [];
  const browser = await chromium.launch({ args, channel: process.env.PW_CHANNEL || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: DEBUG_HEADERS, ...(process.env.PW_UA ? { userAgent: process.env.PW_UA } : {}) });
  const page = await ctx.newPage();
  let stampTs = null;

  page.on('response', async (res) => {
    const u = res.url();
    if (!/\/rest\/.*\/(guest-carts|carts\/mine)\//.test(u) && !/checkout\/cart\/add/.test(u)) return;
    const ep = u.replace(/.*\/guest-carts\/[^/]+\//, '').replace(/.*\/carts\/mine\//, 'mine/').replace(/\?.*/, '');
    const age = stampTs ? `${Math.round(Date.now() / 1000 - stampTs)}s` : 'n/a';
    let note = '';
    const h = await res.allHeaders();
    if (h['x-scq-blocked']) note = ` <- SCQ gate (${h['x-scq-verdict'] || '?'})`;
    else if (res.status() >= 400) {
      try { note = ' ' + (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120); } catch {}
    }
    log(`${res.request().method()} ${ep.includes('cart/add') ? 'checkout/cart/add' : ep} -> ${res.status()} (stamp age ${age})${note}`);
  });

  let proofSeen = false;
  const readStamp = async () => {
    const all = await ctx.cookies(BASE);
    const c = all.find((c) => c.name === 'scq');
    if (c && !stampTs) { stampTs = parseInt(c.value.split('.')[0], 10); log(`scq cookie set: ${c.value}`); }
    const p = all.find((c) => c.name === 'scqc');
    if (p && !proofSeen) { proofSeen = true; log(`scqc proof cookie set: ${p.value}`); }
    return c;
  };

  log('open product page');
  await page.goto(BASE + PRODUCT_URL, { waitUntil: 'domcontentloaded' });
  await readStamp();
  const title = await page.title();
  log('title: ' + title);
  if (/405|403|Not allowed|Forbidden/i.test(title)) { await page.screenshot({ path: 'pdp-fail.png' }); await browser.close(); return; }
  log('click Add to Cart (real form, with uenc)');
  await page.locator('#product-addtocart-button').first().click();
  await page.waitForResponse((r) => /checkout\/cart\/add/.test(r.url()), { timeout: 30000 }).catch(() => log('no cart/add response seen'));
  await sleep(3000);
  await readStamp();

  log('open /checkout/');
  await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded' });
  await readStamp();
  try {
    await page.waitForSelector('#customer-email', { timeout: 120000 });
  } catch {
    log('checkout page did not render email field; url=' + page.url());
    await page.screenshot({ path: 'checkout-fail.png', fullPage: true });
    await browser.close();
    return;
  }
  log('fill shipping address');
  const f = async (sel, v) => { const el = page.locator(sel).first(); await el.waitFor({ timeout: 15000 }); await el.fill(v); };
  await f('#customer-email', `scq-test-${Date.now()}@example.com`);
  await f('input[name="firstname"]', 'Scq');
  await f('input[name="lastname"]', 'Gatetest');
  await f('input[name="street[0]"]', '123 Main St');
  await f('input[name="city"]', 'Chicago');
  await page.locator('select[name="country_id"]').first().selectOption('US').catch(() => {});
  await page.locator('select[name="region_id"]').first().selectOption({ label: 'Illinois' });
  await f('input[name="postcode"]', '60601');
  await f('input[name="telephone"]', '3125551234');

  log('wait for shipping methods');
  const radio = page.locator('#checkout-shipping-method-load input[type="radio"]').first();
  await radio.waitFor({ timeout: 45000 });
  await radio.check().catch(() => {});

  if (SLOW) {
    const wait = Math.max(0, 12 - (Date.now() / 1000 - stampTs));
    log(`slow mode: waiting ${wait.toFixed(0)}s so shipping-information is >10s after the stamp`);
    await sleep(wait * 1000);
  }
  log('click Next (shipping-information)');
  await page.locator('button.continue').first().click();

  log('wait for payment step');
  await page.waitForSelector('#checkout-payment-method-load .payment-method', { timeout: 60000 }).catch(() => log('payment methods did not render'));
  await sleep(4000);
  const methods = await page.locator('#checkout-payment-method-load input[name="payment[method]"]').evaluateAll((els) => els.map((e) => e.value));
  log('payment methods: ' + methods.join(', '));

  // 1. select Chase -> the checkout JS fires set-payment-information (10 s tier, stamp is old -> must pass gate)
  if (methods.includes('rootways_chase_option')) {
    log('select Chase (triggers set-payment-information; headless gets no reCAPTCHA token, expect origin 400 after ~20 s, NOT BLOCKED)');
    await page.locator('input[name="payment[method]"][value="rootways_chase_option"]').check();
    await page.waitForResponse((r) => /set-payment-information/.test(r.url()), { timeout: 40000 }).catch(() => log('no set-payment-information response within 40 s'));
  }
  // 2. place-order call from inside the page (same cookies/Origin as the real JS, no captcha token):
  //    30 s tier, stamp is old -> must pass gate; origin then rejects for missing captcha (400), NOT BLOCKED
  const cartId = await page.evaluate(() => window.checkoutConfig && window.checkoutConfig.quoteData && window.checkoutConfig.quoteData.entity_id);
  log('masked cart id from checkoutConfig: ' + cartId);
  const post = (path, body) => page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(body) });
    return { status: r.status, blocked: r.headers.get('x-scq-blocked'), verdict: r.headers.get('x-scq-verdict') || '-', text: (await r.text()).slice(0, 140) };
  }, { path, body });
  const addr = { firstname: 'Scq', lastname: 'Gatetest', street: ['123 Main St'], city: 'Chicago', region_id: 23, region: 'Illinois', country_id: 'US', postcode: '60601', telephone: '3125551234' };
  let r = await post(`${R}/guest-carts/${cartId}/payment-information`, { email: 'scq-test@example.com', paymentMethod: { method: 'rootways_chase_option' }, billingAddress: addr });
  log(`in-page payment-information (stamp age ${Math.round(Date.now() / 1000 - stampTs)}s) -> ${label(r.status, r.blocked)} verdict=${r.verdict} ${r.text}`);

  // 3. too-early case inside the browser: drop the stamp (proof stays), get a fresh one, fire immediately -> expect BLOCKED
  log('clear scq cookie and re-stamp via /checkout/cart/');
  await ctx.clearCookies({ name: 'scq' });
  await page.goto(BASE + '/checkout/cart/', { waitUntil: 'domcontentloaded' });
  stampTs = null; await readStamp();
  r = await post(`${R}/guest-carts/${cartId}/shipping-information`, { addressInformation: { shipping_address: addr, shipping_carrier_code: 'flatrate', shipping_method_code: 'flatrate' } });
  log(`in-page shipping-information (stamp age ${Math.round(Date.now() / 1000 - stampTs)}s) -> ${label(r.status, r.blocked)} verdict=${r.verdict} ${r.text}`);
  r = await post(`${R}/guest-carts/${cartId}/payment-information`, { email: 'scq-test@example.com', paymentMethod: { method: 'rootways_chase_option' }, billingAddress: addr });
  log(`in-page payment-information (stamp age ${Math.round(Date.now() / 1000 - stampTs)}s) -> ${label(r.status, r.blocked)} verdict=${r.verdict} ${r.text}`);
  await page.screenshot({ path: `checkout-${SLOW ? 'slow' : 'fast'}.png`, fullPage: true });
  await browser.close();
})().catch(async (e) => { log('ERROR ' + e.message); process.exit(1); });
