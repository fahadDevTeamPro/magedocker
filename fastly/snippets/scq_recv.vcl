# MPS-17142: guest checkout gate (snippet type: recv, priority 100)
#
# Refuses guest checkout calls that do not look like they come from a real checkout page:
#
#   REST     POST guest-carts/*/shipping-information | set-payment-information | payment-information
#            PUT  guest-carts/*/order
#            Matched on a normalised path (repeated slashes collapsed, trailing slash dropped, any
#            prefix such as /rest/<store>, /rest, /index.php/rest), because Magento routes all of those.
#            GET payment-information is not gated: the checkout JS uses it after coupons, store
#            credit, gift cards and reward points.
#   GraphQL  POST /graphql whose body sets an address, shipping method, payment method, guest email or
#            places the order. The storefront never uses these (checkout is the REST/Luma checkout),
#            so only scripts send them. Bodies Fastly cannot read (no Content-Length or > 8 KB) and
#            bodies with JSON-escaped ASCII letters (placeOrder) count as cart mutations.
#
# Three cookies, issued by scq_deliver.vcl:
#   scq   cart-age stamp       missing / forged / too young / older than max age
#   scqc  checkout-page proof  missing / forged / older than max age
#   scqj  checkout-JS proof    set on the response to estimate-shipping-methods / totals-information,
#                              which the checkout page's own JavaScript calls for every real cart
#                              (all ~2,310 paid guest carts, 20 Sep - 20 Oct 2026) and the bot almost
#                              never does (< 2% of its carts). Signed with the cart id from the URL and
#                              the User-Agent: valid for one cart in one browser. Checked on payment
#                              calls only (POST payment-information, PUT order), the last step, so a
#                              real checkout page has always made the calls by then.
# A request with no PHPSESSID cannot come from a checkout page and is "no-session".
#
# Dictionary scripco_edge_config:
#   cart_age_gate_mode              monitor | block   REST, timing check
#   checkout_proof_mode             monitor | block   REST, checkout-page proof
#   graphql_gate_mode               monitor | block   GraphQL cart mutations, both checks
#   cart_age_gate_secret            HMAC key shared with scq_deliver.vcl
#   cart_age_gate_min_sec_shipping  seconds before shipping-information / set-payment-information (10)
#   cart_age_gate_min_sec_payment   seconds before payment-information / order (30)
#   cart_age_gate_max_age_sec       cookie validity; older cookies are "stale" until a cart / checkout
#                                   page view renews them (3600)
#   scqj_mode                       off | monitor | block | shadow   (missing = off)
#                                     monitor  verdict logged only
#                                     block    every scqj failure refused like the other checks
#                                     shadow   as block, except a payment with no scqj at all that
#                                              passed every other check gets a copy of a real card
#                                              decline (scq_error.vcl). Needs scqj_shadow_body.
#   scqj_wait_min_sec               secret per-cart wait after the cart's first checkout-JS call:
#   scqj_wait_span_sec              min + (hmac(secret, cart) mod span) seconds; 25 + 0..19 = 25..44 s.
#                                   Real shoppers take 61 s at p1 (82 s p5, 196 s median)
#   scqj_max_age_sec                scqj validity, 604800 (= cookie lifetime). Checkout tabs stay open
#                                   for hours or days (seen: 6.6 h, 5 days), so this must stay long
#   scqj_shadow_body                JSON body of a real Magento card decline, copied from UAT
#
# Verdicts are never returned to the client: they told the bot which check it failed. Every gated
# call is logged to the Fastly logging endpoint "scq_verdicts"; requests that carry
# X-SCQ-Debug = scq_debug_token (fastly/test) get the verdict header back (scq_deliver.vcl).
#
# monitor = let through, tag; block = status 629 -> generic JSON 400; shadow = status 631 -> decline
# copy (scq_error.vcl). Any other value behaves as monitor (scqj: as off). Logged-in carts
# (/carts/mine/*) are never touched. Edge nodes only, never on the shield.

# Don't let clients pre-set the verdict header
if (req.restarts == 0) {
    unset req.http.X-SCQ-Verdict;
}

