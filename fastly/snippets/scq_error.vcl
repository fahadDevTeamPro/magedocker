# MPS-17142: JSON 429 for requests refused by scq_recv.vcl (snippet type: error, priority 100)
#
# The checkout JS (mage/storage + Magento_Ui messages) shows the "message" field to the shopper,
# so keep it short and generic. Never cached.

if (obj.status == 629) {
    set obj.status = 429;
    set obj.response = "Too Many Requests";
    set obj.http.Content-Type = "application/json";
    set obj.http.Cache-Control = "no-store";
    set obj.http.Retry-After = "30";
    set obj.http.X-SCQ-Verdict = req.http.X-SCQ-Verdict;
    # {json"..."json} delimiters: a plain {"..."} long string would end at the JSON's own "}
    synthetic {json"{"message":"Your checkout is still being prepared. Please wait a moment and try again."}"json};
    return (deliver);
}
