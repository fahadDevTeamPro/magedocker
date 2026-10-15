# Fastly custom VCL — guest checkout gate (MPS-17142)

Edge-only mitigation for the card-testing bot that has hit massagewarehouse.com, scriphessco.com and
allegromedical.com daily since 2026-10-09. The bot adds the cheapest SKU to a fresh guest cart and calls the
guest checkout API directly (`shipping-information` → `set-payment-information` → `payment-information`)
with a solved reCAPTCHA token. Nothing in `src/` changes; no code deploy is needed.

## How it works

Fastly issues two signed cookies and checks them before a guest checkout call reaches Magento.

| Cookie | Issued on | Proves |
|---|---|---|
| `scq` (cart-age stamp) | `POST /checkout/cart/add/…`, `GET /checkout/cart/`, `GET /checkout/` | when this browser first touched the cart |
| `scqc` (checkout proof) | `GET /checkout/` that rendered the page (200) | this browser really opened the checkout page |

- **Signed with a secret plus the store host.** A cookie from another store, or with an edited timestamp,
  fails. Not bound to `PHPSESSID`: Magento's checkout controller issues a new session id on `GET /checkout/`,
  which would break every real shopper one response later.
- **Valid for 1 h, kept by the browser for 7 days.** Fastly refuses a cookie older than
  `cart_age_gate_max_age_sec`. The next cart or checkout page view renews a genuine cookie: younger than
  half the validity is left alone (a reload never restarts the wait); older, or expired, is renewed **as
  already aged**, so a shopper who returns hours later is never asked to wait. A missing or forged cookie
  gets a brand-new stamp.

### What is checked

| Calls | Checks | Switch |
|---|---|---|
| `POST guest-carts/*/shipping-information`, `set-payment-information` | stamp ≥ 10 s, checkout proof | `cart_age_gate_mode`, `checkout_proof_mode` |
| `POST guest-carts/*/payment-information`, `PUT guest-carts/*/order` | stamp ≥ 30 s, checkout proof | `cart_age_gate_mode`, `checkout_proof_mode` |
| `POST /graphql` that sets an address, shipping method, payment method or guest email, or places the order | stamp ≥ 10 s, checkout proof | `graphql_gate_mode` |

- **Every URL spelling Magento accepts is covered.** Repeated slashes, a trailing slash and any prefix
  (`/rest/<store>/`, `/rest/`, `/rest/all/`, `/index.php/rest/`) are normalised before matching. Before this
  version `/rest//<store>/…`, `/rest/V1/…`, `/index.php/rest/…` and a trailing slash all skipped the gate on
  production.
- **GraphQL.** The storefront never uses GraphQL cart mutations (checkout is the REST checkout), but Magento
  accepts a full guest checkout through them, and `setPaymentMethodAndPlaceOrder` reaches Magento on
  production today with only reCAPTCHA in the way. Bodies Fastly cannot read (no `Content-Length` or over
  8 KB) and bodies with JSON-escaped letters (`placeOrder`) are treated as cart mutations. GraphQL
  queries (catalog, store config) are never touched.
- **Not gated:** `GET …/payment-information` (the checkout JS calls it after coupons, store credit, gift
  cards, reward points), `estimate-shipping-methods`, `totals-information`, coupons, every logged-in
  `carts/mine/*` call, and GraphQL queries and other mutations (`getAfterpayConfigCart`, `applyCouponToCart`,
  reviews, stock alerts). GraphQL mutations sent with GET are refused by Magento itself.
- **Express checkouts are not affected.** PayPal Express (`/paypal/express/*`) and Afterpay express
  (`/afterpay/express/*`, from product page, cart and minicart) place orders through their own controllers.
  Braintree's Apple Pay / Google Pay / PayPal buttons, which do call `shipping-information` from the product
  page, are switched off by `ScripCo_BraintreeDisabled`; re-check this gate if they are ever turned on.

| Verdict (`X-SCQ-Verdict`) | Meaning | What the shopper sees in block mode |
|---|---|---|
| `too-early` | stamp younger than 10 s / 30 s | "Your checkout is still being prepared. Please wait a moment and try again." |
| `no-session` | no `PHPSESSID` at all | "Your checkout session needs a refresh. Please reload the checkout page and try again." |
| `no-cookie` / `bad-sig` / `stale` | stamp missing / forged / older than 1 h | same refresh message |
| `no-proof` / `bad-proof` / `stale-proof` | checkout page never loaded / forged / older than 1 h | same refresh message |
| `graphql-…` | any of the above on a GraphQL cart mutation | 429 JSON |

`monitor` lets the call through and puts the would-be verdict on the response as `X-SCQ-Verdict`;
`block` answers `429` JSON from Fastly. Anything other than `block` behaves as `monitor`.

| File | Snippet type | What it does |
|---|---|---|
| `snippets/scq_deliver.vcl` | `deliver` | Issues / renews `scq` and `scqc`; echoes the verdict in monitor mode |
| `snippets/scq_recv.vcl` | `recv` | Normalises the path, classifies the call, checks both cookies, tags or blocks |
| `snippets/scq_error.vcl` | `error` | Turns the private status 629 into a JSON `429` |

