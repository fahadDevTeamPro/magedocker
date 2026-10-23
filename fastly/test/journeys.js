const { chromium } = require('playwright');
const { DEBUG_HEADERS } = require('./debug');
// Shared config for the cart-age gate tests. Override with env vars when testing another store.
// Real-shopper journeys in a real browser. No order is placed (stops before payment).
//   J1 fast clicker: Next clicked < 10 s after the cart stamp -> BLOCKED too-early, message shown on the
//      page; Next again after the wait -> shipping step passes
//   J2 reload mid-checkout: reload /checkout/ after the shipping step -> cookies not re-stamped,
//      Next passes straight away
//   J3 (info) cart cookies deleted by hand, session and cart kept (rare: clearing cookies normally
//      drops the cart too), opens
//      /checkout/ and clicks Next as soon as the form is filled -> reports what the shopper sees
//   J5 returning shopper after the cookies expired (needs cart_age_gate_max_age_sec set low, e.g. 60,
//      and MAX_AGE=60 in the env): stale cookies refused on a direct call, renewed by the checkout
//      page view as already aged -> fast Next passes with no wait
//   J4 what a blocked shopper sees: forced too-early (fresh stamp) and forced missing proof, the
//      message must be visible on the page and the shopper must recover (wait / reload). Since
//      20 Oct 2026 every refusal shows the same "reload the checkout page" message.
// BLOCKED = Fastly refused the call (X-SCQ-Blocked); needs SCQ_DEBUG_TOKEN, see debug.js.
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const PRODUCT_URL = process.env.PRODUCT_URL || '/products/gentle-facial-brush-with-cover/';
const ONLY = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s] ${m}`);

async function shopper(b, name) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: DEBUG_HEADERS });
  const page = await ctx.newPage();
  const calls = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (!/\/guest-carts\/[^/]+\/(shipping-information|set-payment-information|payment-information|order)/.test(u)) return;
    const ep = u.replace(/.*\/guest-carts\/[^/]+\//, '').replace(/\?.*/, '');
    const h = await res.allHeaders();
    const v = h['x-scq-verdict'] || '-';
    calls.push({ ep, status: res.status(), blocked: !!h['x-scq-blocked'], v });
    log(`${name}: ${res.request().method()} ${ep} -> ${res.status()} verdict=${v} (stamp age ${await age()}s)`);
  });
  const cookie = async (n) => (await ctx.cookies(BASE)).find((c) => c.name === n);
  const age = async () => { const c = await cookie('scq'); return c ? Math.round(Date.now() / 1000 - parseInt(c.value, 10)) : 'n/a'; };
  const addToCart = async () => {
    // UAT answers IPv4 clients with a 405 block page; retry so a stray IPv4 connection doesn't fail the run
    for (let i = 1; ; i++) {
      const r = await page.goto(BASE + PRODUCT_URL, { waitUntil: 'domcontentloaded' });
      const ok = await page.locator('#product-addtocart-button').first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      if (ok) break;
      log(`${name}: product page attempt ${i} -> ${r && r.status()} "${await page.title()}"`);
      if (i === 4) throw new Error('product page never showed the add-to-cart button');
      await sleep(3000);
    }
    await page.locator('#product-addtocart-button').first().click();
    const added = await page.waitForResponse((r) => /checkout\/cart\/add/.test(r.url()), { timeout: 30000 });
    // let the add finish completely: UAT writes the session after the response starts, and a /checkout/
    // request that reads it too early is redirected to the cart and loses the quote for this session
    await added.finished();
    await sleep(3000);
  };
  const openCheckout = async () => {
    await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('#customer-email', { timeout: 120000 }).catch((e) => { log(`${name}: checkout page did not render, at ${page.url()}`); throw e; });
  };
  const fill = async () => {
    const f = async (sel, v) => { const el = page.locator(sel).first(); await el.waitFor({ timeout: 30000 }); await el.fill(v); };
    await f('#customer-email', `scq-journey-${Date.now()}@example.com`);
    await f('input[name="firstname"]', 'Scq');
    await f('input[name="lastname"]', 'Journey');
    await f('input[name="street[0]"]', '123 Main St');
    await f('input[name="city"]', 'Chicago');
    await page.locator('select[name="country_id"]').first().selectOption('US').catch(() => {});
    await page.locator('select[name="region_id"]').first().selectOption({ label: 'Illinois' });
    await f('input[name="postcode"]', '60601');
    await f('input[name="telephone"]', '3125551234');
    const radio = page.locator('#checkout-shipping-method-load input[type="radio"]').first();
    await radio.waitFor({ timeout: 60000 });
    await radio.check().catch(() => {});
  };
  const next = async () => {
    const resp = page.waitForResponse((r) => /shipping-information/.test(r.url()), { timeout: 60000 });
    await page.locator('button.continue').first().click();
    const r = await resp;
    await sleep(1500);
    const msgs = (await page.locator('.message-error, .message.error, div[role="alert"]').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    const onPayment = await page.locator('#checkout-payment-method-load').isVisible().catch(() => false);
    const h = await r.allHeaders();
    return { status: r.status(), blocked: !!h['x-scq-blocked'], verdict: h['x-scq-verdict'] || '-', msgs, onPayment };
  };
  return { ctx, page, cookie, age, addToCart, openCheckout, fill, next, calls };
}

(async () => {
  const b = await chromium.launch({ args: process.env.HOST_IP ? [`--host-resolver-rules=MAP ${new URL(BASE).host} ${process.env.HOST_IP}`] : [] });
  const results = [];
  const run = (id) => ONLY.length === 0 || ONLY.includes(id);

  if (run('J1')) {
    const s = await shopper(b, 'J1');
    await s.addToCart();
    await s.openCheckout();
    // simulate the fastest possible shopper: Next as soon as the form allows, timed off the stamp
    await s.fill();
    log(`J1: form filled, stamp age ${await s.age()}s, clicking Next`);
    const first = await s.next();
    log(`J1: first Next -> ${first.status} ${first.verdict}; page message: ${JSON.stringify(first.msgs)}; payment step shown: ${first.onPayment}`);
    await s.page.screenshot({ path: 'journey-J1-blocked.png', fullPage: true });
    const wait = Math.max(0, 11 - (await s.age()));
    log(`J1: waiting ${wait}s, clicking Next again`);
    await sleep(wait * 1000);
    const second = first.onPayment ? first : await s.next();
    log(`J1: second Next -> ${second.status} ${second.verdict}; payment step shown: ${second.onPayment}`);
    results.push(['J1 fast clicker: first Next blocked with a visible message', first.blocked && first.msgs.length > 0 ? 'OK' : (first.status === 200 ? 'n/a (slower than 10 s)' : 'FAIL')]);
    results.push(['J1 fast clicker: Next after waiting reaches payment step', second.onPayment ? 'OK' : 'FAIL']);
    await s.ctx.close();
  }

  if (run('J2')) {
    const s = await shopper(b, 'J2');
    await s.addToCart();
    await s.openCheckout();
    await sleep(Math.max(0, 12 - (await s.age())) * 1000);
    await s.fill();
    const first = await s.next();
    log(`J2: shipping step -> ${first.status}; payment step shown: ${first.onPayment}`);
    const before = { scq: (await s.cookie('scq'))?.value, scqc: (await s.cookie('scqc'))?.value };
    log('J2: reloading /checkout/');
    await s.openCheckout();
    const after = { scq: (await s.cookie('scq'))?.value, scqc: (await s.cookie('scqc'))?.value };
    log(`J2: scq ${before.scq === after.scq ? 'unchanged' : 'RE-ISSUED'}, scqc ${before.scqc === after.scqc ? 'unchanged' : 'RE-ISSUED'}`);
    await s.page.goto(BASE + '/checkout/#shipping', { waitUntil: 'domcontentloaded' });
    await s.page.waitForSelector('button.continue', { timeout: 120000 });
    await s.fill().catch(() => {});
    const again = await s.next();
    log(`J2: Next after reload -> ${again.status} ${again.verdict}; payment step shown: ${again.onPayment}`);
    results.push(['J2 reload: cookies not re-stamped', before.scq === after.scq && before.scqc === after.scqc ? 'OK' : 'FAIL']);
    results.push(['J2 reload: Next passes straight away', !again.blocked ? 'OK' : 'FAIL']);
    await s.ctx.close();
  }

  if (run('J3')) {
    const s = await shopper(b, 'J3');
    await s.addToCart();
    await sleep(15000);
    await s.ctx.clearCookies({ name: 'scq' });
    await s.ctx.clearCookies({ name: 'scqc' });
    log('J3: cart cookies dropped (as if expired), session + cart kept; opening /checkout/');
    await s.openCheckout();
    await s.fill();
    log(`J3: form filled, stamp age ${await s.age()}s, clicking Next`);
    const first = await s.next();
    log(`J3: Next -> ${first.status} ${first.verdict}; message: ${JSON.stringify(first.msgs)}; payment step shown: ${first.onPayment}`);
    results.push(['J3 (info) cookies deleted by hand, cart kept: first Next', !first.blocked ? 'passes' : `asked to wait (${first.verdict}) - expected, stamp is new`]);
    await s.ctx.close();
  }

  if (run('J4')) {
    const s = await shopper(b, 'J4');
    await s.addToCart();
    await s.openCheckout();
    await s.fill();
    // a) force too-early: swap in a brand-new stamp right before Next
    await s.ctx.clearCookies({ name: 'scq' });
    await s.page.evaluate(() => fetch('/checkout/cart/', { credentials: 'include' }));
    const a = await s.next();
    log(`J4a too-early: ${a.status} ${a.verdict}; message: ${JSON.stringify(a.msgs)}; still on shipping step: ${!a.onPayment}`);
    await s.page.screenshot({ path: 'journey-J4a-too-early.png', fullPage: true });
    await sleep(Math.max(0, 11 - (await s.age())) * 1000);
    const a2 = await s.next();
    log(`J4a after waiting: ${a2.status}; payment step shown: ${a2.onPayment}`);
    results.push(['J4a too-early: message visible on the page', a.blocked && a.msgs.some((m) => /reload the checkout page/i.test(m)) ? 'OK' : `FAIL (${JSON.stringify(a.msgs)})`]);
    results.push(['J4a too-early: shopper recovers by clicking Next again later', !a2.blocked ? 'OK' : 'FAIL']);
    // b) force missing proof: drop scqc, Next -> refresh message; reload the page -> works
    await s.page.goto(BASE + '/checkout/#shipping', { waitUntil: 'domcontentloaded' });
    await s.page.waitForSelector('button.continue', { timeout: 120000 });
    await s.ctx.clearCookies({ name: 'scqc' });
    await s.fill().catch(() => {});
    const bb = await s.next();
    log(`J4b no proof: ${bb.status} ${bb.verdict}; message: ${JSON.stringify(bb.msgs)}`);
    await s.page.screenshot({ path: 'journey-J4b-no-proof.png', fullPage: true });
    await s.page.reload({ waitUntil: 'domcontentloaded' });
    await s.page.waitForSelector('button.continue', { timeout: 120000 });
    await s.fill().catch(() => {});
    const b2 = await s.next();
    log(`J4b after reload: ${b2.status} ${b2.verdict}`);
    results.push(['J4b no proof: reload message visible on the page', bb.blocked && bb.msgs.some((m) => /reload the checkout page/i.test(m)) ? 'OK' : `FAIL (${JSON.stringify(bb.msgs)})`]);
    results.push(['J4b no proof: shopper recovers by reloading the page', !b2.blocked ? 'OK' : `FAIL (${b2.verdict})`]);
    await s.ctx.close();
  }

  if (ONLY.includes('J5')) {
    const MAX = parseInt(process.env.MAX_AGE || '0', 10);
    if (!MAX) { log('J5 skipped: set MAX_AGE to the dictionary value of cart_age_gate_max_age_sec'); }
    else {
      const s = await shopper(b, 'J5');
      await s.addToCart();
      await s.openCheckout();
      const before = { scq: (await s.cookie('scq')).value, scqc: (await s.cookie('scqc')).value };
      log(`J5: cookies issued; waiting ${MAX + 5}s until they expire (validity ${MAX}s)`);
      await sleep((MAX + 5) * 1000);
      const cartId = await s.page.evaluate(() => window.checkoutConfig.quoteData.entity_id);
      const direct = await s.page.evaluate(async ({ cartId, store }) => {
        const r = await fetch(`/rest/${store}/V1/guest-carts/${cartId}/shipping-information`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: '{}' });
        return `${r.status} ${r.headers.get('x-scq-verdict') || '-'}`;
      }, { cartId, store: STORE });
      log(`J5: direct call with expired cookies -> ${direct}`);
      await s.openCheckout();
      const after = { scq: (await s.cookie('scq')).value, scqc: (await s.cookie('scqc')).value };
      const ageNow = Math.round(Date.now() / 1000 - parseInt(after.scq, 10));
      log(`J5: after checkout page view: scq ${after.scq !== before.scq ? 'renewed' : 'NOT renewed'} (age ${ageNow}s), scqc ${after.scqc !== before.scqc ? 'renewed' : 'NOT renewed'}`);
      await s.fill();
      const n = await s.next();
      log(`J5: fast Next -> ${n.status} ${n.verdict}; payment step shown: ${n.onPayment}`);
      results.push(['J5 expired cookies refused on a direct call', /stale/.test(direct) ? 'OK' : `FAIL (${direct})`]);
      results.push(['J5 checkout page view renews both, scq already aged', after.scq !== before.scq && after.scqc !== before.scqc && ageNow >= 25 ? 'OK' : 'FAIL']);
      results.push(['J5 returning shopper passes on first Next', !n.blocked ? 'OK' : `FAIL (${n.verdict})`]);
      await s.ctx.close();
    }
  }

  await b.close();
  console.log('\n=== summary');
  for (const [k, v] of results) console.log(`${v.padEnd(24)} ${k}`);
})().catch((e) => { log('ERROR ' + e.message); process.exit(1); });
