# Fastly custom VCL — guest checkout gate (MPS-17142)

Edge-only mitigation for the card-testing bot that has hit massagewarehouse.com, scriphessco.com and
allegromedical.com daily since 2026-10-09. The bot adds the cheapest SKU to a fresh guest cart and calls the
guest checkout API directly (`shipping-information` → `set-payment-information` → `payment-information`)
with a solved reCAPTCHA token. Nothing in `src/` changes; no code deploy is needed.

**20 Oct 2026 version.** From 15 Oct 17:00 UTC the bot passed the first two checks by fetching `/checkout/`
before every attempt and waiting out the timers, without ever running the page's JavaScript; it also rotates
its User-Agent and splits one cart across IPs. This version adds a third cookie, `scqj`, that only the checkout
page's own JavaScript earns, and stops telling clients which check refused them. See "Why these checks".

## How it works

Fastly issues three signed cookies and checks them before a guest checkout call reaches Magento.

| Cookie | Issued on | Proves |
|---|---|---|
| `scq` (cart-age stamp) | `POST /checkout/cart/add/…`, `GET /checkout/cart/`, `GET /checkout/` | when this browser first touched the cart |
| `scqc` (checkout proof) | `GET /checkout/` that rendered the page (200) | this browser really opened the checkout page |
| `scqj` (checkout-JS proof) | response to `POST guest-carts/<cart>/estimate-shipping-methods` or `totals-information` (any status below 500) | the checkout page's own JavaScript ran for **this cart** in **this browser** |

- **Signed with a secret plus the store host.** A cookie from another store, or with an edited timestamp,
  fails. Not bound to `PHPSESSID`: Magento's checkout controller issues a new session id on `GET /checkout/`,
  which would break every real shopper one response later.
- **Valid for 1 h, kept by the browser for 7 days.** Fastly refuses a cookie older than
  `cart_age_gate_max_age_sec`. The next cart or checkout page view renews a genuine cookie: younger than
  half the validity is left alone (a reload never restarts the wait); older, or expired, is renewed **as
  already aged**, so a shopper who returns hours later is never asked to wait. A missing or forged cookie
  gets a brand-new stamp.
- **`scqj` is signed with the cart id (from the URL) and the User-Agent**, so it is valid for one cart in one
  browser: a cookie earned for cart A fails on cart B, and a cart whose payment arrives with a different
  User-Agent fails (the bot did both on 20 Oct). Never the IP: 3.4% of real paid carts change IP mid-checkout
  (IPv4 ↔ IPv6, IPv6 privacy addresses). Valid for 7 days, the cookie lifetime, because real checkout tabs
  stay open for hours or days (seen: 6.6 h, 5 days). Kept while valid, so the wait below runs from the cart's
  first call and a reload never restarts it.
- **Why it works:** every real paid guest cart in the 30 days to 20 Oct (≈ 2,310 orders on massagewarehouse,
  allegromedical, scriphessco, advantagemedical; the other websites had no guest REST orders) made both calls
  before paying; the bot makes them in under 2% of its carts.

### What is checked

| Calls | Checks | Switch |
|---|---|---|
| `POST guest-carts/*/shipping-information`, `set-payment-information` | stamp ≥ 10 s, checkout proof | `cart_age_gate_mode`, `checkout_proof_mode` |
| `POST guest-carts/*/payment-information`, `PUT guest-carts/*/order` | stamp ≥ 30 s, checkout proof, **`scqj` for this cart and User-Agent, ≥ a secret per-cart wait (25–44 s) after it was issued** | `cart_age_gate_mode`, `checkout_proof_mode`, `scqj_mode` |
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
- **`scqj` only on payment calls**, the last step, so a real checkout page has always made its calls by then
  (133 of 134 real carts made them even before `shipping-information`; 134 of 134 before payment). The
  per-cart wait is `scqj_wait_min_sec + (hmac(secret, cart) mod scqj_wait_span_sec)`: different for every
  cart, unknown without the secret, below every real shopper (first call → payment: 61 s at p1, 82 s at p5,
  196 s median).
