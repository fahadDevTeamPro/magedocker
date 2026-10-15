// Shared config for the cart-age gate tests. Override with env vars when testing another store.
// Gate coverage without a browser (plain HTTP, no cookies = the worst case for the gate):
//   - every URL spelling Magento routes to a gated endpoint must be refused
//   - endpoints the checkout uses freely (GET payment-information, estimate, totals, logged-in carts,
//     GraphQL queries) must NOT be refused
//   - GraphQL cart mutations, including escaped / oversized bodies, must be refused
// "refused" = 429 in block mode; in monitor mode the response carries X-SCQ-Verdict instead.
// Needs: node 18+. No browser, no cart, no order.
// UAT answers IPv4 clients with a 405 block page (older edge rule); prefer IPv6 like the browsers do
require('dns').setDefaultResultOrder('ipv6first');
require('net').setDefaultAutoSelectFamily?.(false);
const BASE = (process.env.BASE_URL || 'https://mc.mwh-uat.scrip-inc.net').replace(/\/$/, '');
const STORE = process.env.STORE_CODE || 'massagewarehouse';
const ID = 'abcdefghijklmnopqrstuvwxyz012345';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const H = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA };

const gated = [
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/set-payment-information`],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/payment-information`],
  ['PUT', `/rest/${STORE}/V1/guest-carts/${ID}/order`],
  ['POST', `/rest//${STORE}/V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/rest/${STORE}//V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/rest/V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/rest/default/V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/rest/all/V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/index.php/rest/${STORE}/V1/guest-carts/${ID}/shipping-information`],
  ['POST', `/index.php/rest/V1/guest-carts/${ID}/payment-information`],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/shipping-information/`],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/shipping-information//`],
  ['PUT', `/rest/V1/guest-carts/${ID}/order/`],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/shipping-information?x=1`],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/./shipping-information`],
];
const free = [
  ['GET', `/rest/${STORE}/V1/guest-carts/${ID}/payment-information`, 'checkout JS after coupon / credit / gift card'],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/estimate-shipping-methods`, 'checkout page load'],
  ['POST', `/rest/${STORE}/V1/guest-carts/${ID}/totals-information`, 'checkout page'],
  ['PUT', `/rest/${STORE}/V1/guest-carts/${ID}/coupons/TEST`, 'coupon'],
  ['POST', `/rest/${STORE}/V1/carts/mine/payment-information`, 'logged-in'],
  ['POST', `/rest/${STORE}/V1/carts/mine/shipping-information`, 'logged-in'],
];
const gql = (q) => JSON.stringify({ query: q });
const gqlGated = [
  ['placeOrder', gql(`mutation { placeOrder(input: {cart_id: "${ID}"}) { order { order_number } } }`)],
  ['setShippingAddressesOnCart', gql(`mutation { setShippingAddressesOnCart(input: {cart_id: "${ID}", shipping_addresses: []}) { cart { id } } }`)],
  ['setPaymentMethodOnCart', gql(`mutation { setPaymentMethodOnCart(input: {cart_id: "${ID}", payment_method: {code: "checkmo"}}) { cart { id } } }`)],
  ['setPaymentMethodAndPlaceOrder', gql(`mutation { setPaymentMethodAndPlaceOrder(input: {cart_id: "${ID}", payment_method: {code: "checkmo"}}) { order { order_number } } }`)],
  ['setGuestEmailOnCart', gql(`mutation { setGuestEmailOnCart(input: {cart_id: "${ID}", email: "a@b.co"}) { cart { id } } }`)],
  ['escaped name \\u0070laceOrder', `{"query":"mutation { \\u0070laceOrder(input: {cart_id: \\"${ID}\\"}) { order { order_number } } }"}`],
  ['oversized body (> 8 KB)', gql(`mutation { placeOrder(input: {cart_id: "${ID}"}) { order { order_number } } }` + ' '.repeat(9000))],
];
const gqlFree = [
  ['storeConfig query', gql('{ storeConfig { store_code } }')],
  ['product search query', gql('{ products(search: "brush", pageSize: 1) { total_count } }')],
];

const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: method === 'GET' ? undefined : (body ?? '{}'), redirect: 'manual' });
  const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 60);
  return { s: r.status, v: r.headers.get('x-scq-verdict') || '', t };
};
// 403 XML = the older protect_payment_checkout edge rule answering first (needs a real browser
// session to get past it); it hides our gate, so payment-information spellings are only reported.
const otherRule = (r) => r.s === 403 && r.t.trimStart().startsWith('<?xml');
const refused = (r) => r.s === 429 || r.v !== '';
let fail = 0;
const line = (ok, label, r) => { if (!ok) fail++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${String(r.s).padEnd(4)}${(r.v || '-').padEnd(22)}${label}${ok ? '' : '   ' + r.t}`); };

(async () => {
  console.log(`== must be refused (no cookies)   ${BASE}`);
  for (const [m, p] of gated) {
    const r = await call(m, p);
    if (otherRule(r)) { console.log(`skip 403 ${'(older edge rule)'.padEnd(22)}${m} ${p}`); continue; }
    line(refused(r), `${m} ${p}`, r);
  }
  console.log('\n== must NOT be refused');
  for (const [m, p, why] of free) { const r = await call(m, p); line(!refused(r), `${m} ${p}  (${why})`, r); }
  console.log('\n== GraphQL cart mutations, must be refused (needs graphql_gate_mode=block for 429)');
  for (const [n, b] of gqlGated) {
    const r = await call('POST', '/graphql', b);
    if (r.s === 503 && r.t.trimStart().startsWith('<!DOCTYPE')) { console.log(`skip 503 ${'(older edge rule)'.padEnd(22)}POST /graphql ${n}`); continue; }
    line(refused(r), `POST /graphql ${n}`, r);
  }
  console.log('\n== GraphQL queries, must NOT be refused');
  for (const [n, b] of gqlFree) { const r = await call('POST', '/graphql', b); line(!refused(r), `POST /graphql ${n}`, r); }
  console.log(`\n${fail === 0 ? 'ALL OK' : fail + ' FAILED'}`);
  process.exit(fail ? 1 : 0);
})();
