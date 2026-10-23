import { chromium } from '/var/www/html/scripco-magento-cloud/fastly/test/node_modules/playwright/index.mjs';

const BASE = 'https://scripco.local';
const PRODUCT_URL = `${BASE}/products/cando-rubber-band-hand-exerciser/`;
const EMAIL = `cg-test-${Date.now()}@example.test`;
const SHOT = (n) => `/tmp/claude-1000/-var-www-html-scripco-magento-cloud/ebd98ddc-e586-4f32-bd2c-d449823cf240/scratchpad/journey/shots/${n}.png`;

const browser = await chromium.launch({ ignoreHTTPSErrors: true });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1600 } });
const log = (m) => console.log(`[journey] ${m}`);
page.on('pageerror', (e) => log('PAGE ERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE ERROR: ' + m.text().slice(0,200)); });

try {
  log(`1. Opening product page directly: ${PRODUCT_URL}`);
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: SHOT('01-product-page') });

  log('2. Waiting for the page form_key to be set before adding to cart');
  await page.waitForFunction(() => {
    const el = document.querySelector('input[name="form_key"]');
    return el && el.value && el.value.length > 0;
  }, { timeout: 15000 });

  log('2b. Adding to cart');
  const addToCart = page.getByRole('button', { name: /add to cart/i }).first();
  await addToCart.waitFor({ state: 'visible', timeout: 15000 });
  await addToCart.click();
  await page.waitForTimeout(500);
  const formKeyError = await page.locator('text=/invalid form key/i').first().isVisible().catch(() => false);
  if (formKeyError) {
    log('   form key still invalid after waiting - reloading once and retrying');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const el = document.querySelector('input[name="form_key"]');
      return el && el.value && el.value.length > 0;
    }, { timeout: 15000 });
    await page.getByRole('button', { name: /add to cart/i }).first().click();
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: SHOT('02-after-add-to-cart') });
  const addedOk = !(await page.locator('text=/invalid form key/i').first().isVisible().catch(() => false));
  log('   add-to-cart ok (no form-key error visible): ' + addedOk);

  log('3. Going to checkout (via /checkout/cart/)');
  await page.goto(`${BASE}/checkout/cart/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: SHOT('03-cart-page') });
  log('   cart page title: ' + await page.title());
  log('   cart page body text length: ' + (await page.locator('body').innerText()).length);

  const proceed = page.getByRole('button', { name: /proceed to checkout/i }).first();
  await proceed.waitFor({ state: 'visible', timeout: 15000 });
  await proceed.click();
  await page.waitForURL(/checkout/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: SHOT('04-checkout-shipping-step') });

  log('4. Filling guest shipping info, email = ' + EMAIL);
  const main = page.locator('.opc-wrapper'); // the real one-page-checkout container; a chat widget and header both also use id="email"/"username"
  const emailField = page.locator('.authentication-wrapper input#email');
  await emailField.waitFor({ state: 'visible', timeout: 20000 });
  await emailField.fill(EMAIL);

  await main.locator('input[name="firstname"]').first().fill('Carding');
  await main.locator('input[name="lastname"]').first().fill('Guard Test');
  await main.locator('input[name="street[0]"]').first().fill('123 Test Street');
  await main.locator('input[name="city"]').first().fill('Columbus');
  await main.locator('input[name="telephone"]').first().fill('6145551234');
  await main.locator('input[name="postcode"]').first().fill('43215');
  const country = main.locator('select[name="country_id"]').first();
  if (await country.count()) { await country.selectOption('US').catch(() => {}); }
  await page.waitForTimeout(500);
  const region = main.locator('select[name="region_id"], input[name="region"]').first();
  if (await region.count()) {
    const tag = await region.evaluate((el) => el.tagName);
    if (tag === 'SELECT') { await region.selectOption({ label: 'Ohio' }).catch(() => region.selectOption({ index: 1 })); }
    else { await region.fill('Ohio'); }
  }
  await page.screenshot({ path: SHOT('05-shipping-form-filled') });

  log('5. Selecting a shipping method');
  await page.waitForTimeout(2000);
  const shipRadio = main.locator('input[type="radio"][name="ko_unique_"], .table-checkout-shipping-method input[type="radio"]').first();
  if (await shipRadio.count()) { await shipRadio.check().catch(() => {}); }
  await page.screenshot({ path: SHOT('06-shipping-method') });

  const nextBtn = main.getByRole('button', { name: /^next$/i }).first();
  if (await nextBtn.count()) {
    await nextBtn.click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: SHOT('07-payment-step') });

  log('6. Selecting Check / Money Order payment (no gateway call)');
  const checkmoRadio = main.locator('input[type="radio"][value="checkmo"]').first();
  await checkmoRadio.waitFor({ state: 'visible', timeout: 15000 });
  await checkmoRadio.check();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: SHOT('08-checkmo-selected') });

  log('7. Placing the order');
  const placeOrder = main.getByRole('button', { name: /place order/i }).first();
  await placeOrder.waitFor({ state: 'visible', timeout: 15000 });
  await placeOrder.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: SHOT('09-after-place-order') });

  const success = await page.locator('text=/thank you|your order/i').first().isVisible().catch(() => false);
  const orderNumMatch = (await page.content()).match(/order number is[^0-9]*(\d+)/i)
    || (await page.content()).match(/order\s*#\s*(\d{7,})/i);
  log(`RESULT: success-page-visible=${success} order-number=${orderNumMatch ? orderNumMatch[1] : 'not found'}`);
  console.log('EMAIL_USED=' + EMAIL);
} catch (e) {
  log('ERROR: ' + e.message);
  await page.screenshot({ path: SHOT('ERROR') }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
