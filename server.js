#!/usr/bin/env node
/**
 * wix-editor-mcp: an MCP server that drives the Wix classic ("Harmony"/Odeditor) Editor
 * through its internal documentServices API, reached via Playwright and a real Chrome.
 *
 * Why this exists: classic Wix Editor sites have NO public API for creating or editing
 * static pages (the Blog/CMS REST APIs cannot touch them). The editor page itself
 * exposes two programmatic surfaces, verified against a live site:
 *   - window.__OdeditorE2EApi__          (top frame; Wix's own E2E-test API)
 *   - window.frames[n].documentServices  (same-origin child frame; the full DS API)
 *
 * Verified call shapes (trial-run 2026-08-13 on a live Harmony editor):
 *   ds.pages.getPagesData()                                    -> [{id,title,pageUriSEO,...}]
 *   top.__OdeditorE2EApi__.addPage(title)                      -> {documentPointer:{id}}
 *   ds.pages.duplicate(pageId)                                 -> {id}
 *   ds.pages.remove(pageId, onDone)                            (callback style)
 *   ds.pages.data.update(pageId, {title,pageUriSEO,pageTitleSEO,descriptionSEO,hidePage,indexable})
 *   ds.pages.navigateTo(pageId)                                (required before reading page comps)
 *   ds.components.getChildren(ref) / getType(ref) / data.get(ref)
 *   text: data.get -> {richText:{text,...}} (Builder.RichText) OR classic {text}
 *         updates MUST send the FULL nested richText object back, not a partial
 *   ds.menu.getById('CUSTOM_MAIN_MENU') / addItem(menuId, {type:'BasicMenuItem',label,link:{type:'PageLink',pageId:'#xyz'},isVisible})
 *   ds.menu.removeItem(menuId, itemId)                         (2-arg form; 1-arg silently no-ops)
 *   ds.save(onSuccess, onError)                                (saves DRAFT, does not publish)
 *   ds.waitForChangesAppliedAsync()                            (await after every mutation)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// The editor URL for your site: open the Wix Editor in a browser, copy the address-bar
// URL (looks like https://<site>.editor.wix.com/edit/od/<id>?metaSiteId=<id>), and set
// WIX_EDITOR_URL, or pass {url} to the wix_open_editor tool, which remembers it for
// the session.
let editorUrl = process.env.WIX_EDITOR_URL || "";
const PROFILE_DIR =
  process.env.WIX_PROFILE_DIR || path.join(os.homedir(), ".wix-editor-mcp", "profile");
const HEADLESS = process.env.WIX_HEADLESS === "1";
const CHROME_CHANNEL = process.env.WIX_CHROME_CHANNEL || "chrome";

// The manage.wix.com data gateway (CMS, Blog, site properties) needs a signed app
// instance token, NOT just the session cookies (cookies alone -> 403). Any app's
// instance from the editor authorizes the whole gateway. Verified live: the Blog app's
// instance token works for cloud-data (CMS), the blog API, and site-properties.
const MANAGE_API = "https://manage.wix.com/_api";
const AUTH_APP_DEF_ID = "14bcded7-0066-7c35-14d7-466cb3f09103"; // Wix Blog

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------
let context = null;
let page = null;

async function launch() {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: CHROME_CHANNEL,
    headless: HEADLESS,
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.on("close", () => {
    context = null;
    page = null;
  });
  page = context.pages()[0] || (await context.newPage());
}

/** True once documentServices is reachable in some same-origin frame. */
async function dsReady() {
  try {
    return await page.evaluate(() => {
      for (let i = 0; i < window.frames.length; i++) {
        try {
          if (window.frames[i].documentServices) return true;
        } catch (e) {}
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function waitForDs(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dsReady()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Make sure the editor is open and documentServices is live.
 * Handles: browser not launched, tab navigated away, and the Wix login wall
 * (first run with a fresh profile: the user logs in once in the headed window).
 */
async function ensureEditor(loginWaitMs = 0) {
  if (!context || !page || page.isClosed()) {
    if (context) {
      try {
        await context.close();
      } catch {}
    }
    await launch();
  }
  if (await dsReady()) return;

  if (!editorUrl) {
    throw new Error(
      "No editor URL configured. Open your site in the Wix Editor, copy the address-bar URL " +
        "(https://<site>.editor.wix.com/edit/od/…?metaSiteId=…), then either set the WIX_EDITOR_URL " +
        "env var or call wix_open_editor with {url} (remembered for the session)."
    );
  }
  await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  if (await waitForDs(90_000)) return;

  const url = page.url();
  const atLogin = /users\.wix\.com|signin|login|wix\.com\/signup/i.test(url);
  if (atLogin && loginWaitMs > 0) {
    // Give the user time to log in inside the visible window, then the editor loads.
    if (await waitForDs(loginWaitMs)) return;
  }
  throw new Error(
    atLogin
      ? `Wix wants a login (currently at ${url}). A Chrome window is open. Log in there once (the session persists in ${PROFILE_DIR}), then call this tool again. Or run wix_open_editor, which waits up to 4 minutes for you.`
      : `Editor did not expose documentServices within the wait (currently at ${url}). Try wix_open_editor, or check the window for an error dialog.`
  );
}

/**
 * Evaluate a function in the editor tab with the DS + E2E APIs found for you.
 * `fn` runs IN THE PAGE with signature (ds, e2e, arg). Must be self-contained.
 */
async function inEditor(fn, arg = null) {
  await ensureEditor();
  return page.evaluate(
    ({ fnSrc, arg }) => {
      const getDs = () => {
        for (let i = 0; i < window.frames.length; i++) {
          try {
            if (window.frames[i].documentServices) return window.frames[i].documentServices;
          } catch (e) {}
        }
        throw new Error("documentServices not found: editor not fully loaded");
      };
      const fn = new Function(`return (${fnSrc})`)();
      return fn(getDs(), window.__OdeditorE2EApi__, arg);
    },
    { fnSrc: fn.toString(), arg }
  );
}

// Small helpers reused inside page-context functions are inlined there because
// evaluate() serializes each function, so nothing from this module scope survives.

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });
const errText = (e) => ({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });

/**
 * Call a manage.wix.com/_api service (CMS, Blog, site properties) with the editor
 * session's auth. Reads a fresh app instance token from the editor (they expire) plus
 * the XSRF cookie, and reuses Playwright's cookie jar via context.request.
 * apiPath is relative to /_api (or an absolute https URL). Throws on non-2xx.
 */
async function wixManageApi(method, apiPath, { body, headers } = {}) {
  await ensureEditor();
  const instance = await inEditor((ds, e2e, app) => ds.tpa.app.getDataByAppDefId(app).instance, AUTH_APP_DEF_ID);
  if (!instance) throw new Error("Could not read an app instance token from the editor. Is the site fully loaded? Try wix_open_editor.");
  const cookies = await context.cookies("https://manage.wix.com");
  const xsrf = (cookies.find((c) => c.name === "XSRF-TOKEN") || {}).value || "";
  const url = apiPath.startsWith("http") ? apiPath : `${MANAGE_API}/${apiPath}`;
  const opts = { headers: { Authorization: instance, "X-XSRF-TOKEN": xsrf, "Content-Type": "application/json", ...headers } };
  if (body !== undefined) opts.data = body;
  const resp = await context.request[method](url, opts);
  const t = await resp.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  if (!resp.ok()) {
    const msg = j && j.message ? j.message : typeof j === "string" ? j.slice(0, 200) : JSON.stringify(j).slice(0, 200);
    throw new Error(`Wix API ${method.toUpperCase()} ${apiPath} → HTTP ${resp.status()}: ${msg}`);
  }
  return j;
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "wix-editor", version: "0.4.1" });

function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return await handler(args || {});
    } catch (e) {
      return errText(e);
    }
  });
}

// --- session -----------------------------------------------------------------

