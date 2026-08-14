# wix-editor-mcp

An MCP server that gives an AI agent (or you, via any MCP client) **real tools for the Wix classic Editor** — page creation, duplication, deletion, slug/SEO edits, text replacement, JSON-LD schema, nav menu edits, save, and publish.

Wix offers **no public API for any of this** on classic ("Harmony"/Odeditor) sites: the REST APIs can touch Blog/CMS/etc. but cannot create or edit static pages. This server works around that by driving the editor itself: it opens the real Wix Editor in a managed Chrome (Playwright) and calls the editor's **internal `documentServices` API** — the same functions the editor UI calls when you click. No pixel-clicking; every tool is a direct function call, verified against a live production site (2026-08).

> ⚠️ This drives an **internal, undocumented** Wix API. It can break whenever Wix ships editor changes, and using it is at your own risk under Wix's terms of service. Everything is draft-only until you explicitly publish.

## Setup

```bash
npm install
```

Register it with your MCP client, e.g. in a `.mcp.json`:

```json
{
  "mcpServers": {
    "wix-editor": {
      "command": "node",
      "args": ["/path/to/wix-editor-mcp/server.js"],
      "env": { "WIX_EDITOR_URL": "https://<your-site>.editor.wix.com/edit/od/…?metaSiteId=…" }
    }
  }
}
```

**Getting your editor URL:** open your site in the Wix Editor (My Sites → Edit Site) and copy the address-bar URL. It looks like `https://<site>.editor.wix.com/edit/od/<id>?metaSiteId=<id>`. Either set it as `WIX_EDITOR_URL` or pass it once per session to the `wix_open_editor` tool as `{url}`.

**First run — two ways to authenticate:**

- **Import your existing login (macOS, zero typing):** `npm run import-login` (or the `wix_import_login` tool). This decrypts the Wix session cookies from your everyday Chrome profile and injects them into the MCP's isolated profile, so the editor opens already logged in. It triggers one macOS Keychain prompt (`Chrome Safe Storage`) — approve it. Re-run whenever the session expires. Defaults to Chrome's `Default` profile; if your Wix login lives in another profile, set `WIX_CHROME_PROFILE` (e.g. `"Profile 1"`). The MCP's own Chrome must be closed while importing. Requires Node ≥22.5 (uses `node:sqlite`).
- **Manual (all platforms):** call `wix_open_editor`. A Chrome window opens at the Wix login — log in once (the session persists in `~/.wix-editor-mcp/profile`).

Either way, from then on every tool works unattended.

> Why import instead of just reusing Chrome's profile directly? Chrome locks a profile while it's open, so Playwright can't launch against your live profile. Copying the cookies into an isolated profile sidesteps the lock and keeps your everyday browser untouched.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `WIX_EDITOR_URL` | *(unset)* | Which site's editor to open (copy from the address bar after clicking Edit Site); can also be set per-session via `wix_open_editor {url}` |
| `WIX_PROFILE_DIR` | `~/.wix-editor-mcp/profile` | Chrome profile holding the Wix session |
| `WIX_CHROME_PROFILE` | `Default` | Which everyday-Chrome profile `wix_import_login` reads cookies from |
| `WIX_HEADLESS` | off | `1` runs Chrome headless (log in headed first) |
| `WIX_CHROME_CHANNEL` | `chrome` | Playwright browser channel |

## Tools

