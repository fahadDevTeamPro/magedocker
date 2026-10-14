    # MPS-17142: stamp the first checkout touch with a signed timestamp (snippet type: deliver, priority 100)
    #
    # Pairs with scq_recv.vcl. The cookie is set once, on the first of:
    #   POST /checkout/cart/add/...   (add to cart, the bot's first request)
    #   GET  /checkout/cart/          (cart page)
    #   GET  /checkout/               (checkout page)
    # so a returning guest whose cookies were cleared is stamped on arrival and passes the gate by the time
    # they reach the shipping / payment steps. Value: <unix seconds>.<hmac_sha256_base64(secret, unix seconds)>.
    # Edge nodes only, never on the shield. Not set for the Fastly module tester (bypass-secret).

    if (fastly.ff.visits_this_service == 0
        && !req.http.bypass-secret
        && !req.http.Cookie:scq
        && ((req.method == "POST" && req.url.path ~ "^/checkout/cart/add/")
            || (req.method == "GET" && req.url.path ~ "^/checkout/(cart/)?$"))) {

        declare local var.scq_ts STRING;
        set var.scq_ts = strftime({"%s"}, now);

        add resp.http.Set-Cookie = "scq=" var.scq_ts "." digest.hmac_sha256_base64(table.lookup(scripco_edge_config, "cart_age_gate_secret", ""), var.scq_ts) "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800";
    }