tool(
  "wix_import_login",
  "Skip the manual Wix login (macOS only): decrypt your logged-in Wix session cookies from your everyday Chrome profile and inject them into this MCP's browser, so the editor opens already authenticated. Re-run whenever the session expires. Triggers one macOS Keychain prompt ('Chrome Safe Storage') that you must approve. Optional chromeProfile picks which Chrome profile holds your Wix login (default 'Default'; also settable via WIX_CHROME_PROFILE).",
  { chromeProfile: z.string().optional() },
  async ({ chromeProfile }) => {
    const { readWixCookies } = await import("./chrome-cookies.mjs");
    const profile = chromeProfile || process.env.WIX_CHROME_PROFILE || "Default";
    const cookies = readWixCookies({ profile });
    if (!cookies.length) throw new Error(`No *.wix.com cookies found in Chrome profile "${profile}". If your Wix login lives in another profile (e.g. 'Profile 1'), pass chromeProfile or set WIX_CHROME_PROFILE.`);
    if (!context || !page || page.isClosed()) await launch();
    await context.addCookies(cookies);
    if (!editorUrl) return text(`Imported ${cookies.length} Wix cookies. No editor URL configured yet. Call wix_open_editor with {url} (or set WIX_EDITOR_URL) to open the editor.`);
    // Load the editor with the freshly injected session.
    await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const ok = await waitForDs(90_000);
    if (!ok) throw new Error(`Injected ${cookies.length} cookies but the editor still is not scriptable (at ${page.url()}). The session may be expired. Log in to Wix once in that Chrome profile, then re-run.`);
    const pages = await inEditor((ds) => ds.pages.getPagesData().map((p) => p.title));
    return text(`Imported ${cookies.length} Wix cookies and opened the editor logged in. Pages: ${pages.join(", ")}`);
  }
);

tool(
  "wix_open_editor",
  "Open (or re-open) the Wix Editor in the managed Chrome window and wait for it to be scriptable. First run on a fresh profile shows the Wix login. Log in once in that window; this tool waits up to 4 minutes. Optional url sets or overrides the editor URL for the whole session (grab it from the address bar of the Wix Editor: https://<site>.editor.wix.com/edit/od/…?metaSiteId=…).",
  { url: z.string().optional() },
  async ({ url }) => {
    if (url) {
      editorUrl = url;
      if (!context || !page || page.isClosed()) await launch();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
      if (!(await waitForDs(240_000))) throw new Error("Editor did not become scriptable at " + url);
    } else {
      await ensureEditor(240_000);
    }
    const pages = await inEditor((ds) => ds.pages.getPagesData().map((p) => p.title));
    return text(`Editor ready. Pages: ${pages.join(", ")}`);
  }
);

tool(
  "wix_status",
  "Report the state of the managed browser/editor session: whether Chrome is running, the current URL, whether documentServices is scriptable, current page in the editor, and autosave status.",
  {},
  async () => {
    if (!context || !page || page.isClosed()) return text("Browser not running. Any tool call will launch it (wix_open_editor recommended first).");
    const ready = await dsReady();
    let extra = "";
    if (ready) {
      const s = await inEditor((ds) => ({
        currentPage: ds.pages.getCurrentPageId(),
        pageCount: ds.pages.getPagesData().length,
        canAutosave: (() => { try { return ds.canAutosave(); } catch (e) { return "?"; } })(),
      }));
      extra = ` | currentPage: ${s.currentPage} | pages: ${s.pageCount} | autosave: ${s.canAutosave}`;
    }
    return text(`URL: ${page.url()} | scriptable: ${ready}${extra}`);
  }
);

tool(
  "wix_screenshot",
  "Screenshot the editor window (PNG). Use to visually verify what the editor shows after changes.",
  {},
  async () => {
    await ensureEditor();
    const buf = await page.screenshot({ type: "png" });
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
  }
);

// --- pages -------------------------------------------------------------------

tool(
  "wix_list_pages",
  "List all pages in the site draft: id, title, URL slug, static vs app-owned (Blog etc.), hidden flag, SEO title/description.",
  {},
  async () => {
    const rows = await inEditor((ds) =>
      ds.pages.getPagesData().map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.pageUriSEO,
        kind: p.managingAppDefId ? "app" : "static",
        hidden: !!p.hidePage,
        indexable: p.indexable !== false,
        seoTitle: p.pageTitleSEO || "",
        seoDescription: p.descriptionSEO || "",
      }))
    );
    return text(rows);
  }
);

tool(
  "wix_add_page",
  "Create a NEW blank static page in the draft (the thing Wix has no public API for). Returns the new pageId. Nothing goes live until wix_publish. Tip: for a page that should match existing design, prefer wix_duplicate_page.",
  {
    title: z.string(),
    slug: z.string().optional().describe("URL slug, e.g. 'fort-worth'. Defaults to Wix's auto slug."),
  },
  async ({ title, slug }) => {
    const result = await inEditor(
      async (ds, e2e, { title, slug }) => {
        const ref = e2e.addPage(title);
        const id = ref.documentPointer ? ref.documentPointer.id : ref.id;
        await ds.waitForChangesAppliedAsync();
        if (slug) {
          ds.pages.data.update(id, { pageUriSEO: slug });
          await ds.waitForChangesAppliedAsync();
        }
        const d = ds.pages.data.get(id);
        return { pageId: id, title: d.title, slug: d.pageUriSEO };
      },
      { title, slug }
    );
    return text(result);
  }
);

tool(
  "wix_duplicate_page",
  "Duplicate an existing page (it keeps the sections and design, the practical way to make consistent new pages), then optionally retitle or re-slug it. Returns the new pageId. Use wix_page_structure and wix_set_texts afterwards to replace the copy.",
  {
    pageId: z.string(),
    title: z.string().optional(),
    slug: z.string().optional(),
  },
  async ({ pageId, title, slug }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId, title, slug }) => {
        const ref = ds.pages.duplicate(pageId);
        const id = ref.pageId || ref.id;
        await ds.waitForChangesAppliedAsync();
        const patch = {};
        if (title) patch.title = title;
        if (slug) patch.pageUriSEO = slug;
        if (Object.keys(patch).length) {
          ds.pages.data.update(id, patch);
          await ds.waitForChangesAppliedAsync();
        }
        const d = ds.pages.data.get(id);
        return { pageId: id, title: d.title, slug: d.pageUriSEO };
      },
      { pageId, title, slug }
    );
    return text(result);
  }
);

tool(
  "wix_delete_page",
  "Delete a page from the draft. This is irreversible after save and publish, so double-check the pageId against wix_list_pages first.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        const before = ds.pages.getPagesData().find((p) => p.id === pageId);
        if (!before) return { ok: false, error: "No page with id " + pageId };
        if (ds.pages.getCurrentPageId() === pageId) {
          ds.pages.navigateTo(ds.homePage ? ds.homePage.get() : "c1dmp");
          await ds.waitForChangesAppliedAsync();
        }
        await new Promise((resolve) => {
          ds.pages.remove(pageId, resolve);
          setTimeout(resolve, 10000);
        });
        await ds.waitForChangesAppliedAsync();
        const gone = !ds.pages.getPagesData().some((p) => p.id === pageId);
        return { ok: gone, removed: before.title };
      },
      { pageId }
    );
    return text(result);
  }
);

