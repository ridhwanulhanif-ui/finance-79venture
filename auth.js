// Sign-in for the served dashboard. No dependencies.
//
// Accounts live in the AUTH_USERS environment variable as scrypt hashes, one per line or comma:
//   boss@79ventures.biz:<salt hex>:<key hex>
// Never in this repository: it is public. Make an entry with `npm run hash-password -- <username>`.
//
// With AUTH_USERS unset the site stays open, as it always was, so a deploy cannot lock everyone
// out before the accounts have been set. Once it is set, every request needs a signed session
// cookie, the workbook downloads included: guarding the page alone would leave /api/*.xlsx open.
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
const COOKIE = "fd_session";
const SESSION_MS = 7 * 24 * 3600 * 1000;
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

// Usernames are matched without regard to case; an email address makes a good one.
function parseUsers(spec) {
  const users = new Map();
  for (const raw of String(spec || "").split(/[,\n]/)) {
    const entry = raw.trim();
    const m = /^([^:\s]+):([0-9a-f]{32}):([0-9a-f]{64})$/i.exec(entry);
    if (m) users.set(m[1].toLowerCase(), { salt: m[2].toLowerCase(), key: m[3].toLowerCase() });
    else if (entry) console.warn("AUTH_USERS: ignoring an entry that is not username:salt:key");
  }
  return users;
}

function createAuth(env = process.env) {
  const users = parseUsers(env.AUTH_USERS);
  const enabled = users.size > 0;
  let secret = env.SESSION_SECRET || "";
  if (enabled && secret.length < 32) {
    // Sessions still work, but every restart or redeploy signs everyone out.
    console.warn("SESSION_SECRET is missing or shorter than 32 characters; using a random one for this run");
    secret = crypto.randomBytes(32).toString("hex");
  }
  // Checked against when the username is unknown, so a wrong username costs the same time as a
  // wrong password and the response time does not reveal which accounts exist.
  const dummy = { salt: "00".repeat(16), key: "00".repeat(32) };
  const fails = new Map();

  const b64 = (buf) => Buffer.from(buf).toString("base64url");
  const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const sameStr = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  // Asynchronous on purpose: scrypt takes tens of milliseconds by design, and the synchronous form
  // would stall every other request for that long on each sign-in attempt.
  async function verifyPassword(name, password) {
    const rec = users.get(String(name || "").trim().toLowerCase());
    const use = rec || dummy;
    const key = await scrypt(String(password || ""), Buffer.from(use.salt, "hex"), KEYLEN, SCRYPT);
    return !!rec && crypto.timingSafeEqual(key, Buffer.from(use.key, "hex"));
  }

  function issue(name) {
    const payload = b64(JSON.stringify({ u: String(name).trim().toLowerCase(), exp: Date.now() + SESSION_MS }));
    return payload + "." + sign(payload);
  }

  // The user, or null. A user taken out of AUTH_USERS loses access at once, cookie or not.
  function check(token) {
    if (!token || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot), mac = token.slice(dot + 1);
    if (!sameStr(mac, sign(payload))) return null;
    let s;
    try { s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
    if (!s || typeof s.u !== "string" || !(s.exp > Date.now()) || !users.has(s.u)) return null;
    return s.u;
  }

  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function userOf(req) { return check(cookies(req)[COOKIE]); }

  // Railway terminates TLS in front of the app, so the original scheme arrives as a header.
  function secure(req) { return req.socket.encrypted || req.headers["x-forwarded-proto"] === "https"; }

  function cookieHeader(req, value, maxAgeMs) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}` + (secure(req) ? "; Secure" : "");
  }

  // The last X-Forwarded-For entry is the one Railway's proxy added; anything before it came from
  // the client, which could otherwise send a fresh address on every try and never be slowed down.
  function clientIp(req) {
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    return hops[hops.length - 1] || req.socket.remoteAddress || "?";
  }

  // Slows down guessing: ten wrong tries from one address, then a fifteen-minute wait.
  function tooManyFails(ip) {
    const f = fails.get(ip);
    if (!f || f.reset < Date.now()) return false;
    return f.n >= FAIL_LIMIT;
  }
  function noteFail(ip) {
    if (fails.size > 5000) for (const [k, v] of fails) if (v.reset < Date.now()) fails.delete(k);
    const f = fails.get(ip);
    if (!f || f.reset < Date.now()) fails.set(ip, { n: 1, reset: Date.now() + FAIL_WINDOW_MS });
    else f.n++;
  }

  return { enabled, users, verifyPassword, issue, check, userOf, cookieHeader, clientIp, tooManyFails, noteFail,
    sessionMs: SESSION_MS };
}

// Only ever send someone back to a path on this site, never to another one.
function safeNext(next) {
  const n = String(next || "/");
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function loginPage({ error = "", next = "/", user = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in · 79 Ventures finance</title>
<style>
:root{--paper:#F4F5F1;--card:#FFFFFF;--ink:#1D2420;--muted:#5E6A63;--rule:#D5DBD5;--bad:#B3261E;--btn:#24443A;--btnink:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--paper:#141816;--card:#1B201D;--ink:#E7ECE8;--muted:#9AA8A0;--rule:#334039;--bad:#F2867E;--btn:#9FD3B6;--btnink:#0d1a14}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);
  font:15px/1.45 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:16px}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:28px 24px}
h1{font-size:19px;margin:0 0 4px}
p.sub{margin:0 0 22px;color:var(--muted);font-size:13.5px}
label{display:block;font-weight:600;font-size:13px;margin:14px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border:1.5px solid var(--rule);border-radius:6px;background:var(--card);color:var(--ink)}
input:focus{outline:2px solid var(--btn);outline-offset:1px}
button{width:100%;margin-top:22px;font-family:inherit;font-size:15px;font-weight:600;padding:11px;border:0;border-radius:6px;background:var(--btn);color:var(--btnink);cursor:pointer}
.err{margin:0 0 4px;padding:10px 12px;border-radius:6px;border:1px solid var(--bad);color:var(--bad);font-size:13.5px}
</style></head>
<body><main>
<h1>79 Ventures &amp; Arabina</h1>
<p class="sub">Finance dashboard · sign in to continue</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<label for="u">Username</label>
<input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(user)}"${user ? "" : " autofocus"}>
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required${user ? " autofocus" : ""}>
<button type="submit">Sign in</button>
</form>
</main></body></html>`;
}

module.exports = { createAuth, hashPassword, parseUsers, safeNext, loginPage };
