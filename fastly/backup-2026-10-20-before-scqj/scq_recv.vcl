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
# Two cookies, issued by scq_deliver.vcl and signed together with the store host:
#   scq   cart-age stamp       missing / forged / too young / older than max age
#   scqc  checkout-page proof  missing / forged / older than max age
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
#
# monitor = let through, tag with X-SCQ-Verdict; block = answer 429 (status 629 -> scq_error.vcl).
# Anything other than "block" behaves as monitor. Logged-in carts (/carts/mine/*) are never touched.
# Edge nodes only, never on the shield.

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

    set var.scq_path = regsuball(req.url.path, "/{2,}", "/");
    set var.scq_path = regsub(var.scq_path, "/$", "");
    set var.scq_kind = "";

    # re.group.1 is read straight after each match, before any other regex runs
    if (var.scq_path ~ "(?i)/V1/guest-carts/[^/]+/(shipping-information|set-payment-information|payment-information|order)$") {
        set var.scq_endpoint = std.tolower(re.group.1);
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

        # --- verdict: first failing check wins the header; block if its switch says so
        set var.scq_block = false;
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
        if (var.scq_kind == "graphql" && req.http.X-SCQ-Verdict) {
            set req.http.X-SCQ-Verdict = "graphql-" req.http.X-SCQ-Verdict;
        }
        if (var.scq_block) {
            # 629 is a private status, turned into a 429 JSON response in scq_error.vcl
            error 629 "SCQ";
        }
    }
}