tool(
  "wix_update_page",
  "Update a page's metadata: title, URL slug, SEO title tag, SEO meta description, hidden flag, search indexability. Only provided fields change.",
  {
    pageId: z.string(),
    title: z.string().optional(),
    slug: z.string().optional(),
    seoTitle: z.string().optional().describe("The <title> tag for this page"),
    seoDescription: z.string().optional().describe("Meta description"),
    hidePage: z.boolean().optional(),
    indexable: z.boolean().optional(),
  },
  async ({ pageId, ...fields }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId, fields }) => {
        // Plain page-data fields.
        const map = { title: "title", slug: "pageUriSEO", hidePage: "hidePage", indexable: "indexable" };
        const patch = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined && map[k]) patch[map[k]] = v;
        if (Object.keys(patch).length) {
          ds.pages.data.update(pageId, patch);
          await ds.waitForChangesAppliedAsync();
        }
        // SEO title/description: modern Wix renders these from advancedSeoData (a JSON
        // STRING holding {tags:[...]}), NOT the legacy pageTitleSEO/descriptionSEO fields.
        // A duplicated page inherits the SOURCE page's tags, so we must update them here.
        if (fields.seoTitle !== undefined || fields.seoDescription !== undefined) {
          const d = ds.pages.data.get(pageId);
          let adv = {};
          try { adv = JSON.parse(d.advancedSeoData || "{}"); } catch (e) {}
          if (!Array.isArray(adv.tags)) adv.tags = [];
          if (fields.seoTitle !== undefined) {
            let t = adv.tags.find((x) => x.type === "title");
            if (!t) { t = { type: "title", custom: false, disabled: false }; adv.tags.unshift(t); }
            t.children = fields.seoTitle;
          }
          if (fields.seoDescription !== undefined) {
            let m = adv.tags.find((x) => x.type === "meta" && x.props && x.props.name === "description");
            if (!m) { m = { type: "meta", props: { name: "description", content: "" }, children: "", custom: false, disabled: false }; adv.tags.push(m); }
            m.props.content = fields.seoDescription;
          }
          ds.pages.data.update(pageId, { advancedSeoData: JSON.stringify(adv) });
          await ds.waitForChangesAppliedAsync();
        }
        const d = ds.pages.data.get(pageId);
        let adv = {}; try { adv = JSON.parse(d.advancedSeoData || "{}"); } catch (e) {}
        const titleTag = (adv.tags || []).find((x) => x.type === "title");
        const descTag = (adv.tags || []).find((x) => x.type === "meta" && x.props && x.props.name === "description");
        return { ok: true, title: d.title, slug: d.pageUriSEO, seoTitle: titleTag ? titleTag.children : "", seoDescription: descTag ? descTag.props.content : "", hidePage: !!d.hidePage, indexable: d.indexable !== false };
      },
      { pageId, fields }
    );
    return text(result);
  }
);

tool(
  "wix_add_schema",
  "Add a JSON-LD structured-data block (schema.org) to a page. It is appended to advancedSeoData as a <script type=\"application/ld+json\"> tag, the same place Wix's SEO panel stores 'Structured data markup'. Pass the schema as a JSON object. displayName labels it in the Wix SEO UI. Good for per-page Service and FAQPage schema on city/service pages.",
  {
    pageId: z.string(),
    displayName: z.string().describe("Label for this markup, e.g. 'Service - Fort Worth'"),
    schema: z.record(z.any()).describe("The JSON-LD object (will be JSON-stringified into the script tag)"),
  },
  async ({ pageId, displayName, schema }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId, displayName, schema }) => {
        const d = ds.pages.data.get(pageId);
        let adv = {}; try { adv = JSON.parse(d.advancedSeoData || "{}"); } catch (e) {}
        if (!Array.isArray(adv.tags)) adv.tags = [];
        const slug = "custom_" + displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
        // Replace an existing block with the same displayName, else append.
        const existing = adv.tags.findIndex((x) => x.type === "script" && x.meta && x.meta.displayName === displayName);
        const tag = { type: "script", props: { type: "application/ld+json" }, meta: { schemaType: slug, displayName }, children: JSON.stringify(schema), custom: true, disabled: false };
        if (existing >= 0) adv.tags[existing] = tag; else adv.tags.push(tag);
        ds.pages.data.update(pageId, { advancedSeoData: JSON.stringify(adv) });
        await ds.waitForChangesAppliedAsync();
        const after = JSON.parse(ds.pages.data.get(pageId).advancedSeoData);
        return { ok: true, schemas: after.tags.filter((x) => x.type === "script").map((x) => x.meta && x.meta.displayName) };
      },
      { pageId, displayName, schema }
    );
    return text(result);
  }
);

tool(
  "wix_set_gallery",
  "Retext a Pro Gallery (FastGallery). These are the numbered image cards whose title and description live in the component's data.items, NOT as child text components (so wix_page_structure cannot see them). Find galleryId via wix_find_galleries. Provide items in order; each {title, description} updates the matching card and keeps its image.",
  {
    pageId: z.string(),
    galleryId: z.string(),
    items: z.array(z.object({ title: z.string().optional(), description: z.string().optional() })),
  },
  async ({ pageId, galleryId, items }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId, galleryId, items }) => {
        if (ds.pages.getCurrentPageId() !== pageId) { ds.pages.navigateTo(pageId); await ds.waitForChangesAppliedAsync(); await new Promise((r) => setTimeout(r, 800)); }
        const ref = { id: galleryId, type: "DESKTOP" };
        const d = ds.components.data.get(ref);
        if (!d || !Array.isArray(d.items)) return { ok: false, error: "not a gallery / no items" };
        const merged = d.items.map((it, i) => (items[i] ? Object.assign({}, it, items[i].title !== undefined ? { title: items[i].title } : {}, items[i].description !== undefined ? { description: items[i].description } : {}) : it));
        ds.components.data.update(ref, Object.assign({}, d, { items: merged }));
        await ds.waitForChangesAppliedAsync();
        return { ok: true, titles: ds.components.data.get(ref).items.map((x) => x.title) };
      },
      { pageId, galleryId, items }
    );
    return text(result);
  }
);

tool(
  "wix_find_galleries",
  "List every Pro Gallery (FastGallery) on a page with its galleryId and current card titles, so you can spot galleries that wix_page_structure misses and feed their ids to wix_set_gallery.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        if (ds.pages.getCurrentPageId() !== pageId) { ds.pages.navigateTo(pageId); await ds.waitForChangesAppliedAsync(); await new Promise((r) => setTimeout(r, 800)); }
        const pageRef = ds.pages.getReference(pageId);
        const found = [];
        const walk = (r, depth) => {
          if (!r || !r.id || depth > 15) return;
          let t = ""; try { t = ds.components.getType(r); } catch (e) {}
          if (/Gallery/i.test(t)) {
            let titles = []; try { const d = ds.components.data.get(r); titles = (d.items || []).map((x) => x.title); } catch (e) {}
            found.push({ galleryId: r.id, type: t.split(".").pop(), cards: titles });
          }
          let kids = []; try { kids = ds.components.getChildren(r) || []; } catch (e) {}
          for (const k of kids) walk(k, depth + 1);
        };
        walk(pageRef, 0);
        return found;
      },
      { pageId }
    );
    return text(result);
  }
);

// --- page content ------------------------------------------------------------

tool(
  "wix_page_structure",
  "Navigate the editor to a page and return its component tree: componentId, type, and current text for every text element. This is how you find the componentIds to pass to wix_set_text. (The editor must render a page before its components are readable; this tool handles that.)",
  {
    pageId: z.string().describe("A page id from wix_list_pages, or 'masterPage' for the site header/footer (their content lives in HeaderSection/FooterSection components there, always rendered)"),
    textOnly: z.boolean().optional().describe("If true, return only text components (flat list)"),
  },
  async ({ pageId, textOnly }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId, textOnly }) => {
        if (pageId !== "masterPage") {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1500));
        }
        const pageRef = ds.pages.getReference(pageId);
        const out = [];
        const readText = (ref) => {
          try {
            const d = ds.components.data.get(ref);
            if (d && d.richText && typeof d.richText.text === "string") return d.richText.text;
            if (d && typeof d.text === "string") return d.text;
          } catch (e) {}
          return null;
        };
        const walk = (ref, depth) => {
          if (depth > 12) return;
          let type = "?";
          try { type = ds.components.getType(ref).split(".").pop(); } catch (e) {}
          const t = /RichText|StylableText|Text/i.test(type) ? readText(ref) : null;
          if (!textOnly) out.push({ depth, id: ref.id, type, text: t || undefined });
          else if (t !== null) out.push({ id: ref.id, type, text: t });
          let kids = [];
          try { kids = ds.components.getChildren(ref); } catch (e) {}
          for (const k of kids) walk(k, depth + 1);
        };
        walk(pageRef, 0);
        return out;
      },
      { pageId, textOnly: !!textOnly }
    );
    return text(result);
  }
);

tool(
  "wix_get_text",
  "Read the HTML text of one text component. Pass pageId so the editor can navigate there first (components are only readable on the rendered page).",
  { componentId: z.string(), pageId: z.string().optional() },
  async ({ componentId, pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { componentId, pageId }) => {
        if (pageId && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const ref = { id: componentId, type: "DESKTOP" };
        const d = ds.components.data.get(ref);
        if (d && d.richText) return { componentId, kind: "richText", html: d.richText.text };
        if (d && typeof d.text === "string") return { componentId, kind: "classic", html: d.text };
        return { componentId, error: "component has no readable text", dataKeys: d ? Object.keys(d) : null };
      },
      { componentId, pageId }
    );
    return text(result);
  }
);