### Why these checks

| Bot variant | Seen | Timing check | Checkout proof |
|---|---|---|---|
| v1: shipping → place order in 2–5 s | Oct 9–14 | **blocked** (prod Oct 14 17:45 UTC, bot stopped instantly) | blocked |
| v2: waits ~33 s per cart, never loads `/checkout/` | from Oct 15 00:45 UTC | passes | **blocked** |
| v3: same flow through GraphQL (`setGuestEmailOnCart` → `setShippingAddressesOnCart` → `placeOrder` / `setPaymentMethodAndPlaceOrder`) | probing since Oct 13 (zero for the 30 days before; 124 `placeOrder` calls Oct 14–15, script errors like "must have a sub selection") | not covered before this version | **blocked** |
| URL variants `/rest/V1/…`, `/rest//<store>/…`, `/index.php/rest/…`, trailing slash | open on production until this version; only scanner noise seen (`PUT /rest/V1/guest-carts/<random>/order` → 404) | now covered | now covered |

Real guests always load `/checkout/` before any of these calls. Time from the checkout page loading
(first `estimate-shipping-methods`) to each step, New Relic 2026-10-14:

| Step | Bot v1 (111 carts) | Bot v2 (Oct 15) | Real guest orders (30, 3 days) |
|---|---|---|---|
| → `shipping-information` | 1.0 / 1.2 / 2.3 s (min / median / max) | 33–35 s | 23 s fastest, 73 s median |
| → `set-payment-information` | 3.2 / 3.8 / 5.4 s | ~36 s | 31 s fastest, 105 s median |
| → `payment-information` | 6.4 / 15.9 / 49.2 s | 47–75 s | 60 s fastest, 169 s median |

A script filling the checkout form at machine speed reaches Next 12 s after the cart stamp (UAT test), so
the 10 s wait cannot be hit by a person.

## 1. Edge dictionary `scripco_edge_config`

Magento admin → Stores → Configuration → Advanced → System → Full Page Cache → Fastly Configuration →
**Edge Dictionaries**. Must exist before the snippets are uploaded or VCL compilation fails.

| key | value | notes |
|---|---|---|
| `cart_age_gate_mode` | `monitor` / `block` | REST timing check |
| `checkout_proof_mode` | `monitor` / `block` | REST checkout-page proof. Missing key = `monitor` |
| `graphql_gate_mode` | `monitor` / `block` | GraphQL cart mutations. Missing key = `monitor` |
| `cart_age_gate_secret` | output of `openssl rand -base64 32` | never commit it. Rotating it makes every cookie `bad-sig` until the next page view |
| `cart_age_gate_min_sec_shipping` | `10` | seconds from stamp to `shipping-information` / `set-payment-information` / GraphQL |
| `cart_age_gate_min_sec_payment` | `30` | seconds from stamp to `payment-information` / `PUT …/order` |
| `cart_age_gate_max_age_sec` | `3600` | cookie validity. Missing key = 3600 |

## 2. Upload the snippets

Same Fastly Configuration page → **Custom VCL snippets**, one per file (edit the existing ones on update).
Check that each snippet's content starts with the header of the right file before uploading:

| Name | Type | Priority | Content | First line contains |
|---|---|---|---|---|
| `scripco_scq_recv` | recv | 100 | `snippets/scq_recv.vcl` | `guest checkout gate (snippet type: recv` |
| `scripco_scq_deliver` | deliver | 100 | `snippets/scq_deliver.vcl` | `issue the signed checkout cookies (snippet type: deliver` |
| `scripco_scq_error` | error | 100 | `snippets/scq_error.vcl` | `JSON 429 for requests refused by scq_recv.vcl` |

Then **Upload VCL to Fastly** (clones the active service version, adds the snippets, activates it). UAT first.
`Unused table redirects` in the validation output is an existing warning, not an error.

### Upgrading production from the first version (`cart_age_gate_mode=block` today)

The cookie signature changed (now includes the store host), so every `scq` cookie issued by the old VCL is
`bad-sig` the moment the new VCL is live. Shoppers already on the checkout page would get a 429 until they
reload. To avoid that:

1. Add `checkout_proof_mode` = `monitor`, `graphql_gate_mode` = `monitor`, `cart_age_gate_max_age_sec` = `3600`.
2. Set `cart_age_gate_mode` = `monitor`.
3. Upload the new snippets.
4. After 1 h (everyone mid-checkout has reloaded a page by then), set `cart_age_gate_mode` = `block`.

## 3. Verify in monitor mode (24 h)

Nothing is blocked; the would-be verdict is on each gated response as `X-SCQ-Verdict`.

1. Manual guest checkout on every storefront (MW, SH, Allegro, Advantage, BWM, ProMed). DevTools →
   Application → Cookies: `scq` after add to cart, `scqc` after the checkout page loads. Network tab: no
   `X-SCQ-Verdict` on `shipping-information`, `set-payment-information`, `payment-information`.
   Place an order with a test method.
