# MPS-17142: issue the signed checkout cookies (snippet type: deliver, priority 100)
#
# Pairs with scq_recv.vcl. Three cookies, all signed with cart_age_gate_secret:
#
#   scq  = <ts>.<hmac(secret, ts.host)>           "cart age" stamp, on POST /checkout/cart/add/...,
#                                                 GET /checkout/cart/ and GET /checkout/
#   scqc = <ts>.<hmac(secret, ts.host.checkout)>  "checkout page seen" proof, only when GET /checkout/
#                                                 rendered (200; an empty cart gets a 302 and no proof)
#   scqj = <ts>.<hmac(secret, "scqj|" ts "|" host "|" cart "|" User-Agent)>
#                                                 "checkout JS ran" proof for one cart, on the response to
#                                                 POST guest-carts/<cart>/estimate-shipping-methods or
#                                                 totals-information (any origin status below 500). The
#                                                 checkout page's JavaScript makes these calls; a script
#                                                 that only replays the API usually does not.
#
# Validity vs. browser lifetime: scq_recv.vcl accepts scq / scqc for cart_age_gate_max_age_sec (1 h).
# The browser keeps them for 7 days, so a shopper who comes back later still sends them, and the next
# cart / checkout page view renews them here:
#   - no cookie or bad signature   -> new stamp, ts = now (the 10 s / 30 s wait starts now)
#   - valid, younger than half the validity -> left alone (reloads never restart the wait)
#   - valid, older (also expired)  -> renewed as already aged, ts = now - min_sec_payment, so a
#                                     returning shopper is never told to wait. Only a genuine stamp
#                                     can be renewed, and only by a page view.
#   scqc is renewed with ts = now on the same rule (it has no wait).
#   scqj is kept while it is valid for this cart and browser (scqj_max_age_sec, 7 days), so the
#   per-cart wait in scq_recv.vcl runs from the cart's first call and a reload never restarts it.
#   It is issued again only when missing, forged, for another cart or User-Agent, or expired.
#
# Not bound to PHPSESSID: Magento's checkout controller regenerates the session id on GET /checkout/,
# so a cookie signed with the request's PHPSESSID is wrong one response later.
#
# The verdict header goes back only to requests with X-SCQ-Debug = scq_debug_token (fastly/test).
# Shown to everyone in monitor mode, it told a script which check was being trialled.
# Edge nodes only, never on the shield. Not set for the Fastly module tester (bypass-secret).

declare local var.scq_path STRING;
declare local var.scq_debug BOOL;
set var.scq_path = regsuball(req.url.path, "/{2,}", "/");

# verdict header for fastly/test only (X-SCQ-Debug must match the dictionary key scq_debug_token)
set var.scq_debug = false;
if (table.lookup(scripco_edge_config, "scq_debug_token", "") != ""
    && req.http.X-SCQ-Debug == table.lookup(scripco_edge_config, "scq_debug_token", "")) {
    set var.scq_debug = true;
}
if (var.scq_debug && req.http.X-SCQ-Verdict && fastly.ff.visits_this_service == 0) {
    set resp.http.X-SCQ-Verdict = req.http.X-SCQ-Verdict;
}