// Shared page-context implementation for single + batch text setting.
async function setTextsImpl(edits, pageId) {
  return inEditor(
    async (ds, e2e, { edits, pageId }) => {
      if (pageId && ds.pages.getCurrentPageId() !== pageId) {
        ds.pages.navigateTo(pageId);
        await ds.waitForChangesAppliedAsync();
        await new Promise((r) => setTimeout(r, 1000));
      }
      const results = [];
      for (const { componentId, html } of edits) {
        const ref = { id: componentId, type: "DESKTOP" };
        try {
          const d = ds.components.data.get(ref);
          if (d && d.richText) {
            // GOTCHA (verified): partial nested updates are silently ignored.
            // Send the FULL richText object back with only .text replaced.
            const rt = Object.assign({}, d.richText, { text: html });
            ds.components.data.update(ref, { richText: rt });
          } else if (d && typeof d.text === "string") {
            ds.components.data.update(ref, { text: html });
          } else {
            results.push({ componentId, ok: false, error: "no text field on component" });
            continue;
          }
          await ds.waitForChangesAppliedAsync();
          const after = ds.components.data.get(ref);
          const now = after.richText ? after.richText.text : after.text;
          results.push({ componentId, ok: now === html, now: now.slice(0, 120) });
        } catch (e) {
          results.push({ componentId, ok: false, error: e.message });
        }
      }
      return results;
    },
    { edits, pageId }
  );
}

tool(
  "wix_set_text",
  "Set the HTML text of one text component (e.g. '<h2>New heading</h2>' or '<p>Body…</p>'). Get componentIds from wix_page_structure. Pass pageId to let the editor navigate there first. Changes are draft-only until wix_publish.",
  { componentId: z.string(), html: z.string(), pageId: z.string().optional() },
  async ({ componentId, html, pageId }) => text(await setTextsImpl([{ componentId, html }], pageId))
);

tool(
  "wix_set_texts",
  "Batch version of wix_set_text: replace the text of many components on one page in a single call, the efficient way to retext a duplicated page. Each edit: {componentId, html}.",
  {
    pageId: z.string(),
    edits: z.array(z.object({ componentId: z.string(), html: z.string() })),
  },
  async ({ pageId, edits }) => text(await setTextsImpl(edits, pageId))
);

// --- navigation menu -----------------------------------------------------------

tool(
  "wix_nav_menu",
  "Read the site navigation menus (CUSTOM_MAIN_MENU etc.): item ids, labels, linked pages, visibility, nesting.",
  {},
  async () => {
    const result = await inEditor((ds) =>
      ds.menu.getAll().map((m) => ({
        menuId: m.id,
        name: m.name,
        items: (m.items || []).map(function mapItem(it) {
          return {
            itemId: it.id,
            label: it.label,
            pageId: it.link && it.link.pageId ? String(it.link.pageId).replace("#", "") : undefined,
            url: it.link && it.link.url,
            visible: it.isVisible !== false,
            items: (it.items || []).map(mapItem),
          };
        }),
      }))
    );
    return text(result);
  }
);

tool(
  "wix_nav_add",
  "Add a page link to a navigation menu (default CUSTOM_MAIN_MENU). Returns the new itemId.",
  {
    label: z.string(),
    pageId: z.string().describe("Target page id from wix_list_pages (without '#')"),
    menuId: z.string().optional(),
    hidden: z.boolean().optional(),
  },
  async ({ label, pageId, menuId, hidden }) => {
    const result = await inEditor(
      async (ds, e2e, { label, pageId, menuId, hidden }) => {
        const mid = menuId || "CUSTOM_MAIN_MENU";
        const itemId = ds.menu.addItem(mid, {
          type: "BasicMenuItem",
          label,
          link: { type: "PageLink", pageId: "#" + pageId.replace("#", "") },
          isVisible: !hidden,
        });
        await ds.waitForChangesAppliedAsync();
        const m = ds.menu.getById(mid);
        return { itemId, menuNow: m.items.map((i) => i.label) };
      },
      { label, pageId, menuId, hidden }
    );
    return text(result);
  }
);

tool(
  "wix_nav_remove",
  "Remove an item from a navigation menu. NOTE: it requires BOTH menuId and itemId. Verified: the 1-arg form silently does nothing.",
  { itemId: z.string(), menuId: z.string().optional() },
  async ({ itemId, menuId }) => {
    const result = await inEditor(
      async (ds, e2e, { itemId, menuId }) => {
        const mid = menuId || "CUSTOM_MAIN_MENU";
        ds.menu.removeItem(mid, itemId);
        await ds.waitForChangesAppliedAsync();
        const m = ds.menu.getById(mid);
        return { ok: !m.items.some((i) => i.id === itemId), menuNow: m.items.map((i) => i.label) };
      },
      { itemId, menuId }
    );
    return text(result);
  }
);

// --- images & links ------------------------------------------------------------

tool(
  "wix_find_images",
  "List every image component on a page (or 'masterPage' for header/footer): componentId, current media uri, alt text, dimensions, display mode, and link. Feed componentIds to wix_set_image.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        if (pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1200));
        }
        const out = [];
        const walk = (r, depth) => {
          if (depth > 14) return;
          let t = ""; try { t = ds.components.getType(r).split(".").pop(); } catch (e) {}
          if (/^(Image|WPhoto|Photo)$/i.test(t)) {
            try {
              const d = ds.components.data.get(r);
              const img = d && d.image ? d.image : d; // Builder.Image nests under .image; classic WPhoto is flat
              out.push({
                componentId: r.id,
                type: t,
                uri: img && img.uri,
                alt: img && img.alt,
                name: img && img.name,
                width: img && img.width,
                height: img && img.height,
                displayMode: d && d.displayMode,
                link: d && d.link ? { type: d.link.type, pageId: d.link.pageId, url: d.link.url } : null,
              });
            } catch (e) { out.push({ componentId: r.id, type: t, error: e.message }); }
          }
          let kids = []; try { kids = ds.components.getChildren(r) || []; } catch (e) {}
          for (const k of kids) walk(k, depth + 1);
        };
        walk(ds.pages.getReference(pageId), 0);
        return out;
      },
      { pageId }
    );
    return text(result);
  }
);