- **Not gated:** `GET …/payment-information` (the checkout JS calls it after coupons, store credit, gift
  cards, reward points), `estimate-shipping-methods`, `totals-information` (they issue `scqj`), coupons, every logged-in
  `carts/mine/*` call, and GraphQL queries and other mutations (`getAfterpayConfigCart`, `applyCouponToCart`,
  reviews, stock alerts). GraphQL mutations sent with GET are refused by Magento itself.
- **Express checkouts are not affected.** PayPal Express (`/paypal/express/*`) and Afterpay express
  (`/afterpay/express/*`, from product page, cart and minicart) place orders through their own controllers.
  Braintree's Apple Pay / Google Pay / PayPal buttons, which do call `shipping-information` from the product
  page, are switched off by `ScripCo_BraintreeDisabled`; re-check this gate if they are ever turned on.

**Every refusal looks the same** to the client: HTTP **400**, `{"message":"Your checkout session needs a
refresh. Please reload the checkout page and try again."}`, no verdict header, no `Retry-After`. Before
20 Oct the 429 carried `X-SCQ-Verdict` and a too-early client was told to wait 30 s, i.e. the gate told the
bot exactly what to fix. 400 is what Magento itself answers here (it never answers 429). Reloading the
checkout page fixes every case for a real shopper.

| Verdict (logged; on the response only with `X-SCQ-Debug`) | Meaning |
|---|---|
| `too-early` | stamp younger than 10 s / 30 s |
| `no-session` | no `PHPSESSID` at all |
| `no-cookie` / `bad-sig` / `stale` | stamp missing / forged / older than 1 h |
| `no-proof` / `bad-proof` / `stale-proof` | checkout page never loaded / forged / older than 1 h |
| `scqj-missing` | no `scqj` at all: the checkout JS never called estimate / totals in this browser |
| `scqj-bad` | `scqj` forged, for another cart, or from another User-Agent |
| `scqj-stale` | `scqj` older than 7 days |
| `scqj-too-early` | payment before the cart's secret wait (25–44 s) since its first checkout-JS call |
| `graphql-…` | any of the above on a GraphQL cart mutation |

The first failing check names the request. In `scqj_mode = shadow`, a payment whose only failure is
`scqj-missing` gets a copy of a real card decline instead of the refusal (see "Shadow decline").

`monitor` lets the call through and logs the would-be verdict (logging endpoint `scq_verdicts`); `block`
answers the generic JSON 400 from Fastly. Anything other than `block` behaves as `monitor` (`scqj_mode`:
anything other than `monitor` / `block` / `shadow` is `off`). The verdict is never put on a response for a
normal client, in any mode: in monitor mode it would show a script which check is being trialled.

| File | Snippet type | What it does |
|---|---|---|
| `snippets/scq_deliver.vcl` | `deliver` | Issues / renews `scq`, `scqc` and `scqj`; verdict header only for `X-SCQ-Debug` requests |
| `snippets/scq_recv.vcl` | `recv` | Normalises the path, classifies the call, checks the three cookies, logs, tags or blocks |
| `snippets/scq_error.vcl` | `error` | Turns 629 into the generic JSON `400`, 631 into the shadow decline, 630 into a JSON `403` |
| `snippets/scq_asn_block.vcl` | `recv` | Refuses checkout traffic from networks listed as `blocked_asn_<number>` (section 6) |

### Why these checks

