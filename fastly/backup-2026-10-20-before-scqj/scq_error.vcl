# MPS-17142: JSON 429 / 403 for requests refused by scq_recv.vcl / scq_asn_block.vcl (snippet type: error, priority 100)
#
# The checkout JS (mage/storage + Magento_Ui messages) shows the "message" field to the shopper,
# so keep it short and generic. "too-early" is the only verdict a wait fixes; everything else
# (no cookie, other session, stale, no checkout page) is fixed by reloading the checkout page.
# Never cached.

if (obj.status == 629) {
    set obj.status = 429;
    set obj.response = "Too Many Requests";
    set obj.http.Content-Type = "application/json";
    set obj.http.Cache-Control = "no-store";
    set obj.http.Retry-After = "30";
    set obj.http.X-SCQ-Verdict = req.http.X-SCQ-Verdict;
    # {json"..."json} delimiters: a plain {"..."} long string would end at the JSON's own "}
    if (req.http.X-SCQ-Verdict == "too-early") {
        synthetic {json"{"message":"Your checkout is still being prepared. Please wait a moment and try again."}"json};
    } else {
        synthetic {json"{"message":"Your checkout session needs a refresh. Please reload the checkout page and try again."}"json};
    }
    return (deliver);
}

# 630: request from a network listed as blocked_asn_<number> (scq_asn_block.vcl)
if (obj.status == 630) {
    set obj.status = 403;
    set obj.response = "Forbidden";
    set obj.http.Content-Type = "application/json";
    set obj.http.Cache-Control = "no-store";
    set obj.http.X-SCQ-Verdict = "blocked-asn";
    synthetic {json"{"message":"We could not process this request. Please contact customer service."}"json};
    return (deliver);
}