// Shared by wix_set_image and wix_upload_image's place-after-upload step.
async function setImageImpl(componentId, pageId, fields) {
  return inEditor(
    async (ds, e2e, { componentId, pageId, fields }) => {
        if (pageId && pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const ref = { id: componentId, type: "DESKTOP" };
        const d = ds.components.data.get(ref);
        if (!d) return { ok: false, error: "no data on component " + componentId };
        const patch = {};
        for (const k of ["uri", "alt", "title", "width", "height"]) if (fields[k] !== undefined) patch[k] = fields[k];
        // GOTCHA (verified): partial nested updates are silently ignored. Send the
        // full nested image object back with only the changed fields replaced.
        if (d.image) ds.components.data.update(ref, { image: Object.assign({}, d.image, patch) });
        else ds.components.data.update(ref, patch);
        await ds.waitForChangesAppliedAsync();
        const after = ds.components.data.get(ref);
        const img = after.image || after;
        return { ok: true, uri: img.uri, alt: img.alt, width: img.width, height: img.height };
    },
    { componentId, pageId, fields }
  );
}

tool(
  "wix_set_image",
  "Update an image component: swap the media (uri plus width/height of the new media file) and/or set alt text. The uri must be a Wix media-manager uri (e.g. 'abc123_….jpg~mv2', from wix_find_images, or upload a new file with wix_upload_image). Handles both Builder.Image (nested) and classic WPhoto (flat) data shapes.",
  {
    componentId: z.string(),
    pageId: z.string().optional(),
    uri: z.string().optional().describe("Wix media uri; when swapping media also pass the new file's width+height"),
    alt: z.string().optional(),
    title: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  },
  async ({ componentId, pageId, ...fields }) => text(await setImageImpl(componentId, pageId, fields))
);

tool(
  "wix_upload_image",
  "Upload an image into the site's Wix Media Manager from a local file path or a URL. Returns the media uri and dimensions, ready for wix_set_image. Pass componentId (and pageId) to also place it on an image component in one step. Uses the editor session's upload token and cookies (verified live).",
  {
    filePath: z.string().optional().describe("Absolute path to a local image file"),
    url: z.string().optional().describe("Image URL to fetch and upload"),
    name: z.string().optional().describe("File name in the media manager (defaults to the source name)"),
    alt: z.string().optional().describe("Alt text, applied if componentId is given"),
    componentId: z.string().optional().describe("Image component to point at the uploaded media"),
    pageId: z.string().optional(),
  },
  async ({ filePath, url, name, alt, componentId, pageId }) => {
    if (!filePath && !url) throw new Error("Pass filePath or url.");
    await ensureEditor();
    let buffer, fileName = name;
    if (filePath) {
      buffer = await fs.readFile(filePath);
      fileName = fileName || path.basename(filePath);
    } else {
      const resp = await context.request.get(url);
      if (!resp.ok()) throw new Error(`Could not fetch ${url}: HTTP ${resp.status()}`);
      buffer = await resp.body();
      fileName = fileName || decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "upload.png";
    }
    const mime =
      { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[
        path.extname(fileName).toLowerCase()
      ] || "image/png";
    // Verified flow: in-editor site token -> files.wix.com hands out an upload URL
    // (requires the session cookies, which context.request shares) -> multipart POST.
    const token = await inEditor((ds) => Promise.resolve(ds.generalInfo.media.getSiteUploadToken()));
    const r1 = await context.request.get(
      "https://files.wix.com/site/media/files/upload/url?media_type=picture&site_token=" + encodeURIComponent(token)
    );
    if (!r1.ok()) throw new Error(`upload_url request failed: HTTP ${r1.status()} ${(await r1.text()).slice(0, 200)}`);
    const { upload_url, upload_token } = JSON.parse(await r1.text());
    const multipart = { file: { name: fileName, mimeType: mime, buffer }, media_type: "picture" };
    if (upload_token) multipart.upload_token = upload_token;
    const r2 = await context.request.post(upload_url, { multipart });
    if (!r2.ok()) throw new Error(`upload failed: HTTP ${r2.status()} ${(await r2.text()).slice(0, 200)}`);
    const [f] = JSON.parse(await r2.text());
    const uploaded = { uri: f.file_name, width: f.width, height: f.height, name: f.original_file_name };
    if (componentId) {
      const placed = await setImageImpl(componentId, pageId, {
        uri: f.file_name,
        width: f.width,
        height: f.height,
        ...(alt !== undefined ? { alt } : {}),
      });
      return text({ uploaded, placed });
    }
    return text(uploaded);
  }
);

tool(
  "wix_find_links",
  "List every linkable component on a page (or 'masterPage'): buttons and any component carrying a link, with its componentId, label, and current link (page/url/anchor/phone/email). Feed componentIds to wix_set_link.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        if (pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1200));
        }
        const out = [];
        const walk = (r, depth) => {
          if (depth > 14) return;
          let t = ""; try { t = ds.components.getType(r).split(".").pop(); } catch (e) {}
          try {
            const d = ds.components.data.get(r);
            if (d && (d.link !== undefined || typeof d.label === "string")) {
              const l = d.link;
              out.push({
                componentId: r.id,
                type: t,
                label: d.label,
                link: l ? { type: l.type, pageId: l.pageId, url: l.url, anchorName: l.anchorName, phoneNumber: l.phoneNumber, recipient: l.recipient, target: l.target } : null,
              });
            }
          } catch (e) {}
          let kids = []; try { kids = ds.components.getChildren(r) || []; } catch (e) {}
          for (const k of kids) walk(k, depth + 1);
        };
        walk(ds.pages.getReference(pageId), 0);
        return out;
      },
      { pageId }
    );
    return text(result);
  }
);

tool(
  "wix_set_link",
  "Point a button (or any linkable component) somewhere, and/or change its label. link shapes (verified): {type:'PageLink',pageId:'<pageId>'} | {type:'ExternalLink',url,target?:'_blank'} | {type:'PhoneLink',phoneNumber} | {type:'EmailLink',recipient,subject?} | {type:'AnchorLink',anchorName,anchorDataId,pageId}. Pass link:null to remove the link. (Links inside rich text are edited via wix_set_text with <a> HTML instead.)",
  {
    componentId: z.string(),
    pageId: z.string().optional(),
    label: z.string().optional().describe("New button text"),
    link: z.record(z.any()).nullable().optional(),
  },
  async ({ componentId, pageId, label, link }) => {
    const result = await inEditor(
      async (ds, e2e, { componentId, pageId, label, link }) => {
        if (pageId && pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const ref = { id: componentId, type: "DESKTOP" };
        const patch = {};
        if (label !== undefined) patch.label = label;
        if (link !== undefined) patch.link = link;
        if (!Object.keys(patch).length) return { ok: false, error: "nothing to change: pass label and/or link" };
        ds.components.data.update(ref, patch);
        await ds.waitForChangesAppliedAsync();
        const after = ds.components.data.get(ref);
        return { ok: true, label: after.label, link: after.link ? { type: after.link.type, pageId: after.link.pageId, url: after.link.url } : null };
      },
      { componentId, pageId, label, link }
    );
    return text(result);
  }
);

// --- components ----------------------------------------------------------------

tool(
  "wix_copy_component",
  "Copy any component (with its full subtree, data, and style) from one page to another. It serializes then adds, verified live. It lands in toContainerId (a section/container id from wix_page_structure), or the target page's first Section if omitted. Optional x/y repositions it after the copy.",
  {
    fromPageId: z.string(),
    fromComponentId: z.string(),
    toPageId: z.string(),
    toContainerId: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async ({ fromPageId, fromComponentId, toPageId, toContainerId, x, y }) => {
    const result = await inEditor(
      async (ds, e2e, { fromPageId, fromComponentId, toPageId, toContainerId, x, y }) => {
        if (fromPageId !== "masterPage" && ds.pages.getCurrentPageId() !== fromPageId) {
          ds.pages.navigateTo(fromPageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1200));
        }
        const ser = ds.components.serialize({ id: fromComponentId, type: "DESKTOP" });
        if (!ser) return { ok: false, error: "could not serialize " + fromComponentId };
        if (toPageId !== "masterPage" && ds.pages.getCurrentPageId() !== toPageId) {
          ds.pages.navigateTo(toPageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1200));
        }
        let containerRef = toContainerId ? { id: toContainerId, type: "DESKTOP" } : null;
        if (!containerRef) {
          const kids = ds.components.getChildren(ds.pages.getReference(toPageId)) || [];
          for (const k of kids) {
            let t = ""; try { t = ds.components.getType(k).split(".").pop(); } catch (e) {}
            if (/Section|Container/i.test(t)) { containerRef = k; break; }
          }
          if (!containerRef) return { ok: false, error: "no section/container found on target page: pass toContainerId" };
        }
        const newRef = ds.components.add(containerRef, ser);
        await ds.waitForChangesAppliedAsync();
        if (x !== undefined || y !== undefined) {
          const patch = {};
          if (x !== undefined) patch.x = x;
          if (y !== undefined) patch.y = y;
          ds.components.layout.update(newRef, patch);
          await ds.waitForChangesAppliedAsync();
        }
        let type = ""; try { type = ds.components.getType(newRef); } catch (e) {}
        return { ok: true, componentId: newRef.id, type, container: containerRef.id };
      },
      { fromPageId, fromComponentId, toPageId, toContainerId, x, y }
    );
    return text(result);
  }
);

