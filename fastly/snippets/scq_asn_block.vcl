# MPS-17142: refuse checkout traffic from blocked networks (snippet type: recv, priority 110)
#
# Card testers rent proxy / datacenter IPs. When a whole network (ASN) is only ever used for
# attacks, refuse its checkout traffic at the edge. Browsing is not touched.
#
# A network is blocked by adding a key to the scripco_edge_config dictionary:
#   blocked_asn_<number>   any non-empty value (use it as a note: who, why, when)
#   e.g. blocked_asn_200373 = "3xK Tech GmbH - Advantage card testing Oct 2026"
# Switch:
#   asn_block_mode         monitor | block  (anything else = monitor)
#
# Covered: POST /checkout/cart/add/..., GET /checkout/ pages, every guest-cart REST call
# (any /rest/... spelling), and POST /graphql. Logged-in customers on a blocked network are
# refused too; that is intended (proxy networks only).
#
# Runs after scq_recv.vcl (priority 100), which resets X-SCQ-Verdict on every request.
# monitor = tag X-SCQ-Verdict "blocked-asn" (on the response only for X-SCQ-Debug requests, see
#           scq_deliver.vcl);
# block   = status 630, answered as a JSON 403 by scq_error.vcl. Edge nodes only (on the shield
# client.as.number would be the edge POP, not the visitor).

if (req.restarts == 0
    && fastly.ff.visits_this_service == 0
    && !req.http.bypass-secret
    && table.lookup(scripco_edge_config, "blocked_asn_" client.as.number, "") != "") {

    declare local var.asn_path STRING;
    set var.asn_path = regsuball(req.url.path, "/{2,}", "/");

    if ((req.method == "POST" && var.asn_path ~ "^/checkout/cart/add/")
        || var.asn_path ~ "^/checkout(/|$)"
        || var.asn_path ~ "(?i)/V1/guest-carts(/|$)"
        || (req.method == "POST" && var.asn_path ~ "(?i)^/graphql/?$")) {

        set req.http.X-SCQ-Verdict = "blocked-asn";
        if (table.lookup(scripco_edge_config, "asn_block_mode", "monitor") == "block") {
            error 630 "ASN";
        }
    }
}
