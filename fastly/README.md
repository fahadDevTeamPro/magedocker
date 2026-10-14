# Fastly custom VCL — guest checkout cart-age gate (MPS-17142)

Edge-only mitigation for the card-testing bot that has hit massagewarehouse.com, scriphessco.com and
allegromedical.com daily since 2026-10-09. The bot adds the cheapest SKU to a fresh guest cart and runs
`shipping-information` → `set-payment-information` → `payment-information` within ~2 s, with a solved
reCAPTCHA token on the place-order call. Per attempt it calls `estimate-shipping-methods`,
`shipping-information`, `set-payment-information` and `payment-information` on a fresh guest cart, the first
three within ~5 s of each other. These snippets refuse guest-cart REST calls that arrive too soon after the
cart was first touched. Nothing in `src/` changes; no code deploy is needed.

| File | Snippet type | What it does |
|---|---|---|
| `snippets/scq_deliver.vcl` | `deliver` | Sets the signed `scq` cookie on the first cart add / cart page / checkout page view |
| `snippets/scq_recv.vcl` | `recv` | Checks the cookie on `guest-carts/*/{shipping-information,set-payment-information,payment-information,order}`; tags or blocks |
| `snippets/scq_error.vcl` | `error` | Turns the private status 629 into a JSON `429` |

Measured effect on the current bot (New Relic, 7 days): 100% of its shipping / set-payment / place-order calls
are refused at the edge, which removes every Vertex, Google and Kount call and ~6.5 s of PHP per attempt.
Its cart add + cart page + `customer/section/load` (~3 s PHP, no external calls) still reach origin.
Bypass for the bot is trivial (wait 30 s per session), so treat this as the first layer, not the fix.

## 1. Create the edge dictionary

Magento admin → Stores → Configuration → Advanced → System → Full Page Cache → Fastly Configuration →
**Edge Dictionaries** → Add: name `scripco_edge_config`. Items:

| key | value | notes |
|---|---|---|
| `cart_age_gate_mode` | `monitor` | `monitor` = let everything through, tag refused-would-be requests with `X-SCQ-Verdict`; `block` = answer them with 429. Anything else behaves as `monitor`. |
| `cart_age_gate_secret` | output of `openssl rand -base64 32` | never commit it; rotate = all current stamps become `bad-sig` and are re-issued on the next cart touch |
| `cart_age_gate_min_sec_shipping` | `10` | seconds from first cart touch to `shipping-information` and `set-payment-information` |
| `cart_age_gate_min_sec_payment` | `30` | seconds from first cart touch to `payment-information` and `PUT …/order` |

### Why these numbers (New Relic, 2026-10-14)

Time from the first guest-cart REST call (`estimate-shipping-methods`, fired when the checkout page loads) to
each step. The stamp cookie is set earlier than that (cart add / cart page / checkout page view), so the real
margin for shoppers is larger than shown.

| Step | Bot (111 carts, Allegro 10:02–10:03 UTC) | Real guest orders (30, 3 days, all stores) |
|---|---|---|
| → `shipping-information` | 1.0 / 1.2 / 2.3 s (min / median / max) | 23 s fastest, 73 s median |
| → `set-payment-information` | 3.2 / 3.8 / 5.4 s | 31 s fastest, 105 s median |
| → `payment-information` (place order) | 6.4 / 15.9 / 49.2 s — the spread is the reCAPTCHA solver's latency | 60 s fastest, 169 s median |

Add ~3 s for the bot's cart add → cart page → `section/load` before the first REST call. The 10 s shipping /
set-payment gate therefore catches 100% of the bot with a 3× margin on the fastest real shopper; the 30 s
place-order gate is a backstop with a 2× margin. Stopping `shipping-information` already kills the attempt:
without a shipping address the place-order call fails quote validation before Kount or Chase are called.

The dictionary must exist before the snippets are uploaded or VCL compilation fails (`table.lookup` on an unknown table).

## 2. Upload the snippets

Same Fastly Configuration page → **Custom VCL snippets** → Add, one per file:

| Name | Type | Priority | Content |
|---|---|---|---|
| `scripco_scq_recv` | recv | 100 | `snippets/scq_recv.vcl` |
| `scripco_scq_deliver` | deliver | 100 | `snippets/scq_deliver.vcl` |
| `scripco_scq_error` | error | 100 | `snippets/scq_error.vcl` |

