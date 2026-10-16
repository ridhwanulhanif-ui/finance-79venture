// QuickBooks Online, read by the server so the served dashboard can check petty cash live.
//
// claude.ai reaches QuickBooks through the viewer's own connector; Railway has no connector, so the
// server holds its own Intuit OAuth connection, one per company. An admin connects each company once
// at /qbo/connect?co=a (Arabina) and /qbo/connect?co=v (79 Ventures); the tokens are kept in
// DATA_DIR/qbo-tokens.json (put DATA_DIR on a Railway volume so they survive a redeploy) and the
// access token is refreshed as it expires. Only read-only reports are exposed: the trial balance and
// the general ledger of named accounts, returned in the same row shape the claude.ai connector gives
// the page, so the page's own petty cash logic runs unchanged.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const CACHE_MS = 50_000;

function createQbo({ dataDir }) {
  const clientId = process.env.QBO_CLIENT_ID || "";
  const secret = process.env.QBO_CLIENT_SECRET || "";
  const redirectUri = process.env.QBO_REDIRECT_URI || "";
  const base = process.env.QBO_ENV === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
  const enabled = !!(clientId && secret && redirectUri);
  const file = path.join(dataDir, "qbo-tokens.json");
  const names = { a: "Arabina Eco Tiny Homes", v: "79 Ventures" };
  const states = new Map();
  const cache = new Map();
  const inflight = new Map();
  let T = null;

  function load() {
    if (T) return T;
    try { T = JSON.parse(fs.readFileSync(file, "utf8")); } catch { T = {}; }
    // A refresh token can also be seeded from Railway Variables (e.g. one made in Intuit's OAuth
    // Playground); once used, the rotated token lives in the file.
    for (const co of ["a", "v"]) {
      const rt = process.env["QBO_REFRESH_TOKEN_" + co.toUpperCase()], realm = process.env["QBO_REALM_" + co.toUpperCase()];
      if (!T[co] && rt && realm) T[co] = { realm, refresh: rt, access: "", exp: 0, connectedAt: null, by: "env" };
    }
    return T;
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(T), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const fail = (code, message) => Object.assign(new Error(message || code), { code });
  const basic = () => "Basic " + Buffer.from(clientId + ":" + secret).toString("base64");

  async function tokenCall(params) {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: basic(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(j.error === "invalid_grant" ? "needs_reauth" : "token_failed", j.error_description || j.error || "HTTP " + r.status);
    return j;
  }
  async function token(co, force) {
    const t = load()[co];
    if (!t) throw fail("not_connected", names[co] + " is not connected to QuickBooks on this server.");
    if (!force && t.access && t.exp > Date.now() + 60_000) return t;
    if (inflight.has(co)) return inflight.get(co);
    const p = (async () => {
      const j = await tokenCall({ grant_type: "refresh_token", refresh_token: t.refresh });
      Object.assign(t, { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, refresh: j.refresh_token || t.refresh });
      save();
      return t;
    })().finally(() => inflight.delete(co));
    inflight.set(co, p);
    return p;
  }
  async function api(co, rel) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(co, attempt > 0);
      const r = await fetch(`${base}/v3/company/${t.realm}/${rel}${rel.includes("?") ? "&" : "?"}minorversion=75`, {
        headers: { Authorization: "Bearer " + t.access, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 401 && attempt === 0) continue;
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw fail(r.status === 401 ? "needs_reauth" : "qbo_error", (j && j.Fault && j.Fault.Error && j.Fault.Error[0] && j.Fault.Error[0].Detail) || "QuickBooks HTTP " + r.status);
      return j;
    }
  }

  // The native report as a flat list of {path, row}: the shape the claude.ai connector returns.
  function flatten(rep) {
    const rows = [];
    const walk = (list, prefix) => (list || []).forEach((row, i) => {
      const p = prefix + "/Rows/Row/" + i, { Rows, ...rest } = row;
      rows.push({ path: p, row: rest });
      if (Rows && Rows.Row) walk(Rows.Row, p);
    });
    walk(rep && rep.Rows && rep.Rows.Row, "");
    return { metadata: { Header: rep.Header, Columns: rep.Columns }, rows };
  }
  const iso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? s : null;
  async function accountIds(co, wanted) {
    const key = co + "|accounts";
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > 10 * 60_000) {
      const q = encodeURIComponent("select Id, Name, FullyQualifiedName from Account where Name like 'Petty Cash%' maxresults 1000");
      const d = encodeURIComponent("select Id, Name, FullyQualifiedName from Account where Name = 'Depreciation Expense'");
      const [j, k] = await Promise.all([api(co, "query?query=" + q), api(co, "query?query=" + d)]);
      hit = { at: Date.now(), v: [].concat((j.QueryResponse && j.QueryResponse.Account) || [], (k.QueryResponse && k.QueryResponse.Account) || []) };
      cache.set(key, hit);
    }
    return wanted.map((w) => { const a = hit.v.find((x) => x.Name === w || x.FullyQualifiedName === w); return a && a.Id; }).filter(Boolean);
  }
  // Read-only, and only what the petty cash and asset checks ask for.
  async function report(co, input) {
    if (co !== "a" && co !== "v") throw fail("bad_request", "Unknown company.");
    let rel;
    if (input.report_type === "trial_balance") {
      const d = iso(input.report_date || input.as_of_date); if (!d) throw fail("bad_request", "report_date is required.");
      rel = `reports/TrialBalance?start_date=${d}&end_date=${d}`;
    } else if (input.report_type === "general_ledger") {
      const s = iso(input.start_date), e = iso(input.end_date); if (!s || !e) throw fail("bad_request", "start_date and end_date are required.");
      // Petty cash accounts for the Petty Cash check; Depreciation Expense for the asset check.
      const wanted = (Array.isArray(input.account) ? input.account : []).map((a) => String((a && a.name) || "")).filter((n) => /^Petty Cash\b/i.test(n) || n === "Depreciation Expense").slice(0, 60);
      if (!wanted.length) throw fail("bad_request", "Only petty cash accounts and Depreciation Expense can be read.");
      const ids = await accountIds(co, wanted);
      if (!ids.length) return { raw_report: { metadata: null, rows: [] } };
      const cols = (Array.isArray(input.columns) ? input.columns : []).filter((c) => /^[a-z_]{2,40}$/.test(c)).join(",");
      rel = `reports/GeneralLedger?start_date=${s}&end_date=${e}&account=${ids.join(",")}${cols ? "&columns=" + cols : ""}`;
    } else throw fail("bad_request", "Only the trial balance and general ledger can be read here.");
    const key = co + "|" + rel, hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    const v = { raw_report: flatten(await api(co, rel)), fetched: new Date().toISOString() };
    cache.set(key, { at: Date.now(), v });
    return v;
  }

  function status() {
    const t = load(), one = (co) => t[co] ? { connected: true, realm: t[co].realm, connectedAt: t[co].connectedAt, by: t[co].by } : { connected: false };
    return { enabled, a: one("a"), v: one("v") };
  }
  function connectUrl(co, user) {
    if (!enabled) throw fail("not_configured", "QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI are not set.");
    if (co !== "a" && co !== "v") throw fail("bad_request", "Use ?co=a for Arabina or ?co=v for 79 Ventures.");
    const state = crypto.randomBytes(18).toString("base64url");
    states.set(state, { co, user, at: Date.now() });
    for (const [k, s] of states) if (Date.now() - s.at > 15 * 60_000) states.delete(k);
    return AUTH_URL + "?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "com.intuit.quickbooks.accounting", state }).toString();
  }
  async function callback(params, user) {
    const s = states.get(params.get("state") || "");
    if (!s || Date.now() - s.at > 15 * 60_000) throw fail("bad_state", "This sign-in link has expired. Start again from /qbo/connect.");
    states.delete(params.get("state"));
    if (params.get("error")) throw fail("denied", params.get("error"));
    const code = params.get("code"), realm = params.get("realmId");
    if (!code || !realm) throw fail("bad_request", "Intuit did not return a company.");
    const j = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    load()[s.co] = { realm, refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, connectedAt: new Date().toISOString(), by: user || s.user || "" };
    save();
    for (const k of cache.keys()) if (k.startsWith(s.co + "|")) cache.delete(k);
    // Picking the other company on Intuit's screen would silently swap the two; refuse it.
    let nm = "";
    try { const ci = await api(s.co, "companyinfo/" + realm); nm = (ci.CompanyInfo && ci.CompanyInfo.CompanyName) || ""; } catch { nm = ""; }
    if (nm && !(s.co === "a" ? /arabina/i : /79\s*ventures/i).test(nm)) {
      delete T[s.co]; save();
      throw fail("wrong_company", `You picked "${nm}" on the Intuit screen. Start again and pick ${names[s.co]}.`);
    }
    return { co: s.co, name: nm || names[s.co], realm };
  }

  return { enabled, status, report, connectUrl, callback };
}

module.exports = { createQbo };
