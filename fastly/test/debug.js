// Verdicts are only sent back to requests that carry X-SCQ-Debug equal to the dictionary key
// scq_debug_token (real shoppers and bots never see them). Export the same value as SCQ_DEBUG_TOKEN
// before running any test. Without it a refusal is still visible (generic JSON 400), but the tests
// cannot tell which check refused it. Remove the dictionary key again after testing.
const TOKEN = process.env.SCQ_DEBUG_TOKEN || '';
if (!TOKEN) console.warn('SCQ_DEBUG_TOKEN is not set: X-SCQ-Verdict / X-SCQ-Blocked will not be returned');
const DEBUG_HEADERS = TOKEN ? { 'X-SCQ-Debug': TOKEN } : {};
// "BLOCKED" when Fastly refused the call (X-SCQ-Blocked present), otherwise the origin status
const label = (status, blocked) => (blocked ? 'BLOCKED' : String(status));
module.exports = { TOKEN, DEBUG_HEADERS, label };
