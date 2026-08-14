/**
 * chrome-cookies.mjs — read + decrypt Wix cookies from a local Chrome profile on macOS
 * and return them shaped for Playwright's context.addCookies().
 *
 * How Chrome stores cookies on macOS:
 *   - SQLite DB at "<profile>/Cookies" (older) or "<profile>/Network/Cookies" (newer).
 *   - host_key, name, path, expiry, flags are PLAINTEXT; only the value is encrypted.
 *   - value = "v10" + AES-128-CBC( key = PBKDF2-SHA1("Chrome Safe Storage" keychain
 *     password, salt="saltysalt", 1003 iters, 16 bytes), IV = 16 spaces ).
 *   - Chrome ~v130+ prepends a 32-byte SHA-256(domain) to the plaintext before encrypting;
 *     we detect and strip it.
 *
 * The keychain read triggers ONE macOS auth prompt ("security wants to use the
 * 'Chrome Safe Storage' key"). Approve it.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let sqlite3;
try {
  ({ default: sqlite3 } = await import("node:sqlite")); // Node 22.5+ experimental
} catch {}

const CHROME_ROOT = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

function safeStorageKey() {
  // -w prints just the password; -s selects the service.
  const pw = execFileSync("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"], {
    encoding: "utf8",
  }).trim();
  return crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function decryptValue(encrypted, key) {
  if (!encrypted || encrypted.length < 4) return "";
  const prefix = encrypted.slice(0, 3).toString("utf8");
  if (prefix !== "v10") return encrypted.toString("utf8"); // unencrypted / unknown
  const iv = Buffer.alloc(16, " ");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(encrypted.slice(3)), decipher.final()]);
  // strip PKCS7 padding manually (autopadding off to tolerate Chrome quirks)
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
  // Chrome v130+: 32-byte domain hash prepended. Detect via control bytes in first 32.
  const head = out.slice(0, 32);
  const looksHashed = out.length > 32 && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(head.toString("binary"));
  return (looksHashed ? out.slice(32) : out).toString("utf8");
}

function findCookieDb(profile) {
  const base = path.join(CHROME_ROOT, profile);
  for (const p of [path.join(base, "Network", "Cookies"), path.join(base, "Cookies")]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No Cookies DB under ${base}`);
}

function readRows(dbPath) {
  // Chrome locks the live DB; work on a copy.
  const tmp = path.join(os.tmpdir(), `wixmcp-cookies-${Date.now()}.db`);
  fs.copyFileSync(dbPath, tmp);
  try {
    if (!sqlite3) {
      throw new Error(
        "node:sqlite unavailable (needs Node >=22.5). Install a sqlite module or upgrade Node."
      );
    }
    const db = new sqlite3.DatabaseSync(tmp, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT host_key, name, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc,
                is_secure, is_httponly, samesite
         FROM cookies WHERE host_key LIKE '%wix.com'`
      )
      .all();
    db.close();
    return rows;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const sameSiteMap = { 0: "None", 1: "Lax", 2: "Strict" };

/** Returns Playwright-ready cookie objects for all *.wix.com cookies in the profile. */
export function readWixCookies({ profile = process.env.WIX_CHROME_PROFILE || "Default" } = {}) {
  if (process.platform !== "darwin") {
    throw new Error(
      "Cookie import is macOS-only (reads the 'Chrome Safe Storage' Keychain key). " +
        "On other platforms, log in manually once via wix_open_editor — the session persists."
    );
  }
  const key = safeStorageKey();
  const rows = readRows(findCookieDb(profile));
  const cookies = [];
  for (const r of rows) {
    let value = "";
    try {
      value = decryptValue(Buffer.from(r.encrypted_value), key);
    } catch {
      continue; // skip any single cookie that won't decrypt
    }
    // expires_utc is microseconds since 1601-01-01 (read as TEXT to dodge int overflow); 0 => session.
    const eutc = Number(r.expires_utc || 0);
    const expires = eutc ? Math.floor(eutc / 1e6 - 11644473600) : -1;
    const cookie = {
      name: r.name,
      value,
      domain: r.host_key,
      path: r.path || "/",
      httpOnly: !!r.is_httponly,
      secure: !!r.is_secure,
      sameSite: sameSiteMap[r.samesite] || "Lax",
    };
    if (expires > 0) cookie.expires = expires;
    // Playwright rejects SameSite=None without Secure.
    if (cookie.sameSite === "None" && !cookie.secure) cookie.sameSite = "Lax";
    cookies.push(cookie);
  }
  return cookies;
}