**Session:** `wix_import_login` (decrypt+inject your Chrome Wix cookies — no manual login; macOS), `wix_open_editor`, `wix_status`, `wix_screenshot`
**Pages:** `wix_list_pages`, `wix_add_page`, `wix_duplicate_page`, `wix_delete_page`, `wix_update_page` (title / slug / SEO title / meta description / hidden / indexable)
**Content:** `wix_page_structure` (find componentIds + current text), `wix_get_text`, `wix_set_text`, `wix_set_texts` (batch)
**Galleries:** `wix_find_galleries` (list Pro Gallery cards `wix_page_structure` can't see), `wix_set_gallery` (retext gallery cards)
**SEO/schema:** `wix_add_schema` (append JSON-LD structured data to a page)
**Navigation:** `wix_nav_menu`, `wix_nav_add`, `wix_nav_remove`
**Persistence:** `wix_save` (draft only), `wix_publish` (LIVE — requires `confirm:true`)
**Escape hatch:** `wix_eval` (raw JS with `ds` + `e2e` in scope)

## The workflow for a new page (proven in production)

1. `wix_duplicate_page` an existing designed page with `title` + `slug`. **This auto-adds a nav menu item** for the new page — don't also call `wix_nav_add` or you'll get a duplicate.
2. `wix_page_structure {pageId, textOnly:true}` → text componentIds + current text
3. `wix_find_galleries {pageId}` → the Pro Gallery cards that step 2 can't see
4. `wix_set_texts` — batch-replace the body copy; `wix_set_gallery` — retext the gallery cards
5. Need a section the layout lacks (e.g. an FAQ)? **Duplicate an existing section** via `wix_eval`: `ds.components.duplicate(sectionRef, ds.pages.getReference(pageId))`, then retext it. **Watch out:** the clone carries any gallery/child the source had — remove extras with `ds.components.remove(ref, ()=>{})`.
6. `wix_update_page` — SEO title + meta description (writes to `advancedSeoData`, where Wix actually reads them)
7. `wix_add_schema` — per-page Service / FAQPage JSON-LD
8. `wix_save` → screenshot to review → `wix_publish {confirm:true}` when the owner says go
9. Verify the live URL (title tag, content, no stray sections) after ~1–2 min propagation.

## Hard-won gotchas (encoded in the tools, listed for `wix_eval` users)

- `documentServices` lives in a **same-origin child frame**, not the top window; `__OdeditorE2EApi__` (which has `addPage`) is on the top window.
- **Await `ds.waitForChangesAppliedAsync()` after every mutation** — DS applies changes async; reads race otherwise.
- A page's components are only readable when the editor is **rendering that page** — `ds.pages.navigateTo(pageId)` first (otherwise you only see masterPage header/footer components).
- Text on newer components lives at `data.richText.text` (`Builder.RichText`); classic components use `data.text`. **Partial nested updates are silently ignored** — send the full `richText` object back with only `.text` changed.
- `ds.menu.removeItem(menuId, itemId)` needs **both args**; the 1-arg form silently no-ops. Same family: `ds.mainMenu.addLinkItem` creates an orphaned dataItem that never attaches — use `ds.menu.addItem('CUSTOM_MAIN_MENU', {...})`.
- `ds.save(onSuccess, onError)` is callback-style and saves the **draft**; the live site changes only on `ds.publish`.
- **SEO title/description are rendered from `advancedSeoData`, NOT the legacy `pageTitleSEO`/`descriptionSEO` fields.** `advancedSeoData` is a JSON *string* holding `{tags:[{type:"title",children},{type:"meta",props:{name:"description",content}},{type:"script",...JSON-LD...}]}`. A **duplicated page inherits the source page's tags verbatim** (title, description, AND schema) — so a new page silently shows the source page's title until you rewrite these tags. `wix_update_page` and `wix_add_schema` handle this for you; via `wix_eval`, parse → edit tags → `JSON.stringify` → `ds.pages.data.update(id,{advancedSeoData})`.
- **Pro Gallery (FastGallery) cards are invisible to component traversal** — their titles/descriptions live in `component.data.items[]`, not as child text comps. `wix_page_structure` misses them; use `wix_find_galleries` / `wix_set_gallery`.
- **Duplicating a page auto-creates a nav menu item** for it (so skip `wix_nav_add` after a duplicate).
- **Duplicating a section** (`ds.components.duplicate(sectionRef, pageContainerRef)` — needs the container as 2nd arg) copies its whole subtree, including galleries. When cloning a section for new content, remove any inherited gallery/child you don't want.
- Changing a WRichText's inline tag (e.g. `<h1>`→`<h2>`) **changes the semantic tag without shrinking the display styling** — a safe way to fix multiple-H1 pages.

## Safety

- Everything is draft-only until `wix_publish`, which demands `confirm:true` and should only run with the site owner's go-ahead.
- `wix_delete_page` is irreversible once the draft is saved and published; `ds.history.undo()` exists via `wix_eval` for same-session mistakes.
- `wix_import_login` reads cookies from **your own local Chrome profile** on your own machine; nothing leaves your computer.

## Compatibility

Built and verified against the **classic Wix Editor** ("Harmony" / Odeditor) in August 2026. Not for Wix Studio or ADI editors (their internals differ, though Studio also exposes a documentServices-like surface — PRs welcome). Internal APIs can change without notice; if a tool stops working, `wix_eval` + the gotchas above are your debugging kit.

## License

MIT
