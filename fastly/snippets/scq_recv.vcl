    # MPS-17142: guest checkout cart-age gate (snippet type: recv, priority 100)
    #
    # Card-testing bots reach shipping-information ~5 s and set-payment-information ~8 s after the cart is
    # created (measured 2026-10-14, 111 carts); real guests need 23 s+ and 31 s+ after the checkout page
    # loads. scq_deliver.vcl stamps the first checkout touch with a signed timestamp cookie; this snippet
    # refuses guest-cart REST calls whose stamp is missing, forged, or too young.
    #
    # Config lives in the edge dictionary scripco_edge_config:
    #   cart_age_gate_mode              "monitor" = let through, tag with X-SCQ-Verdict; "block" = respond 429
    #   cart_age_gate_secret            HMAC key shared with scq_deliver.vcl
    #   cart_age_gate_min_sec_shipping  seconds before shipping-information / set-payment-information (default 10)
    #   cart_age_gate_min_sec_payment   seconds before payment-information / order (default 30)
    #
    # Logged-in carts (/carts/mine/*) are never touched. Edge nodes only, never on the shield.

    # Don't let clients pre-set the verdict header
    if (req.restarts == 0) {
        unset req.http.X-SCQ-Verdict;
    }

    if (req.restarts == 0
        && fastly.ff.visits_this_service == 0
        && req.method != "FASTLYPURGE"
        && !req.http.bypass-secret
        && req.url.path ~ "^/rest/[^/]+/V1/guest-carts/[^/]+/(shipping-information|set-payment-information|payment-information|order)$") {

        declare local var.scq_min_age INTEGER;
        declare local var.scq_now INTEGER;
        declare local var.scq_ok_after INTEGER;
        declare local var.scq_ts STRING;
        declare local var.scq_sig STRING;
        declare local var.scq_verdict STRING;

        # re.group.1 is the endpoint matched above; read it before any other regex runs
        if (re.group.1 == "shipping-information" || re.group.1 == "set-payment-information") {
            set var.scq_min_age = std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_min_sec_shipping", "10"));
        } else {
            set var.scq_min_age = std.atoi(table.lookup(scripco_edge_config, "cart_age_gate_min_sec_payment", "30"));
        }

        set var.scq_verdict = "no-cookie";

        if (req.http.Cookie:scq ~ "^([0-9]{9,11})\.([A-Za-z0-9+/=]+)$") {
            set var.scq_ts = re.group.1;
            set var.scq_sig = re.group.2;

            if (var.scq_sig != digest.hmac_sha256_base64(table.lookup(scripco_edge_config, "cart_age_gate_secret", ""), var.scq_ts)) {
                set var.scq_verdict = "bad-sig";
            } else {
                set var.scq_now = std.atoi(strftime({"%s"}, now));
                set var.scq_ok_after = std.atoi(var.scq_ts);
                set var.scq_ok_after += var.scq_min_age;
                if (var.scq_now < var.scq_ok_after) {
                    set var.scq_verdict = "too-early";
                } else {
                    set var.scq_verdict = "pass";
                }
            }
        }

        if (var.scq_verdict != "pass") {
            set req.http.X-SCQ-Verdict = var.scq_verdict;
            if (table.lookup(scripco_edge_config, "cart_age_gate_mode", "monitor") == "block") {
                # 629 is a private status, turned into a 429 JSON response in scq_error.vcl
                error 629 "SCQ";
            }
        }
    }