tool(
  "wix_delete_component",
  "Delete a component (and its subtree) from a page. Draft-only until publish; wix_undo can revert it in-session.",
  { componentId: z.string(), pageId: z.string().optional() },
  async ({ componentId, pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { componentId, pageId }) => {
        if (pageId && pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const ref = { id: componentId, type: "DESKTOP" };
        let before = ""; try { before = ds.components.getType(ref); } catch (e) { return { ok: false, error: "no such component" }; }
        await new Promise((res) => { ds.components.remove(ref, res); setTimeout(res, 8000); });
        await ds.waitForChangesAppliedAsync();
        let gone = false; try { ds.components.getType(ref); } catch (e) { gone = true; }
        return { ok: gone, removedType: before };
      },
      { componentId, pageId }
    );
    return text(result);
  }
);

tool(
  "wix_set_layout",
  "Move/resize a component: any of x, y, width, height, rotationInDegrees. Returns the layout before and after.",
  {
    componentId: z.string(),
    pageId: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    rotationInDegrees: z.number().optional(),
  },
  async ({ componentId, pageId, ...patch }) => {
    const result = await inEditor(
      async (ds, e2e, { componentId, pageId, patch }) => {
        if (pageId && pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const ref = { id: componentId, type: "DESKTOP" };
        const before = ds.components.layout.get(ref);
        const clean = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
        if (!Object.keys(clean).length) return { layout: before };
        ds.components.layout.update(ref, clean);
        await ds.waitForChangesAppliedAsync();
        const after = ds.components.layout.get(ref);
        const pick = (l) => ({ x: l.x, y: l.y, width: l.width, height: l.height, rotationInDegrees: l.rotationInDegrees });
        return { ok: true, before: pick(before), after: pick(after) };
      },
      { componentId, pageId, patch }
    );
    return text(result);
  }
);

// --- site-level SEO, redirects, head tags --------------------------------------

tool(
  "wix_site_seo",
  "Get or set SITE-level SEO: default site title, site description, and search-engine indexing on/off. (Per-page SEO lives in wix_update_page.) Call with no args to read current values.",
  {
    siteTitle: z.string().optional(),
    siteDescription: z.string().optional(),
    indexing: z.boolean().optional().describe("false hides the whole site from search engines"),
  },
  async ({ siteTitle, siteDescription, indexing }) => {
    const result = await inEditor(
      async (ds, e2e, { siteTitle, siteDescription, indexing }) => {
        if (siteTitle !== undefined) ds.seo.title.set(siteTitle);
        if (siteDescription !== undefined) ds.seo.description.set(siteDescription);
        if (indexing !== undefined) ds.seo.indexing.enable(indexing);
        await ds.waitForChangesAppliedAsync();
        return {
          siteTitle: ds.seo.title.get(),
          siteDescription: ds.seo.description.get(),
          indexingEnabled: ds.seo.indexing.isEnabled(),
        };
      },
      { siteTitle, siteDescription, indexing }
    );
    return text(result);
  }
);

tool(
  "wix_redirects",
  "Manage the site's 301 redirects (the editor's URL Redirect Manager, verified live). No args lists all. set adds/updates mappings {'/old-path':'/new-path',...}; remove deletes by source path. Redirects go live on publish.",
  {
    set: z.record(z.string()).optional().describe("Map of source path -> destination path"),
    remove: z.array(z.string()).optional().describe("Source paths to delete"),
  },
  async ({ set, remove }) => {
    const result = await inEditor(
      async (ds, e2e, { set, remove }) => {
        if (set && Object.keys(set).length) { ds.seo.redirectUrls.update(set); await ds.waitForChangesAppliedAsync(); }
        if (remove && remove.length) { ds.seo.redirectUrls.remove(remove); await ds.waitForChangesAppliedAsync(); }
        return { redirects: ds.seo.redirectUrls.get() };
      },
      { set, remove }
    );
    return text(result);
  }
);

tool(
  "wix_head_tags",
  "Get or set the site-wide custom <head> HTML (verification meta tags, analytics snippets, the same field as the dashboard's Custom Code head section). Pass html to REPLACE the whole block (read first, then append to preserve existing tags). No args reads.",
  { html: z.string().optional() },
  async ({ html }) => {
    const result = await inEditor(
      async (ds, e2e, { html }) => {
        if (html !== undefined) { ds.seo.headTags.set(html); await ds.waitForChangesAppliedAsync(); }
        return { headTags: ds.seo.headTags.get() };
      },
      { html }
    );
    return text(result);
  }
);

// --- page export / import (wml) ------------------------------------------------

tool(
  "wix_export_page",
  "Serialize a whole page (structure, data, and styles) to a WML object (JSON), for backup, inspection, or diffing. NOTE: the matching import APIs (importExport.pages.wml.add/replace) return page pointers but do not materialize content in the current editor build (verified 2026-08). To template a page, use wix_duplicate_page plus wix_copy_component instead.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        // Verified: export takes a page REFERENCE, not a bare id.
        const wml = ds.importExport.pages.wml.export(ds.pages.getReference(pageId));
        return wml;
      },
      { pageId }
    );
    return text(result);
  }
);

// (wix_import_page was cut: importExport.pages.wml.add/replace return page pointers but
// never materialize content in the current editor build. Verified with three live
// attempts, 2026-08. Templating = wix_duplicate_page + wix_copy_component instead.)

// --- site & safety --------------------------------------------------------------

tool(
  "wix_undo",
  "Undo (or redo with redo:true) the last editor change in this session. The safety net after a bad component edit or delete.",
  { redo: z.boolean().optional() },
  async ({ redo }) => {
    const result = await inEditor(
      async (ds, e2e, { redo }) => {
        const can = redo ? ds.history.canRedo() : ds.history.canUndo();
        if (!can) return { ok: false, error: redo ? "nothing to redo" : "nothing to undo" };
        if (redo) ds.history.redo(); else ds.history.undo();
        await ds.waitForChangesAppliedAsync();
        return { ok: true, canUndo: ds.history.canUndo(), canRedo: ds.history.canRedo() };
      },
      { redo }
    );
    return text(result);
  }
);

tool(
  "wix_set_homepage",
  "Change which page is the site's homepage. No args reads the current homepage id.",
  { pageId: z.string().optional() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        if (pageId) { ds.homePage.set(pageId); await ds.waitForChangesAppliedAsync(); }
        const id = ds.homePage.get();
        const d = ds.pages.data.get(id);
        return { homePageId: id, title: d && d.title };
      },
      { pageId }
    );
    return text(result);
  }
);

tool(
  "wix_theme",
  "Read the site's theme palette (color_0…) and font styles (font_0…), so generated or inserted content can stay on-brand.",
  {},
  async () => {
    const result = await inEditor((ds) => ({
      colors: ds.theme.colors.getAll(),
      fonts: ds.theme.fonts.getAll(),
    }));
    return text(result);
  }
);

tool(
  "wix_favicon",
  "Get or set the site favicon. Pass uri (a Wix media uri, e.g. from wix_upload_image) to set; no args reads the current value. Goes live on publish.",
  { uri: z.string().optional() },
  async ({ uri }) => {
    const result = await inEditor(
      async (ds, e2e, { uri }) => {
        if (uri !== undefined) { ds.favicon.set(uri); await ds.waitForChangesAppliedAsync(); }
        return { favicon: ds.favicon.get() ?? null };
      },
      { uri }
    );
    return text(result);
  }
);

tool(
  "wix_page_background",
  "Get or set a page's background (verified live). No background arg reads. To set, either pass color (a hex value or theme token like '{color_11}') as a shortcut, or a full background object as returned by a get (its .ref holds color/fittingType/scrollType/mediaRef).",
  {
    pageId: z.string(),
    device: z.enum(["desktop", "mobile"]).optional(),
    color: z.string().optional(),
    background: z.record(z.any()).optional().describe("Full background object (as returned by this tool) to write back"),
  },
  async ({ pageId, device, color, background }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId, device, color, background }) => {
        const dev = device || "desktop";
        if (background) {
          ds.pages.background.update(pageId, background, dev);
          await ds.waitForChangesAppliedAsync();
        } else if (color !== undefined) {
          const bg = JSON.parse(JSON.stringify(ds.pages.background.get(pageId, dev)));
          bg.ref.color = color;
          ds.pages.background.update(pageId, bg, dev);
          await ds.waitForChangesAppliedAsync();
        }
        return ds.pages.background.get(pageId, dev);
      },
      { pageId, device, color, background }
    );
    return text(result);
  }
);