if (fastly.ff.visits_this_service == 0
    && !req.http.bypass-secret
    && ((req.method == "POST" && var.scq_path ~ "^/checkout/cart/add/")
        || (req.method == "GET" && var.scq_path ~ "^/checkout(/cart(/index)?|/index(/index)?)?/?$"))) {

    declare local var.scq_now INTEGER;
    declare local var.scq_now_s STRING;
    declare local var.scq_ts INTEGER;
    declare local var.scq_ts_s STRING;
    declare local var.scq_refresh INTEGER;
    declare local var.scq_secret STRING;
    declare local var.scq_is_checkout BOOL;
    declare local var.scq_state STRING;
    declare local var.scq_cookie_attrs STRING;

    set var.scq_now_s = strftime({"%s"}, now);
    set var.scq_now = std.atoi(var.scq_now_s);
    set var.scq_secret = table.lookup(scripco_edge_config, "cart_age_gate_secret", "");
    set var.scq_refresh = std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_max_age_sec", "3600"));
    set var.scq_refresh /= 2;
    set var.scq_cookie_attrs = "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800";

    # decide the page type before any cookie regex runs (regex matches overwrite re.group.*)
    set var.scq_is_checkout = false;
    if (req.method == "GET" && resp.status == 200 && var.scq_path ~ "^/checkout(/index(/index)?)?/?$") {
        set var.scq_is_checkout = true;
    }

    # --- scq: state = new | keep | renew
    set var.scq_state = "new";
    if (req.http.Cookie:scq ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
        if (re.group.2 == digest.hmac_sha256_base64(var.scq_secret, re.group.1 "." req.http.host)) {
            set var.scq_ts = std.atoi(re.group.1);
            set var.scq_ts += var.scq_refresh;
            if (var.scq_now < var.scq_ts) {
                set var.scq_state = "keep";
            } else {
                set var.scq_state = "renew";
            }
        }
    }
    if (var.scq_state == "new") {
        add resp.http.Set-Cookie = "scq=" var.scq_now_s "." digest.hmac_sha256_base64(var.scq_secret, var.scq_now_s "." req.http.host) var.scq_cookie_attrs;
    } else if (var.scq_state == "renew") {
        set var.scq_ts = var.scq_now;
        set var.scq_ts -= std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_min_sec_payment", "30"));
        set var.scq_ts_s = "" var.scq_ts;
        add resp.http.Set-Cookie = "scq=" var.scq_ts_s "." digest.hmac_sha256_base64(var.scq_secret, var.scq_ts_s "." req.http.host) var.scq_cookie_attrs;
    }

    # --- scqc: only on a rendered checkout page; new or renewed with ts = now
    if (var.scq_is_checkout) {
        set var.scq_state = "new";
        if (req.http.Cookie:scqc ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
            if (re.group.2 == digest.hmac_sha256_base64(var.scq_secret, re.group.1 "." req.http.host ".checkout")) {
                set var.scq_ts = std.atoi(re.group.1);
                set var.scq_ts += var.scq_refresh;
                if (var.scq_now < var.scq_ts) {
                    set var.scq_state = "keep";
                }
            }
        }
        if (var.scq_state != "keep") {
            add resp.http.Set-Cookie = "scqc=" var.scq_now_s "." digest.hmac_sha256_base64(var.scq_secret, var.scq_now_s "." req.http.host ".checkout") var.scq_cookie_attrs;
        }
    }
}

# --- scqj: checkout-JS proof for one cart
# Any origin status below 500 counts: the call itself is the proof, whatever Magento answered.
# Skipped when scq_asn_block.vcl tagged the request (blocked network).
if (fastly.ff.visits_this_service == 0
    && !req.http.bypass-secret
    && !req.http.X-SCQ-Verdict
    && req.method == "POST"
    && resp.status >= 200 && resp.status < 500
    && var.scq_path ~ "(?i)/V1/guest-carts/([^/]+)/(estimate-shipping-methods|totals-information)/?$") {

    declare local var.scqj_cart STRING;
    declare local var.scqj_secret STRING;
    declare local var.scqj_now_s STRING;
    declare local var.scqj_limit INTEGER;
    declare local var.scqj_keep BOOL;

    # re.group.1 is read straight after the path match, before the cookie regex runs
    set var.scqj_cart = re.group.1;
    set var.scqj_now_s = strftime({"%s"}, now);
    set var.scqj_secret = table.lookup(scripco_edge_config, "cart_age_gate_secret", "");

    set var.scqj_keep = false;
    if (req.http.Cookie:scqj ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
        if (re.group.2 == digest.hmac_sha256_base64(var.scqj_secret, "scqj|" re.group.1 "|" req.http.host "|" var.scqj_cart "|" req.http.User-Agent)) {
            set var.scqj_limit = std.atoi(re.group.1);
            set var.scqj_limit += std.atoi(table.lookup(scripco_edge_config, "scqj_max_age_sec", "604800"));
            if (std.atoi(var.scqj_now_s) <= var.scqj_limit) {
                set var.scqj_keep = true;
            }
        }
    }
    if (!var.scqj_keep) {
        add resp.http.Set-Cookie = "scqj=" var.scqj_now_s "." digest.hmac_sha256_base64(var.scqj_secret, "scqj|" var.scqj_now_s "|" req.http.host "|" var.scqj_cart "|" req.http.User-Agent) "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800";
    }
}