| Bot variant | Seen | Timing check | Checkout proof |
|---|---|---|---|
| v1: shipping → place order in 2–5 s | Oct 9–14 | **blocked** (prod Oct 14 17:45 UTC, bot stopped instantly) | blocked |
| v2: waits ~33 s per cart, never loads `/checkout/` | from Oct 15 00:45 UTC | passes | **blocked** |
| v3: same flow through GraphQL (`setGuestEmailOnCart` → `setShippingAddressesOnCart` → `placeOrder` / `setPaymentMethodAndPlaceOrder`) | probing since Oct 13 (zero for the 30 days before; 124 `placeOrder` calls Oct 14–15, script errors like "must have a sub selection") | not covered before this version | **blocked** |
| URL variants `/rest/V1/…`, `/rest//<store>/…`, `/index.php/rest/…`, trailing slash | open on production until this version; only scanner noise seen (`PUT /rest/V1/guest-carts/<random>/order` → 404) | now covered | now covered |
| v4: adds to cart, fetches `/checkout/` (HTML only, no `Referer`), waits ≥ 30 s, pays; never runs the page's JavaScript; rotates User-Agent when blocked (Chrome 131 → 150 → 151) and splits one cart across IPs and User-Agents | from Oct 15 17:00 UTC (≈ 3 h after release 2) | passes | passes; **`scqj`: blocked** (no estimate / totals call in > 98% of its carts) |

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
| `scqj_mode` | `off` / `monitor` / `block` / `shadow` | checkout-JS proof on payment calls. Missing key = `off` |
| `scqj_wait_min_sec` | `25` | per-cart wait = min + (hmac(secret, cart) mod span) seconds after the cart's first `scqj` |
| `scqj_wait_span_sec` | `20` | → 25–44 s. Keep min + span below 60 (real shoppers: 61 s at p1) |
| `scqj_max_age_sec` | `604800` | `scqj` validity, 7 days = cookie lifetime. Do not shorten: tabs stay open for days |
| `scqj_shadow_body` | JSON body of a real decline | only for `shadow`; see "Shadow decline". Missing = shadow falls back to the refusal |
| `scq_debug_token` | random, e.g. `openssl rand -hex 24` | requests with `X-SCQ-Debug: <token>` get `X-SCQ-Verdict` / `X-SCQ-Blocked` back (tests). Set only while testing, then delete |

## 2. Upload the snippets

Same Fastly Configuration page → **Custom VCL snippets**, one per file (edit the existing ones on update).
Check that each snippet's content starts with the header of the right file before uploading:

| Name | Type | Priority | Content | First line contains |
|---|---|---|---|---|
| `scripco_scq_recv` | recv | 100 | `snippets/scq_recv.vcl` | `guest checkout gate (snippet type: recv` |
| `scripco_scq_deliver` | deliver | 100 | `snippets/scq_deliver.vcl` | `issue the signed checkout cookies (snippet type: deliver` |
| `scripco_scq_error` | error | 100 | `snippets/scq_error.vcl` | `responses for requests refused by scq_recv.vcl` |
| `scripco_scq_asn_block` | recv | **110** | `snippets/scq_asn_block.vcl` | `refuse checkout traffic from blocked networks` |

Then **Upload VCL to Fastly** (clones the active service version, adds the snippets, activates it). UAT first.

### Logging endpoint `scq_verdicts`

`scq_recv.vcl` logs one JSON line per gated call (`log "syslog " req.service_id " scq_verdicts :: " …`):
`action` (`pass` / `tagged` / `refused` / `shadow-declined`), `scq`, `proof`, `scqj`, `scqj_mode`, `cart`,
`host`, `client_ip`, `asn`, `ua`, and a `message` that repeats the path, so the same
`/guest-carts/<cart>/` capture works on these lines and on the origin access log. Create a logging endpoint
named exactly **`scq_verdicts`** in the Fastly service (New Relic Logs, account 7088931, format `%s`
/ message only). Verdicts are no longer visible anywhere else, so without it monitor mode measures nothing.
Check on UAT that a line arrives and that `json.escape` leaves `/` unescaped in `message`.

### Upgrading production from the 15 Oct version

`scq` and `scqc` are signed exactly as before, so no shopper's cookie becomes invalid; no monitor-first
dance is needed for them. `scqj` starts `off`.

1. Create the `scq_verdicts` logging endpoint. Add `scqj_mode` = `off` (or leave it out).
2. Upload the four snippets (UAT first, run the tests in section 5).
3. **Live immediately:** refusals by the existing checks become the generic JSON 400 (was 429 with the
   verdict). Fastly stats will show these as 400s from now on, not 429s.
4. Then roll out `scqj` as in sections 3 and 4.
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
   Application → Cookies: `scq` after add to cart, `scqc` after the checkout page loads, `scqj` right after
   (the page's own estimate / totals calls). To see verdicts, send `X-SCQ-Debug: <scq_debug_token>` (e.g. a
   header-modifying browser extension): no `X-SCQ-Verdict` on `shipping-information`,
   `set-payment-information`, `payment-information`. Place an order with a test method.
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
4. Fastly → Observability → Stats: Fastly-generated `400`s stay 0 while all switches are `monitor`.

