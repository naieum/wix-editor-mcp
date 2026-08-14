#!/usr/bin/env node
/**
 * wix-editor-mcp — MCP server that drives the Wix classic ("Harmony"/Odeditor) Editor
 * through its internal documentServices API, reached via Playwright + a real Chrome.
 *
 * Why this exists: classic Wix Editor sites have NO public API for creating/editing
 * static pages (the Blog/CMS REST APIs can't touch them). But the editor page itself
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// The editor URL for your site: open the Wix Editor in a browser, copy the address-bar
// URL (looks like https://<site>.editor.wix.com/edit/od/<id>?metaSiteId=<id>), and set
// WIX_EDITOR_URL — or pass {url} to the wix_open_editor tool, which remembers it for
// the session.
let editorUrl = process.env.WIX_EDITOR_URL || "";
const PROFILE_DIR =
  process.env.WIX_PROFILE_DIR || path.join(os.homedir(), ".wix-editor-mcp", "profile");
const HEADLESS = process.env.WIX_HEADLESS === "1";
const CHROME_CHANNEL = process.env.WIX_CHROME_CHANNEL || "chrome";

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
 * (first run with a fresh profile — the user logs in once in the headed window).
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
      ? `Wix wants a login (currently at ${url}). A Chrome window is open — log in there once (the session persists in ${PROFILE_DIR}), then call this tool again. Or run wix_open_editor which waits up to 4 minutes for you.`
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
        throw new Error("documentServices not found — editor not fully loaded");
      };
      const fn = new Function(`return (${fnSrc})`)();
      return fn(getDs(), window.__OdeditorE2EApi__, arg);
    },
    { fnSrc: fn.toString(), arg }
  );
}

// Small helpers reused inside page-context functions are inlined there because
// evaluate() serializes each function — nothing from this module scope survives.

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });
const errText = (e) => ({ content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true });

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "wix-editor", version: "0.1.0" });

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
    if (!editorUrl) return text(`Imported ${cookies.length} Wix cookies. No editor URL configured yet — call wix_open_editor with {url} (or set WIX_EDITOR_URL) to open the editor.`);
    // Load the editor with the freshly injected session.
    await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const ok = await waitForDs(90_000);
    if (!ok) throw new Error(`Injected ${cookies.length} cookies but editor still isn't scriptable (at ${page.url()}). Session may be expired — log in to Wix once in that Chrome profile, then re-run.`);
    const pages = await inEditor((ds) => ds.pages.getPagesData().map((p) => p.title));
    return text(`Imported ${cookies.length} Wix cookies and opened the editor logged in. Pages: ${pages.join(", ")}`);
  }
);

tool(
  "wix_open_editor",
  "Open (or re-open) the Wix Editor in the managed Chrome window and wait for it to be scriptable. First run on a fresh profile shows the Wix login — log in once in that window; this tool waits up to 4 minutes. Optional url sets/overrides the editor URL for the whole session (grab it from the address bar of the Wix Editor: https://<site>.editor.wix.com/edit/od/…?metaSiteId=…).",
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
  "Duplicate an existing page (keeps its sections/design — the practical way to make consistent new pages), then optionally retitle/re-slug it. Returns the new pageId. Use wix_page_structure + wix_set_texts afterwards to replace the copy.",
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
  "Delete a page from the draft. Irreversible after save+publish — double-check the pageId against wix_list_pages first.",
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
  "Add a JSON-LD structured-data block (schema.org) to a page — appended to advancedSeoData as a <script type=\"application/ld+json\"> tag, the same place Wix's SEO panel stores 'Structured data markup'. Pass the schema as a JSON object. displayName labels it in the Wix SEO UI. Ideal for per-page Service + FAQPage schema on city/service pages.",
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
  "Retext a Pro Gallery (FastGallery) — the numbered image cards whose title/description live in the component's data.items, NOT as child text components (so wix_page_structure can't see them). Find galleryId via wix_find_galleries. Provide items in order; each {title, description} updates the matching card, preserving its image.",
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
  "List every Pro Gallery (FastGallery) on a page with its galleryId and current card titles — so you can spot galleries that wix_page_structure misses and feed their ids to wix_set_gallery.",
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
  "Navigate the editor to a page and return its component tree: componentId, type, and current text for every text element. This is how you find the componentIds to pass to wix_set_text. (The editor must render a page before its components are readable — this tool handles that.)",
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
  "Batch version of wix_set_text: replace the text of many components on one page in a single call — the efficient way to retext a duplicated page. Each edit: {componentId, html}.",
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
  "Remove an item from a navigation menu. NOTE: requires BOTH menuId and itemId — verified that the 1-arg form silently does nothing.",
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

tool(
  "wix_set_image",
  "Update an image component: swap the media (uri + width/height of the new media file) and/or set alt text. The uri must be a Wix media-manager uri (e.g. 'abc123_….jpg~mv2' — copy one from wix_find_images on a page already using the image, or upload via the Wix dashboard/official MCP first). Handles both Builder.Image (nested) and classic WPhoto (flat) data shapes.",
  {
    componentId: z.string(),
    pageId: z.string().optional(),
    uri: z.string().optional().describe("Wix media uri; when swapping media also pass the new file's width+height"),
    alt: z.string().optional(),
    title: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  },
  async ({ componentId, pageId, ...fields }) => {
    const result = await inEditor(
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
        // GOTCHA (verified): partial nested updates are silently ignored — send the
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
    return text(result);
  }
);

tool(
  "wix_find_links",
  "List every linkable component on a page (or 'masterPage'): buttons and any component carrying a link — componentId, label, and current link (page/url/anchor/phone/email). Feed componentIds to wix_set_link.",
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
        if (!Object.keys(patch).length) return { ok: false, error: "nothing to change — pass label and/or link" };
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
  "Copy any component (with its full subtree, data, and style) from one page to another — serialize + add, verified live. Lands in toContainerId (a section/container id from wix_page_structure), or the target page's first Section if omitted. Optional x/y repositions it after the copy.",
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
          if (!containerRef) return { ok: false, error: "no section/container found on target page — pass toContainerId" };
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
  "Get or set the site-wide custom <head> HTML (verification meta tags, analytics snippets — same field as the dashboard's Custom Code head section). Pass html to REPLACE the whole block (read first, then append to preserve existing tags). No args reads.",
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
  "Serialize a whole page — structure, data, and styles — to a WML object (JSON), for backup, inspection, or diffing. NOTE: the matching import APIs (importExport.pages.wml.add/replace) return page pointers but do not materialize content in the current editor build (verified 2026-08) — to template a page, use wix_duplicate_page + wix_copy_component instead.",
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
// never materialize content in the current editor build — verified with three live
// attempts, 2026-08. Templating = wix_duplicate_page + wix_copy_component instead.)

// --- site & safety --------------------------------------------------------------

tool(
  "wix_undo",
  "Undo (or redo with redo:true) the last editor change in this session — the safety net after a bad component edit or delete.",
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
  "Read the site's theme palette (color_0…) and font styles (font_0…) — so generated/inserted content can stay on-brand.",
  {},
  async () => {
    const result = await inEditor((ds) => ({
      colors: ds.theme.colors.getAll(),
      fonts: ds.theme.fonts.getAll(),
    }));
    return text(result);
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
  "PUBLISH THE SITE — pushes the current draft LIVE to the public domain (all saved changes, not just yours). Requires confirm:true. Ask the site owner before using unless they've already told you to publish.",
  { confirm: z.boolean().describe("Must be true. Publishing makes the draft public.") },
  async ({ confirm }) => {
    if (confirm !== true) return text("Refused: pass confirm:true to publish. The draft stays unpublished.");
    const result = await inEditor(
      (ds) =>
        new Promise((resolve) => {
          try {
            ds.publish(
              () => resolve("PUBLISHED — live in ~1-4 min on the CDN"),
              (e) => resolve("PUBLISH FAILED: " + JSON.stringify(e).slice(0, 300))
            );
          } catch (e) {
            resolve("THREW: " + e.message);
          }
          setTimeout(() => resolve("TIMEOUT after 120s — check the editor window"), 120_000);
        })
    );
    return text(result);
  }
);

// --- escape hatch ----------------------------------------------------------------

tool(
  "wix_eval",
  "EXPERT escape hatch: run raw async JavaScript inside the editor with `ds` (documentServices) and `e2e` (__OdeditorE2EApi__) in scope; the value of the final expression is returned (JSON-serializable only). Use for anything the typed tools don't cover — e.g. ds.pages.serialize(id), ds.components.layout, ds.seo.*, ds.history.undo(). Mutations should be followed by `await ds.waitForChangesAppliedAsync()`.",
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
  `wix-editor-mcp ready (editor: ${editorUrl ? editorUrl.slice(0, 60) + "…" : "unset — set WIX_EDITOR_URL or use wix_open_editor {url}"}, profile: ${PROFILE_DIR}, headless: ${HEADLESS})`
);