tool(
  "wix_popups",
  "Manage lightboxes/popups (promo modals, announcements). action 'list' shows all popups; 'add' creates a blank one (returns its pageId, then fill it with wix_copy_component/wix_set_texts and open it to inspect); 'open'/'close' toggle a popup in the editor view. Delete a popup with wix_delete_page (popups are pages).",
  {
    action: z.enum(["list", "add", "open", "close"]),
    popupId: z.string().optional().describe("Required for open"),
    title: z.string().optional().describe("Title for add"),
  },
  async ({ action, popupId, title }) => {
    const result = await inEditor(
      async (ds, e2e, { action, popupId, title }) => {
        if (action === "add") {
          const ref = ds.pages.popupPages.add(title || "New Popup");
          await ds.waitForChangesAppliedAsync();
          const id = (ref && (ref.pageId || ref.id)) || ref;
          return { ok: true, popupId: id, popups: ds.pages.popupPages.getDataList().map((p) => ({ id: p.id, title: p.title })) };
        }
        if (action === "open") {
          if (!popupId) return { ok: false, error: "popupId required" };
          ds.pages.popupPages.open(popupId);
          await ds.waitForChangesAppliedAsync();
          return { ok: true, current: ds.pages.popupPages.getCurrentPopupId() };
        }
        if (action === "close") {
          ds.pages.popupPages.close();
          await ds.waitForChangesAppliedAsync();
          return { ok: true };
        }
        return { popups: ds.pages.popupPages.getDataList().map((p) => ({ id: p.id, title: p.title, hidePage: !!p.hidePage })) };
      },
      { action, popupId, title }
    );
    return text(result);
  }
);

tool(
  "wix_mobile_optimize",
  "Re-run Wix's automatic mobile layout algorithm for a page (verified live). Do this after heavy desktop edits (copied components, new sections) so the mobile view re-flows instead of keeping the inherited layout.",
  { pageId: z.string() },
  async ({ pageId }) => {
    const result = await inEditor(
      async (ds, e2e, { pageId }) => {
        if (pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1200));
        }
        await Promise.resolve(ds.mobileAlgo.runForPage(pageId));
        await ds.waitForChangesAppliedAsync();
        return { ok: true, pageId };
      },
      { pageId }
    );
    return text(result);
  }
);

tool(
  "wix_component_style",
  "Get or update a component's style object (colors, borders, fonts: the raw editor style). CAUTION: many components share a GlobalStyle (style.type === 'GlobalStyle', e.g. 'button-primary'), so updating one restyles every component using it, site-wide. Read first; to restyle just one component, modify a copy via wix_eval with ds.components.style.fork(ref) before updating.",
  {
    componentId: z.string(),
    pageId: z.string().optional(),
    style: z.record(z.any()).optional().describe("Full style object to write back (as returned by a get)"),
  },
  async ({ componentId, pageId, style }) => {
    const result = await inEditor(
      async (ds, e2e, { componentId, pageId, style }) => {
        if (pageId && pageId !== "masterPage" && ds.pages.getCurrentPageId() !== pageId) {
          ds.pages.navigateTo(pageId);
          await ds.waitForChangesAppliedAsync();
          await new Promise((r) => setTimeout(r, 1000));
        }
        const ref = { id: componentId, type: "DESKTOP" };
        if (style) {
          ds.components.style.update(ref, style);
          await ds.waitForChangesAppliedAsync();
        }
        return ds.components.style.get(ref);
      },
      { componentId, pageId, style }
    );
    return text(result);
  }
);

// --- CMS / blog / business info (manage.wix.com data gateway) -------------------
// These cover the content the classic Editor's documentServices cannot reach: the same
// ground as the official Wix MCP and REST APIs, but driven from THIS server's already
// authenticated editor session (no second OAuth). All call shapes verified live 2026-08.

tool(
  "wix_collections",
  "Read/write the site's CMS (Wix Data) collections, the content documentServices cannot touch. action 'list' returns every collection with its fields; 'query' lists items (optional filter/sort/paging); 'get' one item by id; 'insert' a new item (data = field map); 'update' merges data into an existing item (it fetches current first, so partial fields are safe); 'remove' deletes an item. Items are LIVE data: an item bound to a dynamic page appears on the site at once, no publish needed.",
  {
    action: z.enum(["list", "query", "get", "insert", "update", "remove"]),
    collectionId: z.string().optional().describe("Collection id (from action 'list'). Required for all but 'list'."),
    itemId: z.string().optional().describe("Item _id. Required for get/update/remove."),
    data: z.record(z.any()).optional().describe("Field map for insert/update, e.g. {title:'…', slug:'…'}"),
    filter: z.record(z.any()).optional().describe("Wix Data filter for query, e.g. {pageType:'city'}"),
    sort: z.array(z.any()).optional().describe("Wix Data sort array for query, e.g. [{fieldName:'title',order:'ASC'}]"),
    limit: z.number().optional(),
    offset: z.number().optional(),
  },
  async ({ action, collectionId, itemId, data, filter, sort, limit, offset }) => {
    const ENV = "LIVE";
    if (action === "list") {
      const j = await wixManageApi("get", "cloud-data/v2/collections?paging.offset=0");
      return text(
        (j.collections || []).map((c) => ({
          id: c.id,
          name: c.displayName,
          type: c.collectionType,
          fields: (c.fields || []).map((f) => ({ key: f.key, type: f.type })),
        }))
      );
    }
    if (!collectionId) throw new Error("collectionId is required for action '" + action + "' (get ids from action 'list').");
    if (action === "query") {
      const query = { paging: { limit: limit || 50, offset: offset || 0 } };
      if (filter) query.filter = filter;
      if (sort) query.sort = sort;
      const j = await wixManageApi("post", "cloud-data/v2/items/query", { body: { dataCollectionId: collectionId, query, environment: ENV } });
      return text((j.dataItems || []).map((d) => d.data));
    }
    if (action === "get") {
      if (!itemId) throw new Error("itemId is required for 'get'.");
      const j = await wixManageApi("get", `cloud-data/v2/items/${encodeURIComponent(itemId)}?dataCollectionId=${encodeURIComponent(collectionId)}&environment=${ENV}`);
      return text(j.dataItem ? j.dataItem.data : j);
    }
    if (action === "insert") {
      if (!data) throw new Error("data is required for 'insert'.");
      const j = await wixManageApi("post", "cloud-data/v2/items", { body: { dataCollectionId: collectionId, dataItem: { data }, environment: ENV } });
      return text({ ok: true, item: j.dataItem ? j.dataItem.data : j });
    }
    if (action === "update") {
      if (!itemId || !data) throw new Error("itemId and data are required for 'update'.");
      // Update (PUT) replaces the whole item. Fetch current data and merge so partial
      // field updates do not wipe the rest.
      const cur = await wixManageApi("get", `cloud-data/v2/items/${encodeURIComponent(itemId)}?dataCollectionId=${encodeURIComponent(collectionId)}&environment=${ENV}`);
      const merged = Object.assign({}, cur.dataItem ? cur.dataItem.data : {}, data, { _id: itemId });
      const j = await wixManageApi("put", `cloud-data/v2/items/${encodeURIComponent(itemId)}`, { body: { dataCollectionId: collectionId, dataItem: { data: merged }, environment: ENV } });
      return text({ ok: true, item: j.dataItem ? j.dataItem.data : j });
    }
    if (action === "remove") {
      if (!itemId) throw new Error("itemId is required for 'remove'.");
      await wixManageApi("delete", `cloud-data/v2/items/${encodeURIComponent(itemId)}?dataCollectionId=${encodeURIComponent(collectionId)}&environment=${ENV}`);
      return text({ ok: true, removed: itemId });
    }
  }
);

