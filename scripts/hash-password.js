#!/usr/bin/env node
// Makes one AUTH_USERS entry for the served dashboard.
//
//   npm run hash-password -- boss@79ventures.biz
//
// Asks for the password twice without showing it, and prints the line to paste into AUTH_USERS
// in Railway Variables (several accounts: one per line, or comma-separated). Only the hash is
// printed; the password itself is never written anywhere.
const { hashPassword } = require("../auth");

const user = (process.argv[2] || "").trim().toLowerCase();
if (!/^[^:\s,]+$/.test(user)) {
  console.error("Usage: npm run hash-password -- <username>   (no spaces, commas or colons)");
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(prompt);
    if (!stdin.isTTY) {
      // Piped input, e.g. from a script: read one line.
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => { buf += c; const i = buf.indexOf("\n"); if (i >= 0) { stdin.pause(); resolve(buf.slice(0, i).replace(/\r$/, "")); } });
      return;
    }
    let pw = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      if (ch === "\u0003") { stdout.write("\n"); process.exit(130); }
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); stdout.write("\n"); resolve(pw); return;
      }
      if (ch === "\u007f" || ch === "\b") { pw = pw.slice(0, -1); return; }
      pw += ch;
    };
    stdin.on("data", onData);
  });
}

(async () => {
  const a = await ask(`Password for ${user}: `);
  if (a.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
  const b = process.stdin.isTTY ? await ask("Again: ") : a;
  if (a !== b) { console.error("The two did not match."); process.exit(1); }
  console.log("\nAdd this line to AUTH_USERS in Railway Variables:\n");
  console.log(`${user}:${hashPassword(a)}`);
})();
