// ScripCo_CardingGuard place-order test (local Docker, MPS-17142).
// Real guest checkout in headless Chromium, ending in Place Order with a Chase card that Orbital rejects
// (local sandbox has no valid credentials). The click reaches CartManagementInterface::placeOrder, where the
// guard's plugin runs. Repeats the same seeded product until the breaker trips.
//   allowed attempt, Chase fails -> "Transaction has been declined..."  (guard outcome: declined)
//   blocked attempt              -> "Something went wrong while processing the request."
// (REST-only checkout does not work here: payment-information is stopped by reCAPTCHA before placeOrder.)
// Prereq (set and restored by hand, see the guard README): carding_guard/general/seed_product_ids = product ID,
// carding_guard/breaker/attempts low, mode = block for the store.
// Usage: node cardingguard-place-order.mjs [attempts]   env: BASE_URL, PRODUCT_URL, ATTEMPTS, WAIT_AFTER, HOST_IP, PW_CHANNEL (chrome), HEADED=1, PAY_WAIT (seconds to wait before Place Order), ADDRESS_SEARCH (text for the address search), ADDRESS (columbus | chicago | bolingbrook | franklin), BLOCK_MSG
import { chromium } from '/var/www/html/scripco-magento-cloud/fastly/test/node_modules/playwright/index.mjs';

const BASE = (process.env.BASE_URL || 'https://scripco.local').replace(/\/$/, '');
const PRODUCT_URL = process.env.PRODUCT_URL || '/products/cando-rubber-band-hand-exerciser/';
const ATTEMPTS = parseInt(process.argv[2] || process.env.ATTEMPTS || '6', 10);
const WAIT_AFTER = parseInt(process.env.WAIT_AFTER || '0', 10); // wait for the state cache after this many attempts, 0 = never
// UAT's tax service rejects the Columbus address ('Unable to complete the tax calculation'); journeys.js uses this Chicago one there.
const ADDRESSES = {
  chicago: { street: '123 Main St', city: 'Chicago', region: 'Illinois', zip: '60601', phone: '3125551234' },
  // a real, deliverable address, so the tax service can resolve it (UAT refuses made-up streets)
  bolingbrook: { street: '360 Veterans Pkwy', city: 'Bolingbrook', region: 'Illinois', zip: '60440', phone: '6305550100' },
  franklin: { street: '102 St George Way', city: 'Franklin', region: 'Kentucky', zip: '42134-5205', phone: '6546545' },
  columbus: { street: '123 Test Street', city: 'Columbus', region: 'Ohio', zip: '43215', phone: '6145551234' },
};
const ADDR = ADDRESSES[process.env.ADDRESS] || ADDRESSES.columbus;
const BLOCK_MSG = new RegExp(process.env.BLOCK_MSG || 'something went wrong while processing the request', 'i'); // set BLOCK_MSG when the admin Block Message is customised
const DECLINE_MSG = /transaction has been declined/i;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);

const hostArgs = process.env.HOST_IP ? [`--host-resolver-rules=MAP ${new URL(BASE).host} ${process.env.HOST_IP}`] : [];
const browser = await chromium.launch({
  ignoreHTTPSErrors: true, args: hostArgs,
  channel: process.env.PW_CHANNEL || undefined, // 'chrome' = the installed Google Chrome
  headless: process.env.HEADED !== '1',
  slowMo: process.env.HEADED === '1' ? 60 : 0,
});