tool(
  "wix_blog",
  "Read/write Wix Blog posts (also outside documentServices). action 'list' returns published posts (id/title/slug/url); 'get' fetches a post's editable draft by id; 'create' makes a new DRAFT (title required, optional excerpt/richContent); 'update' patches a draft's fields; 'publish' takes a draft live (requires confirm:true, verified live); 'delete' removes both the public post and its draft record. New posts stay private drafts until you publish. richContent is Wix's Ricos JSON; omit it to create a title-only draft you fill in the dashboard.",
  {
    action: z.enum(["list", "get", "create", "update", "publish", "delete"]),
    postId: z.string().optional().describe("Draft/post id. Required for get/update/publish/delete."),
    title: z.string().optional(),
    excerpt: z.string().optional(),
    richContent: z.record(z.any()).optional().describe("Ricos rich-content JSON for the post body"),
    fields: z.record(z.any()).optional().describe("Any other draftPost fields (categoryIds, hashtags, seoData, …)"),
    limit: z.number().optional(),
    confirm: z.boolean().optional().describe("Must be true for action 'publish'"),
  },
  async ({ action, postId, title, excerpt, richContent, fields, limit, confirm }) => {
    const B = "communities-blog-node-api/v3";
    if (action === "list") {
      const j = await wixManageApi("get", `${B}/posts?sort=FEED&paging.limit=${limit || 30}&fieldsets=URL`);
      return text((j.posts || []).map((p) => ({ id: p.id, title: p.title, slug: p.slug, url: p.url ? (p.url.base || "") + (p.url.path || "") : undefined, firstPublished: p.firstPublishedDate })));
    }
    if (action === "get") {
      if (!postId) throw new Error("postId is required for 'get'.");
      const j = await wixManageApi("get", `${B}/draft-posts/${encodeURIComponent(postId)}`);
      return text(j.draftPost || j);
    }
    if (action === "create") {
      if (!title) throw new Error("title is required for 'create'.");
      const draftPost = Object.assign({ title }, excerpt !== undefined ? { excerpt } : {}, richContent ? { richContent } : {}, fields || {});
      const j = await wixManageApi("post", `${B}/draft-posts`, { body: { draftPost } });
      return text({ ok: true, draftId: j.draftPost && j.draftPost.id, title: j.draftPost && j.draftPost.title });
    }
    if (action === "update") {
      if (!postId) throw new Error("postId is required for 'update'.");
      const patch = Object.assign({ id: postId }, title !== undefined ? { title } : {}, excerpt !== undefined ? { excerpt } : {}, richContent ? { richContent } : {}, fields || {});
      const paths = Object.keys(patch).filter((k) => k !== "id");
      if (!paths.length) throw new Error("Nothing to update: pass title, excerpt, richContent, or fields.");
      const j = await wixManageApi("patch", `${B}/draft-posts/${encodeURIComponent(postId)}`, { body: { draftPost: patch, fieldMask: { paths } } });
      return text({ ok: true, draftPost: j.draftPost });
    }
    if (action === "publish") {
      if (!postId) throw new Error("postId is required for 'publish'.");
      if (confirm !== true) return text("Refused: publishing a blog post makes it public. Pass confirm:true to publish.");
      const j = await wixManageApi("post", `${B}/draft-posts/${encodeURIComponent(postId)}/publish`, { body: {} });
      return text({ ok: true, result: j });
    }
    if (action === "delete") {
      if (!postId) throw new Error("postId is required for 'delete'.");
      // A published post keeps a draft record. Deleting only the draft leaves the public
      // post; deleting only the post leaves an orphan draft. Remove both by the same id
      // (post id == draft id). A 404 on either half just means that half was not there.
      const id = encodeURIComponent(postId);
      const notes = [];
      try { await wixManageApi("delete", `${B}/posts/${id}`); } catch (e) { if (!/404/.test(e.message)) notes.push("post: " + e.message); }
      try { await wixManageApi("delete", `${B}/draft-posts/${id}`); } catch (e) { if (!/404/.test(e.message)) notes.push("draft: " + e.message); }
      return text({ ok: true, deleted: postId, notes: notes.length ? notes : undefined });
    }
  }
);

tool(
  "wix_business_info",
  "Read or update the site's business info. No args reads name, description, logo, locale, timezone, currency, and categories. Pass businessName and/or shortDescription to update them (written via the Wix business-settings service and mirrored to site properties; verified live). Logo, currency, locale, and address stay read-only here — set those in the Wix dashboard (Settings → Business Info).",
  {
    businessName: z.string().optional().describe("New business name"),
    shortDescription: z.string().optional().describe("New short business description (the tagline, ≤150 chars)"),
  },
  async ({ businessName, shortDescription }) => {
    if (businessName !== undefined || shortDescription !== undefined) {
      const msid = await inEditor((ds) => ds.generalInfo.getMetaSiteId());
      // The dashboard writes business info here, always with primaryLocationFieldMap.
      // This POST also mirrors the change into site properties (verified live).
      const body = { primaryLocationFieldMap: [] };
      if (businessName !== undefined) body.businessName = businessName;
      if (shortDescription !== undefined) body.shortDescription = shortDescription;
      await wixManageApi("post", `business-settings/v3/${msid}/business-info`, { body });
    }
    const j = await wixManageApi("get", "site-properties-service/v4/properties");
    const p = j.properties || {};
    return text({
      businessName: p.businessName,
      description: p.description,
      siteDisplayName: p.siteDisplayName,
      logo: p.logo,
      locale: p.locale,
      language: p.language,
      timeZone: p.timeZone,
      currency: p.paymentCurrency,
      categories: p.categories,
    });
  }
);

// --- persistence ---------------------------------------------------------------

tool(
  "wix_save",
  "Save the editor DRAFT (equivalent to the editor's Save). Does NOT change the live site. Autosave is usually on, but call this after a batch of changes to be sure.",
  {},
  async () => {
    const result = await inEditor(
      (ds) =>
        new Promise((resolve) => {
          try {
            ds.save(
              () => resolve("SAVED"),
              (e) => resolve("SAVE FAILED: " + JSON.stringify(e).slice(0, 300))
            );
          } catch (e) {
            resolve("THREW: " + e.message);
          }
          setTimeout(() => resolve("TIMEOUT after 60s"), 60_000);
        })
    );
    return text(result);
  }
);

tool(
  "wix_publish",
  "PUBLISH THE SITE. Pushes the current draft LIVE to the public domain (all saved changes, not just yours). Requires confirm:true. Ask the site owner before using unless they have already told you to publish.",
  { confirm: z.boolean().describe("Must be true. Publishing makes the draft public.") },
  async ({ confirm }) => {
    if (confirm !== true) return text("Refused: pass confirm:true to publish. The draft stays unpublished.");
    const result = await inEditor(
      (ds) =>
        new Promise((resolve) => {
          try {
            ds.publish(
              () => resolve("PUBLISHED. Live in ~1-4 min on the CDN"),
              (e) => resolve("PUBLISH FAILED: " + JSON.stringify(e).slice(0, 300))
            );
          } catch (e) {
            resolve("THREW: " + e.message);
          }
          setTimeout(() => resolve("TIMEOUT after 120s. Check the editor window"), 120_000);
        })
    );
    return text(result);
  }
);

// --- escape hatch ----------------------------------------------------------------

tool(
  "wix_eval",
  "EXPERT escape hatch: run raw async JavaScript inside the editor with `ds` (documentServices) and `e2e` (__OdeditorE2EApi__) in scope; the value of the final expression is returned (JSON-serializable only). Use for anything the typed tools do not cover, e.g. ds.pages.serialize(id), ds.components.layout, ds.seo.*, ds.history.undo(). Follow mutations with `await ds.waitForChangesAppliedAsync()`.",
  { js: z.string() },
  async ({ js }) => {
    const result = await inEditor(
      async (ds, e2e, { js }) => {
        const fn = new Function("ds", "e2e", `return (async () => { ${js.includes("return") ? js : "return (" + js + ")"} })()`);
        const v = await fn(ds, e2e);
        try {
          return JSON.parse(JSON.stringify(v === undefined ? "undefined" : v));
        } catch (e) {
          return String(v);
        }
      },
      { js }
    );
    return text(result);
  }
);

// ---------------------------------------------------------------------------
process.on("SIGINT", async () => {
  try {
    if (context) await context.close();
  } catch {}
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `wix-editor-mcp ready (editor: ${editorUrl ? editorUrl.slice(0, 60) + "…" : "unset; set WIX_EDITOR_URL or use wix_open_editor {url}"}, profile: ${PROFILE_DIR}, headless: ${HEADLESS})`
);