### `scqj` in monitor mode: the false-positive check

Set `scqj_mode` = `monitor` and leave it for **at least 14 days** (≈ 1,000 real guest orders). Every payment
still reaches Magento, so a cart that was tagged and then paid is a real customer the check would have
refused: a false positive. Both sources are `Log` events in New Relic, so one nested query joins them by cart:

```
SELECT count(*) AS false_positive_carts FROM (
  SELECT filter(count(*), WHERE logtype = 'scq_verdicts' AND scqj NOT IN ('', 'pass')) AS flagged,
         filter(count(*), WHERE message LIKE '%"POST /rest/%/payment-information HTTP%" 200 %') AS paid
  FROM Log WHERE (logtype = 'scq_verdicts' OR filePath = '/var/log/platform/mecnhorvcnyok/access.log')
    AND message LIKE '%/guest-carts/%payment-information%'
  FACET capture(message, r'.*/guest-carts/(?P<cart>[A-Za-z0-9]+)/.*') LIMIT MAX)
WHERE flagged > 0 AND paid > 0 SINCE 1 day ago
```

Run it per day (the inner facet stops at 5,000 carts). Look at every hit before moving on: which verdict,
which store, which browser. With 0 hits over n real orders the 95% upper bound on the false-positive rate is
about 3 / n: 212 orders → 1.4%, 1,000 → 0.3%, 3,000 → 0.1%. The retrospective check on 20 Oct (≈ 2,310
orders, 30 days, from the origin log) found none, but it could not see cookies; only monitor mode can show
a browser that made the calls and still lost the cookie.

## 4. Block

Flip the dictionary values; takes effect in seconds, no new service version.

1. `checkout_proof_mode` = `block` (stops the current bot).
2. `graphql_gate_mode` = `block`.
3. `cart_age_gate_mode` = `block` (if not already).
4. `scqj_mode` = `block` once the monitor period shows **0 false positives** (above). Every `scqj` failure is
   then the generic refusal, which a real shopper fixes by reloading the checkout page.
5. `scqj_mode` = `shadow` only after `block` has run cleanly as well, and only with `scqj_shadow_body` set
   (next section).

During the next bot wave New Relic should show guest `shipping-information`, `set-payment-information` and
`payment-information` for the bot's host near zero while Fastly stats show the edge 400s (and the `scq_verdicts` log shows `refused`), and
`POST /checkout/cart/add/product/<id>/` for the bot SKU continuing (expected).

Bot SKUs seen so far: MW 13663, SH 340156 / 22900 / 2556, Allegro 346957 / 345945.

### Shadow decline (`scqj_mode` = `shadow`)

A payment that passed every other check but has **no `scqj` at all** (the bot's signature, never seen on a
real paid cart) gets a copy of a real Magento card decline instead of the refusal. The script sees "card
declined", discards a card it thinks is dead, and has nothing to adapt to. The call never reaches Magento or
Chase. Every other `scqj` failure stays the plain refusal, because those are the cases a real shopper could
plausibly hit (another User-Agent after a browser restart, a very fast shopper) and a fake decline cannot be
recovered from: a real shopper would believe their card was refused.

Prerequisites:

1. `block` has run without a false positive (section 4).
2. `scqj_shadow_body` = the exact body Magento returns for a declined card. Capture it on UAT with a
   declining test card (DevTools → the `payment-information` response) and paste it unchanged.
3. Accept the remaining tells: a real decline takes **2.7–3.8 s** at origin (p5–p95, 20 Oct), the shadow
   answer is immediate (VCL cannot wait), and its headers are Fastly's, not Magento's. A script that times
   or diffs responses can tell them apart. Closing that needs a delay outside VCL (Fastly Compute, or a small
   Magento endpoint that answers after ~3 s without calling Chase).

## 5. Automated checks (`test/`)

They never place an order.

