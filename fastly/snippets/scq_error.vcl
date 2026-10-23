# MPS-17142: responses for requests refused by scq_recv.vcl / scq_asn_block.vcl (snippet type: error, priority 100)
#
# One answer for every refusal by the checkout gate: same status, same message, no verdict header and
# no Retry-After. Until 20 Oct 2026 the 429 named the failed check (X-SCQ-Verdict) and told a
# too-early client to wait 30 s, which is exactly what a script needs to adapt. Status 400 like
# Magento's own REST errors; Magento never answers 429 here. The checkout JS (mage/storage +
# Magento_Ui messages) shows the "message" field to the shopper, and reloading the checkout page
# fixes every case. Never cached.
#
# 631 (scqj_mode = shadow): a copy of a real Magento card decline, body from the dictionary key
# scqj_shadow_body, so a script cannot tell that it was stopped at the edge. See the README section
# "Shadow decline" before enabling it.
#
# Requests with X-SCQ-Debug = scq_debug_token (fastly/test) also get X-SCQ-Blocked; scq_deliver.vcl
# adds the verdict header for them.

declare local var.scq_debug BOOL;
set var.scq_debug = false;
if (table.lookup(scripco_edge_config, "scq_debug_token", "") != ""
    && req.http.X-SCQ-Debug == table.lookup(scripco_edge_config, "scq_debug_token", "")) {
    set var.scq_debug = true;
}

if (obj.status == 629) {
    set obj.status = 400;
    set obj.response = "Bad Request";
    set obj.http.Content-Type = "application/json";
    set obj.http.Cache-Control = "no-store";
    if (var.scq_debug) {
        set obj.http.X-SCQ-Blocked = "refused";
    }
    # {json"..."json} delimiters: a plain {"..."} long string would end at the JSON's own "}
    synthetic {json"{"message":"Your checkout session needs a refresh. Please reload the checkout page and try again."}"json};
    return (deliver);
}

# 631: scqj shadow decline (scq_recv.vcl only raises it when scqj_shadow_body is set; the fallback
# below is the generic refusal, never an invented decline text)
if (obj.status == 631) {
    set obj.status = 400;
    set obj.response = "Bad Request";
    set obj.http.Content-Type = "application/json";
    set obj.http.Cache-Control = "no-store";
    if (var.scq_debug) {
        set obj.http.X-SCQ-Blocked = "shadow";
    }
    synthetic table.lookup(scripco_edge_config, "scqj_shadow_body", {json"{"message":"Your checkout session needs a refresh. Please reload the checkout page and try again."}"json});
    return (deliver);
}

# 630: request from a network listed as blocked_asn_<number> (scq_asn_block.vcl)
if (obj.status == 630) {
    set obj.status = 403;
    set obj.response = "Forbidden";
    set obj.http.Content-Type = "application/json";
    set obj.http.Cache-Control = "no-store";
    if (var.scq_debug) {
        set obj.http.X-SCQ-Blocked = "blocked-asn";
    }
    synthetic {json"{"message":"We could not process this request. Please contact customer service."}"json};
    return (deliver);
}