2. Also: apply a coupon / store credit on the payment step; PayPal Express from the checkout page; Afterpay;
   come back to a cart after more than an hour and check out.
3. Real orders keep flowing (New Relic, account 7088931; `http.statusCode` is numeric, write `= 200`):
   ```
   SELECT count(*) FROM Transaction WHERE appName = 'mecnhorvcnyok'
   AND request.uri LIKE '%/payment-information' AND request.method = 'POST' AND http.statusCode = 200
   FACET request.headers.host, capture(request.uri, r'.*/(?P<kind>guest-carts|carts/mine)/.*')
   TIMESERIES 1 hour SINCE 2 days ago
   ```
   Guest orders should move in step with logged-in orders, same as the previous day.
4. Fastly → Observability → Stats: `429` count stays 0 while all switches are `monitor`.

## 4. Block

Flip the dictionary values; takes effect in seconds, no new service version.

1. `checkout_proof_mode` = `block` (stops the current bot).
2. `graphql_gate_mode` = `block`.
3. `cart_age_gate_mode` = `block` (if not already).

During the next bot wave New Relic should show guest `shipping-information`, `set-payment-information` and
`payment-information` for the bot's host near zero while Fastly stats show the 429s, and
`POST /checkout/cart/add/product/<id>/` for the bot SKU continuing (expected).

Bot SKUs seen so far: MW 13663, SH 340156 / 22900 / 2556, Allegro 346957 / 345945.

## 5. Automated checks (`test/`)

They never place an order.

```
cd fastly/test && npm install && npx playwright install chromium
export BASE_URL=https://mc.mwh-uat.scrip-inc.net STORE_CODE=massagewarehouse
npm run bypass     # no browser: every URL spelling + GraphQL mutations refused; free endpoints untouched
npm run proof      # checkout proof: no checkout page / tampered proof / backdated stamp / no session -> 429
npm run journeys   # real shoppers: fast clicker, reload mid-checkout, what a blocked shopper sees
npm run checkout   # real guest checkout; logs when scq and scqc appear; fresh-stamp replay must 429
npm run sweep10    # shipping-information + set-payment-information at 3…37 s: 429 below 10 s
npm run sweep30    # PUT …/order + POST …/payment-information at 5…36 s: 429 below 30 s
MAX_AGE=60 node journeys.js J5   # only with cart_age_gate_max_age_sec=60 set temporarily
```

| Test | Case | Expected (block mode) |
|---|---|---|
| proof | empty-cart `/checkout/` (302) | no `scqc` issued |
| proof | cart page only, stamp 12 s old, no checkout page | `429 no-proof` |
| proof | after loading `/checkout/` | origin status, not 429 |
| proof | `scqc` tampered / `scq` backdated 10 min / `PHPSESSID` removed | `429 bad-proof` / `bad-sig` / `no-session` |
| journeys J1 | form filled at machine speed | Next reaches the payment step (≥ 12 s) |
| journeys J2 | reload `/checkout/` after the shipping step | cookies not re-issued; Next passes |
| journeys J4 | forced too-early / forced missing proof | message shown on the page; wait / reload recovers |
| journeys J5 | cookies expired, shopper comes back | direct call `stale`; checkout page renews both; first Next passes |

`PRODUCT_URL` picks the product used for add to cart (default is an MW item). `HOST_IP` pins the host to an
IP (IPv6 in brackets, e.g. `HOST_IP='[2a04:4e42:54::380]'`). UAT answers IPv4 clients with a 405 block page,
so pin IPv6 if browser tests fail intermittently on the product page; `bypass` already prefers IPv6. UAT is
slow (checkout page up to a minute) — run the browser tests one at a time. In `monitor` mode nothing is 429; read `X-SCQ-Verdict` on the responses
(`bypass` accepts either). Older edge rules answer first in two places and hide the gate from plain HTTP
tests: `403` XML on `payment-information` (`protect_payment_checkout`, needs a real browser session) and
`503` on GraphQL `placeOrder`; `bypass` reports those as `skip`.

## 6. Rollback

- Instant: set any of the three switches to `monitor`.
- Full: deactivate or delete the three snippets and Upload VCL to Fastly again.

## Known limits

- Bot cart adds and cart page views still reach Magento (~3 s PHP each, no third-party calls).
- A bot that loads `/checkout/` (our heaviest page) and waits 30 s passes, and one checkout page load gives
  a cookie pair it can reuse for up to 1 h on that store. Roughly triples its cost per attempt; every card
  is still declined by Kount. Next steps if it happens: per-SKU add-to-cart rate limit at the edge, or a
  server-side check / guest card minimum in Magento.
- A shopper who deletes cookies by hand but keeps the cart gets a new stamp and may be asked to wait a few
  seconds once (clearing cookies normally empties the guest cart anyway).
- Blocking `cart/add` without `/uenc/` was considered and dropped: the Hyvä PayPal Express shortcut posts to
  `checkout/cart/add/` without it.