```
cd fastly/test && npm install && npx playwright install chromium
export BASE_URL=https://mc.mwh-uat.scrip-inc.net STORE_CODE=massagewarehouse
export SCQ_DEBUG_TOKEN=<value of scq_debug_token>   # verdicts are only returned to this header
npm run bypass     # no browser: every URL spelling + GraphQL mutations refused; free endpoints untouched
npm run proof      # checkout proof: no checkout page / tampered proof / backdated stamp / no session -> BLOCKED
npm run journeys   # real shoppers: fast clicker, reload mid-checkout, what a blocked shopper sees
npm run checkout   # real guest checkout; logs when scq and scqc appear; fresh-stamp replay must be BLOCKED
npm run sweep10    # shipping-information + set-payment-information at 3…37 s: BLOCKED below 10 s
npm run sweep30    # PUT …/order + POST …/payment-information at 5…36 s: BLOCKED below 30 s
npm run scqj       # scqj: issued by the page's calls; missing / other cart / other UA / too early; kept on reload
MAX_AGE=60 node journeys.js J5   # only with cart_age_gate_max_age_sec=60 set temporarily
```

| Test | Case | Expected (block mode) |
|---|---|---|
| proof | empty-cart `/checkout/` (302) | no `scqc` issued |
| proof | cart page only, stamp 12 s old, no checkout page | `BLOCKED no-proof` |
| proof | after loading `/checkout/` | origin status, not BLOCKED |
| proof | `scqc` tampered / `scq` backdated 10 min / `PHPSESSID` removed | `BLOCKED bad-proof` / `bad-sig` / `no-session` |
| journeys J1 | form filled at machine speed | Next reaches the payment step (≥ 12 s) |
| journeys J2 | reload `/checkout/` after the shipping step | cookies not re-issued; Next passes |
| journeys J4 | forced too-early / forced missing proof | message shown on the page; wait / reload recovers |
| journeys J5 | cookies expired, shopper comes back | direct call `stale`; checkout page renews both; first Next passes |
| scqj | checkout page loaded | `scqj` issued by the page's own calls |
| scqj | payment with no `scqj` / for another cart / with another User-Agent | `scqj-missing` / `scqj-bad` / `scqj-bad` |
| scqj | `scqj` dropped, one estimate call, pay at once | `scqj-too-early` |
| scqj | reload `/checkout/` | `scqj` unchanged (the wait is not restarted) |
| scqj | 46 s after that `scqj` | no verdict, origin answers (400: no card, no captcha) |

`BLOCKED` = Fastly refused the call (`X-SCQ-Blocked`). In `monitor` the same tests show the verdicts with the
origin status instead. With `scqj_mode` = `block`, `sweep30` and `checkout` also show `scqj` verdicts on
payment calls made sooner than the per-cart wait; that is expected. `scqj` test 4 changes the User-Agent with
`page.setExtraHTTPHeaders`; if it reports `pass`, Chromium ignored the override, not a gate fault.

`PRODUCT_URL` picks the product used for add to cart (default is an MW item). `HOST_IP` pins the host to an
IP (IPv6 in brackets, e.g. `HOST_IP='[2a04:4e42:54::380]'`). UAT answers IPv4 clients with a 405 block page,
so pin IPv6 if browser tests fail intermittently on the product page; `bypass` already prefers IPv6. UAT is
slow (checkout page up to a minute) — run the browser tests one at a time. In `monitor` mode nothing is BLOCKED; read `X-SCQ-Verdict` on the responses (needs `SCQ_DEBUG_TOKEN`)
(`bypass` accepts either). Older edge rules answer first in two places and hide the gate from plain HTTP
tests: `403` XML on `payment-information` (`protect_payment_checkout`, needs a real browser session) and
`503` on GraphQL `placeOrder`; `bypass` reports those as `skip`.

## 6. Blocking a network (ASN)

Some card testers rent IPs from proxy / datacenter providers. When a whole network is only ever used for
attacks, `scq_asn_block.vcl` refuses its checkout traffic at the edge: add to cart, `/checkout/` pages, every
guest-cart REST call and `POST /graphql`. Browsing the store is not touched.

Dictionary `scripco_edge_config`:

| key | value |
|---|---|
| `asn_block_mode` | `monitor` (tag only, `X-SCQ-Verdict: blocked-asn` on the response) / `block` (JSON `403`) |
| `blocked_asn_<number>` | any non-empty text, used as a note. One key per network |