Then **Upload VCL to Fastly** (this clones the active service version, adds the snippets and activates it).
Do this on the UAT service first if `mc.*-uat.scrip-inc.net` has its own Fastly service.

## 3. Verify in monitor mode (`cart_age_gate_mode=monitor`, 24 h)

Requests the gate would refuse reach origin with `X-SCQ-Verdict: no-cookie | bad-sig | too-early`.
Nothing is blocked yet.

1. Manual guest checkout on every storefront (MW, SH, Allegro, Advantage, BWM, ProMed). After add to cart,
   DevTools → Application → Cookies shows `scq=<digits>.<base64>`. Place an order with a test method.
2. Clear cookies, open `/checkout/cart/` directly with an existing cart, complete checkout — must still work
   (stamp is set on the cart page view).
3. Confirm real orders keep flowing (New Relic, account 7088931):
   ```
   SELECT count(*) FROM Transaction WHERE request.uri LIKE '%guest-carts%/payment-information' AND request.method = 'POST' FACET http.statusCode TIMESERIES 1 hour SINCE 1 day ago
   ```
4. Fastly → Observability → Stats: `429` count stays 0.

## 4. Block (`cart_age_gate_mode=block`)

Flip the dictionary value; takes effect in seconds, no new service version.

Negative tests (curl, replace `<store>` and the masked cart id from a fresh add to cart):
- cart add → immediately `POST /rest/<store>/V1/guest-carts/<id>/shipping-information` with the `scq` cookie → `429`
  with `{"message":"Your checkout is still being prepared…"}`; retry after 10 s → reaches origin.
- immediately `POST …/set-payment-information` → `429`; after 10 s → reaches origin.
- immediately `POST …/payment-information` → `429`; after 30 s → reaches origin.
- cookie removed or last character changed → `429` (`X-SCQ-Verdict: no-cookie` / `bad-sig` on the response).
- `POST /rest/<store>/V1/carts/mine/payment-information` (logged in) → never touched.

During the next bot wave, New Relic should show `shipping-information`, `set-payment-information` and
`payment-information` counts for the bot's host near zero while Fastly stats show the 429s, and
`POST /checkout/cart/add/product/<id>/` for the bot SKU continuing (expected).

## 5. Automated checks (`test/`)

Playwright scripts that drive a real browser against a storefront. They never place an order.

```
cd fastly/test && npm install && npx playwright install chromium
BASE_URL=https://mc.mwh-uat.scrip-inc.net STORE_CODE=massagewarehouse npm run checkout   # real guest checkout, then a fresh-stamp replay that must 429
npm run sweep10    # shipping-information + set-payment-information at 3…36 s: 429 below 10 s, origin status above
npm run sweep30    # PUT …/order + POST …/payment-information at 5…35 s from /checkout/: 429 below 30 s
```

`PRODUCT_URL` picks the product page used for add-to-cart (default is an MW item). `HOST_IP` pins the host
to an IP if the browser cannot resolve it. In `monitor` mode everything passes and the sweeps show origin
statuses only; in `block` mode they show the 429 boundaries. Other edge rules (country blocking, bot rules
that need browser context) can answer 403/405/503 ahead of the gate — compare against a curl of the same URL.

## 6. Rollback

- Instant: set `cart_age_gate_mode` to `monitor` in the dictionary.
- Full: deactivate or delete the three snippets and Upload VCL to Fastly again.

## Known limits

- Does not stop the cart add / cart page / `customer/section/load` churn (~3 s PHP per attempt, no external
  calls). Options if that stays a problem: Fastly rate limiting keyed on the product id in the add-to-cart URL
  (needs rate limiting enabled on the service; boxes legit shoppers of that SKU while active), or a JS
  challenge via Fastly Next-Gen WAF (not on this account).
- Blocking `cart/add` without `/uenc/` was considered and dropped: the Hyvä PayPal Express shortcut posts to
  `checkout/cart/add/` without it, and the Allegro bot variant already includes a `uenc`.
- A bot that holds each session 30 s passes. Durable fixes (quote-age check in PHP, checkout page nonce,
  guest card minimum) are tracked separately.
