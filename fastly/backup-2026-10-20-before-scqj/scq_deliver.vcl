# MPS-17142: issue the signed checkout cookies (snippet type: deliver, priority 100)
#
# Pairs with scq_recv.vcl. Two cookies, both signed together with the store host, so a value copied
# from another store, or with an edited timestamp, fails the signature check:
#
#   scq  = <ts>.<hmac(secret, ts.host)>           "cart age" stamp, on POST /checkout/cart/add/...,
#                                                 GET /checkout/cart/ and GET /checkout/
#   scqc = <ts>.<hmac(secret, ts.host.checkout)>  "checkout page seen" proof, only when GET /checkout/
#                                                 rendered (200; an empty cart gets a 302 and no proof)
#
# Validity vs. browser lifetime: scq_recv.vcl accepts a cookie for cart_age_gate_max_age_sec (1 h).
# The browser keeps it for 7 days, so a shopper who comes back later still sends it, and the next
# cart / checkout page view renews it here:
#   - no cookie or bad signature   -> new stamp, ts = now (the 10 s / 30 s wait starts now)
#   - valid, younger than half the validity -> left alone (reloads never restart the wait)
#   - valid, older (also expired)  -> renewed as already aged, ts = now - min_sec_payment, so a
#                                     returning shopper is never told to wait. Only a genuine stamp
#                                     can be renewed, and only by a page view.
#   scqc is renewed with ts = now on the same rule (it has no wait).
#
# Not bound to PHPSESSID: Magento's checkout controller regenerates the session id on GET /checkout/,
# so a cookie signed with the request's PHPSESSID is wrong one response later.
# Edge nodes only, never on the shield. Not set for the Fastly module tester (bypass-secret).

declare local var.scq_path STRING;
set var.scq_path = regsuball(req.url.path, "/{2,}", "/");

# monitor mode: show the would-be verdict on the response so it can be checked from a browser / curl
if (req.http.X-SCQ-Verdict && fastly.ff.visits_this_service == 0) {
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