Proposed (zero real guest orders in 30 days, see `abuse-reports/FASTLY-BLOCK-CANDIDATES-2026-10-15.md`):
`blocked_asn_265691` = `WI-NET Telecom (PE) - main bot Oct 2026`,
`blocked_asn_200373` = `3xK Tech GmbH (DE) - Advantage card testing since 29 Sep 2026`,
`blocked_asn_198571` = `PlainProxies (3xK) - commercial proxy provider`.
No address-range block lists: attacker IPs are single-use home-internet addresses.
Evidence (New Relic access log, 11-15 Oct 2026): 410 payment attempts on Advantage from 96 IPs in 56 /24 blocks of
AS200373, all declined, 0 successful orders; the checkout page was fetched with `python-httpx/0.27.1`. Look up
a network with `whois -h whois.cymru.com " -v <ip>"`.

Upload: snippet `scripco_scq_asn_block`, type `recv`, priority **110** (it must run after `scripco_scq_recv`,
which resets `X-SCQ-Verdict`), plus the updated `scripco_scq_error`. Add `asn_block_mode` = `monitor` before
uploading.

Test on UAT with your own network (find it with `whois -h whois.cymru.com " -v $(curl -s https://ifconfig.me)"`;
UAT blocks IPv4 with a 405, so test over IPv6 and use the IPv6 address's ASN if it differs):

1. Add `blocked_asn_<your ASN>` = `test`, keep `asn_block_mode` = `monitor`.
   ```
   B=https://mc.mwh-uat.scrip-inc.net
   curl -s6 -o /dev/null -D - $B/ | grep -i x-scq                                    # nothing: browsing untouched
   curl -s6 -o /dev/null -D - $B/checkout/cart/ | grep -iE '^HTTP|x-scq'             # 200 + x-scq-verdict: blocked-asn
   ```
2. Set `asn_block_mode` = `block`: the second command returns `403` with the JSON message; the first stays `200`.
3. Remove `blocked_asn_<your ASN>`; the cart page returns `200` without the header again.
4. Production: add the three `blocked_asn_*` keys above, `asn_block_mode` = `monitor` for a day, check in New Relic Logs that
   no successful order comes from that network, then `block`:
   ```
   SELECT count(*) FROM Log WHERE filePath = '/var/log/platform/mecnhorvcnyok/access.log'
   AND message RLIKE r'^(104\.207\.(3[2-9]|4[0-7])|209\.50\.(16[0-9]|17[0-5])|216\.26\.(22[4-9]|23[0-9])|45\.3\.(3[2-9]|[45][0-9]|6[0-3])|65\.111\.([0-9]|[12][0-9]|3[01]))\..*'
   AND message LIKE '%/payment-information HTTP%' FACET capture(message, r'.*HTTP/[0-9.]+" (?P<status>[0-9]+) .*') SINCE 7 days ago
   ```

Rollback: set `asn_block_mode` to `monitor`, or delete the `blocked_asn_<number>` key.

## 7. Rollback

- Instant: set any of the switches to `monitor`; `scqj_mode` to `off` (or from `shadow` back to `block`).
- Full: deactivate or delete the snippets and Upload VCL to Fastly again.

## Known limits

- Bot cart adds and cart page views still reach Magento (~3 s PHP each, no third-party calls).
- A bot that loads `/checkout/` and waits 30 s passes `scq` / `scqc` (it did, from Oct 15), and one checkout
  page load gives a pair it can reuse for up to 1 h on that store. `scqj` closes the reuse for payments (one
  cart, one browser) and stops the current bot, but a script can earn it with one extra
  `estimate-shipping-methods` call per cart. Expect that adaptation within hours to a day, as with every
  earlier release; the secret per-cart wait then still costs it 25–44 s per cart. The lasting fixes are not
  at the edge: card velocity rules at Chase / Kount, and a check that only running the checkout JavaScript can
  pass.
- The debug token returns every verdict. Keep it long and random, set it only while testing, delete it after.
- A shopper who deletes cookies by hand but keeps the cart gets a new stamp and may be asked to wait a few
  seconds once (clearing cookies normally empties the guest cart anyway).
- Blocking `cart/add` without `/uenc/` was considered and dropped: the Hyvä PayPal Express shortcut posts to
  `checkout/cart/add/` without it.