async function attempt(n) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1800 } });
  const page = await ctx.newPage();
  let placeStatus = null;
  page.on('response', (r) => { if (/guest-carts\/[^/]+\/payment-information/.test(r.url())) placeStatus = r.status(); });
  try {
    await page.goto(BASE + PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => { const e = document.querySelector('input[name="form_key"]'); return e && e.value; }, { timeout: 20000 });
    const add = page.getByRole('button', { name: /add to cart/i }).first();
    await add.waitFor({ state: 'visible', timeout: 20000 });
    await add.click();
    await page.waitForTimeout(3000);
    await page.goto(BASE + '/checkout/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    const main = page.locator('.opc-wrapper');
    const fill = async (sel, v) => { const el = main.locator(sel).first(); await el.waitFor({ timeout: 30000 }); await el.fill(v); };
    await page.locator('#customer-email').waitFor({ timeout: 90000 });
    await page.locator('#customer-email').fill(`cg-test-${Date.now()}-${n}@example.test`);
    // Address search (Loqate Capture Plus): type into the street field and take the first suggestion
    const ADDRESS_SEARCH = process.env.ADDRESS_SEARCH || '';
    const street = main.locator('input[name="street[0]"]').first();
    let searched = false;
    if (ADDRESS_SEARCH) {
      await street.waitFor({ timeout: 30000 });
      await street.click();
      await street.pressSequentially(ADDRESS_SEARCH, { delay: 140 });
      const sug = page.locator('[class*="pca"]:visible li, [class*="pca"][role="option"], .pcaitem:visible');
      await sug.first().waitFor({ timeout: 12000 }).then(async () => {
        await street.press('ArrowDown'); await street.press('Enter');
        await page.waitForTimeout(4000);
        searched = (await main.locator('input[name="city"]').first().inputValue().catch(() => '')) !== '';
      }).catch(() => {});
      log(`address search: ${searched ? 'suggestion taken, address filled' : 'no suggestion appeared, filling by hand'}`);
    }
    await fill('input[name="firstname"]', 'Carding');
    await fill('input[name="lastname"]', 'Guard Test');
    if (!searched) {
      await fill('input[name="street[0]"]', ADDR.street);
      await fill('input[name="city"]', ADDR.city);
    }
    await fill('input[name="telephone"]', ADDR.phone);
    if (!searched) {
      await fill('input[name="postcode"]', ADDR.zip);
      await main.locator('select[name="region_id"]').first().selectOption({ label: ADDR.region });
    }
    const radio = page.locator('#checkout-shipping-method-load input[type="radio"]').first();
    await radio.waitFor({ timeout: 60000 });
    await radio.check().catch(() => {});
    await page.waitForTimeout(1500);
    await page.locator('button.continue, button:has-text("Continue to Payment")').first().click();
    await page.locator('#checkout-payment-method-load').waitFor({ state: 'visible', timeout: 60000 });

    await main.locator('input[value="rootways_chase_option"]').first().check();
    await page.waitForTimeout(1500);
    await main.locator('#rootways_chase_option_cc_number').fill('4111111111111111');
    await main.locator('#rootways_chase_option_expiration').selectOption({ index: 12 }).catch(() => {});
    await main.locator('#rootways_chase_option_expiration_yr').selectOption({ index: 4 }).catch(() => {});
    await main.locator('#rootways_chase_option_cc_cid').fill('123');
    await page.waitForTimeout(500);

    // The Fastly gate wants a real-shopper wait on the payment step (25-44 s after the checkout page's own calls).
    const PAY_WAIT = parseInt(process.env.PAY_WAIT || '0', 10);
    if (PAY_WAIT) { log(`waiting ${PAY_WAIT} s on the payment step`); await page.waitForTimeout(PAY_WAIT * 1000); }
    await main.getByRole('button', { name: /place order/i }).first().click();
    await page.waitForTimeout(9000);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    let verdict = 'UNKNOWN';
    if (/\/checkout\/onepage\/success/.test(page.url())) verdict = 'PAID';
    else if (BLOCK_MSG.test(text)) verdict = 'BLOCKED';
    else if (DECLINE_MSG.test(text)) verdict = 'DECLINED';
    const m = text.match(/(something went wrong[^.]*\.|transaction has been declined[^.]*\.|recaptcha[^.]*\.)/i);
    log(`attempt ${n}: payment-information -> ${placeStatus} ${verdict} "${m ? m[1].slice(0, 100) : ''}"`);
    if (verdict === 'UNKNOWN') await page.screenshot({ path: `cardingguard-attempt-${n}.png` });
    return verdict;
  } catch (e) {
    log(`attempt ${n}: ERROR ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `cardingguard-attempt-${n}-error.png` }).catch(() => {});
    return 'ERROR';
  } finally {
    await ctx.close();
  }
}

const out = [];
for (let i = 1; i <= ATTEMPTS; i++) {
  out.push(await attempt(i));
  if (WAIT_AFTER && i === WAIT_AFTER) { log('waiting 35 s for the guard state cache (30 s) to refresh'); await new Promise((r) => setTimeout(r, 35000)); }
}
await browser.close();
console.log('SEQUENCE=' + out.join(','));