if (req.restarts == 0
    && fastly.ff.visits_this_service == 0
    && (req.method == "POST" || req.method == "PUT")
    && !req.http.bypass-secret) {

    declare local var.scq_path STRING;
    declare local var.scq_kind STRING;
    declare local var.scq_endpoint STRING;
    declare local var.scq_cart STRING;
    declare local var.scq_min_age INTEGER;
    declare local var.scq_max_age INTEGER;
    declare local var.scq_now INTEGER;
    declare local var.scq_limit INTEGER;
    declare local var.scq_ts STRING;
    declare local var.scq_sig STRING;
    declare local var.scq_secret STRING;
    declare local var.scq_verdict STRING;
    declare local var.scq_proof STRING;
    declare local var.scq_block BOOL;
    declare local var.scq_shadow BOOL;
    declare local var.scq_action STRING;
    declare local var.scqj STRING;
    declare local var.scqj_mode STRING;
    declare local var.scqj_hash STRING;
    declare local var.scqj_wait INTEGER;
    declare local var.scqj_span INTEGER;
    declare local var.scqj_q INTEGER;
    declare local var.scqj_pos INTEGER;

    set var.scq_path = regsuball(req.url.path, "/{2,}", "/");
    set var.scq_path = regsub(var.scq_path, "/$", "");
    set var.scq_kind = "";
    set var.scq_cart = "";

    # re.group.* is read straight after each match, before any other regex runs
    if (var.scq_path ~ "(?i)/V1/guest-carts/([^/]+)/(shipping-information|set-payment-information|payment-information|order)$") {
        set var.scq_cart = re.group.1;
        set var.scq_endpoint = std.tolower(re.group.2);
        if (var.scq_endpoint == "order") {
            if (req.method == "PUT") {
                set var.scq_kind = "rest-payment";
            }
        } else if (req.method == "POST") {
            if (var.scq_endpoint == "payment-information") {
                set var.scq_kind = "rest-payment";
            } else {
                set var.scq_kind = "rest-shipping";
            }
        }
    } else if (req.method == "POST" && var.scq_path ~ "(?i)^/graphql$") {
        if (!req.http.Content-Length
            || std.atoi(req.http.Content-Length) > 8000
            || req.body ~ "(?i)(placeOrder|setPaymentMethod|setShippingAddresses|setShippingMethods|setBillingAddress|setGuestEmail)"
            || req.body ~ "(?i)\\u00[2-7][0-9a-f]") {
            set var.scq_kind = "graphql";
        }
    }

    if (var.scq_kind != "") {
        if (var.scq_kind == "rest-payment") {
            set var.scq_min_age = std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_min_sec_payment", "30"));
        } else {
            set var.scq_min_age = std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_min_sec_shipping", "10"));
        }
        set var.scq_max_age = std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_max_age_sec", "3600"));
        set var.scq_secret = table.lookup(scripco_edge_config, "cart_age_gate_secret", "");
        set var.scq_now = std.atoi(strftime({"%s"}, now));

        # --- 1. cart-age stamp
        set var.scq_verdict = "no-cookie";
        if (!req.http.Cookie:PHPSESSID) {
            set var.scq_verdict = "no-session";
        } else if (req.http.Cookie:scq ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
            set var.scq_ts = re.group.1;
            set var.scq_sig = re.group.2;

            if (var.scq_sig != digest.hmac_sha256_base64(var.scq_secret, var.scq_ts "." req.http.host)) {
                set var.scq_verdict = "bad-sig";
            } else {
                set var.scq_limit = std.atoi(var.scq_ts);
                set var.scq_limit += var.scq_min_age;
                if (var.scq_now < var.scq_limit) {
                    set var.scq_verdict = "too-early";
                } else {
                    set var.scq_limit = std.atoi(var.scq_ts);
                    set var.scq_limit += var.scq_max_age;
                    if (var.scq_now > var.scq_limit) {
                        set var.scq_verdict = "stale";
                    } else {
                        set var.scq_verdict = "pass";
                    }
                }
            }
        }

        # --- 2. checkout-page proof
        set var.scq_proof = "no-proof";
        if (!req.http.Cookie:PHPSESSID) {
            set var.scq_proof = "no-session";
        } else if (req.http.Cookie:scqc ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
            set var.scq_ts = re.group.1;
            set var.scq_sig = re.group.2;

            if (var.scq_sig != digest.hmac_sha256_base64(var.scq_secret, var.scq_ts "." req.http.host ".checkout")) {
                set var.scq_proof = "bad-proof";
            } else {
                set var.scq_limit = std.atoi(var.scq_ts);
                set var.scq_limit += var.scq_max_age;
                if (var.scq_now > var.scq_limit) {
                    set var.scq_proof = "stale-proof";
                } else {
                    set var.scq_proof = "pass";
                }
            }
        }

        # --- 3. checkout-JS proof, payment calls only
        set var.scqj_mode = table.lookup(scripco_edge_config, "scqj_mode", "off");
        set var.scqj = "";
        if (var.scq_kind == "rest-payment" && var.scqj_mode != "off") {
            set var.scqj = "scqj-missing";
            if (req.http.Cookie:scqj) {
                set var.scqj = "scqj-bad";
                if (req.http.Cookie:scqj ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
                    set var.scq_ts = re.group.1;
                    set var.scq_sig = re.group.2;

                    # another cart, another User-Agent or a forged value all land here as scqj-bad
                    if (var.scq_sig == digest.hmac_sha256_base64(var.scq_secret, "scqj|" var.scq_ts "|" req.http.host "|" var.scq_cart "|" req.http.User-Agent)) {
                        set var.scq_limit = std.atoi(var.scq_ts);
                        set var.scq_limit += std.atoi(table.lookup(scripco_edge_config, "scqj_max_age_sec", "604800"));
                        if (var.scq_now > var.scq_limit) {
                            set var.scqj = "scqj-stale";
                        } else {
                            # secret per-cart wait: min + (last byte of hmac(secret, "wait|" cart) mod span)
                            set var.scqj_hash = digest.hmac_sha256(var.scq_secret, "wait|" var.scq_cart);
                            # VCL allows no arithmetic inside function arguments: offset of the last two hex digits first
                            set var.scqj_pos = std.strlen(var.scqj_hash);
                            set var.scqj_pos -= 2;
                            set var.scqj_wait = std.strtol(substr(var.scqj_hash, var.scqj_pos, 2), 16);
                            set var.scqj_span = std.atoi(table.lookup(scripco_edge_config, "scqj_wait_span_sec", "20"));
                            if (var.scqj_span < 1) {
                                set var.scqj_span = 1;
                            }
                            set var.scqj_q = var.scqj_wait;
                            set var.scqj_q /= var.scqj_span;
                            set var.scqj_q *= var.scqj_span;
                            set var.scqj_wait -= var.scqj_q;
                            set var.scqj_wait += std.atoi(table.lookup(scripco_edge_config, "scqj_wait_min_sec", "25"));

                            set var.scq_limit = std.atoi(var.scq_ts);
                            set var.scq_limit += var.scqj_wait;
                            if (var.scq_now < var.scq_limit) {
                                set var.scqj = "scqj-too-early";
                            } else {
                                set var.scqj = "pass";
                            }
                        }
                    }
                }
            }
        }

        # --- verdict: first failing check names the request; block if its switch says so
        set var.scq_block = false;
        set var.scq_shadow = false;
        if (var.scq_verdict != "pass") {
            set req.http.X-SCQ-Verdict = var.scq_verdict;
            if (var.scq_kind == "graphql") {
                if (table.lookup(scripco_edge_config, "graphql_gate_mode", "monitor") == "block") {
                    set var.scq_block = true;
                }
            } else if (table.lookup(scripco_edge_config, "cart_age_gate_mode", "monitor") == "block") {
                set var.scq_block = true;
            }
        }
        if (var.scq_proof != "pass") {
            if (!req.http.X-SCQ-Verdict) {
                set req.http.X-SCQ-Verdict = var.scq_proof;
            }
            if (var.scq_kind == "graphql") {
                if (table.lookup(scripco_edge_config, "graphql_gate_mode", "monitor") == "block") {
                    set var.scq_block = true;
                }
            } else if (table.lookup(scripco_edge_config, "checkout_proof_mode", "monitor") == "block") {
                set var.scq_block = true;
            }
        }
        if (var.scqj != "" && var.scqj != "pass") {
            if (!req.http.X-SCQ-Verdict) {
                set req.http.X-SCQ-Verdict = var.scqj;
            }
            if (var.scqj_mode == "block" || var.scqj_mode == "shadow") {
                set var.scq_block = true;
            }
            # shadow only for the strongest signal: no scqj at all on a payment that passed every
            # other check, and only once a real decline body is configured. Everything else stays a
            # plain refusal, which a real shopper recovers from by reloading the checkout page.
            if (var.scqj_mode == "shadow"
                && var.scqj == "scqj-missing"
                && var.scq_verdict == "pass"
                && var.scq_proof == "pass"
                && table.lookup(scripco_edge_config, "scqj_shadow_body", "") != "") {
                set var.scq_shadow = true;
            }
        }
        if (var.scq_kind == "graphql" && req.http.X-SCQ-Verdict) {
            set req.http.X-SCQ-Verdict = "graphql-" req.http.X-SCQ-Verdict;
        }

        # --- log every gated call to the "scq_verdicts" endpoint (never to the client).
        # "message" repeats the path so the same /guest-carts/<cart>/ capture works on these lines and
        # on the origin access log in New Relic.
        set var.scq_action = "pass";
        if (req.http.X-SCQ-Verdict) {
            set var.scq_action = "tagged";
        }
        if (var.scq_block) {
            set var.scq_action = "refused";
        }
        if (var.scq_shadow) {
            set var.scq_action = "shadow-declined";
        }
        log "syslog " req.service_id " scq_verdicts :: "
            {"{"logtype":"scq_verdicts","message":"scq "} var.scq_action " " req.method " " json.escape(req.url.path)
            {"","action":""} var.scq_action
            {"","scq":""} var.scq_verdict
            {"","proof":""} var.scq_proof
            {"","scqj":""} var.scqj
            {"","scqj_mode":""} var.scqj_mode
            {"","cart":""} json.escape(var.scq_cart)
            {"","host":""} json.escape(req.http.host)
            {"","client_ip":""} client.ip
            {"","asn":""} client.as.number
            {"","ua":""} json.escape(req.http.User-Agent)
            {json""}"json};

        if (var.scq_shadow) {
            # 631 is a private status, turned into a copy of a real card decline in scq_error.vcl
            error 631 "SCQ";
        }
        if (var.scq_block) {
            # 629 is a private status, turned into the generic JSON 400 in scq_error.vcl
            error 629 "SCQ";
        }
    }
}
