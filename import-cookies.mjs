#!/usr/bin/env node
/**
 * import-cookies.mjs — one-shot: copy your logged-in Wix session from your everyday
 * Chrome profile into the MCP's isolated Playwright profile, so the editor opens
 * already authenticated (no manual login, ever — re-run when the session expires).
 *
 *   node import-cookies.mjs                    # uses Chrome's "Default" profile
 *   WIX_CHROME_PROFILE="Profile 1" node import-cookies.mjs   # if your Wix login is elsewhere
 *
 * macOS only. Triggers one Keychain prompt for "Chrome Safe Storage" — approve it.
 * The MCP's Chrome must be CLOSED while this runs (it writes to that profile).
 */
import { chromium } from "playwright-core";
import os from "node:os";
import path from "node:path";
import { readWixCookies } from "./chrome-cookies.mjs";

const PROFILE_DIR = process.env.WIX_PROFILE_DIR || path.join(os.homedir(), ".wix-editor-mcp", "profile");
const CHANNEL = process.env.WIX_CHROME_CHANNEL || "chrome";

const srcProfile = process.env.WIX_CHROME_PROFILE || "Default";
console.log(`Reading Wix cookies from Chrome "${srcProfile}" …`);
const cookies = readWixCookies({ profile: srcProfile });
console.log(`  decrypted ${cookies.length} *.wix.com cookies`);
if (!cookies.length) {
  console.error("No cookies found — is the Wix login in a different Chrome profile? Set WIX_CHROME_PROFILE.");
  process.exit(1);
}

console.log(`Injecting into MCP profile ${PROFILE_DIR} …`);
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { channel: CHANNEL, headless: true });
try {
  await ctx.addCookies(cookies);
  console.log(`Done. ${cookies.length} cookies stored. The editor will now open logged in.`);
} finally {
  await ctx.close();
}
