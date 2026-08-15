# wix-editor-mcp

> An MCP server for the **classic Wix Editor** (Harmony/Odeditor): drive pages, text, images, SEO, navigation, CMS collections, and blog posts from any MCP client.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)
![MCP server](https://img.shields.io/badge/MCP-server-blueviolet.svg)
![Wix classic editor](https://img.shields.io/badge/Wix-classic%20editor-black.svg)

An MCP server that gives an AI agent (or you, via any MCP client) **real tools for the classic Wix Editor**. It covers page creation, duplication, deletion, slug and SEO edits, text replacement, image and link edits, JSON-LD schema, nav menu edits, CMS collections, blog posts, save, and publish.

Wix has **no public API for editing static pages** on classic ("Harmony"/Odeditor) sites. The public REST APIs reach Blog, CMS, and business data, but never the editor canvas. This server drives the editor itself, and folds in that Blog, CMS, and business-data ground too, so one authenticated session covers the whole site. It opens the real Wix Editor in a managed Chrome (Playwright) and calls the editor's internal **`documentServices` API**. Those are the same functions the editor UI calls when you click. No pixel-clicking. Every tool is a direct function call, verified against a live production site (2026-08).

> ⚠️ This drives an **internal, undocumented** Wix API. It can break whenever Wix ships editor changes. Use it at your own risk under Wix's terms of service. Everything is draft-only until you explicitly publish.

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

**Get your editor URL:** open your site in the Wix Editor (My Sites → Edit Site) and copy the address-bar URL. It looks like `https://<site>.editor.wix.com/edit/od/<id>?metaSiteId=<id>`. Set it as `WIX_EDITOR_URL`, or pass it once per session to the `wix_open_editor` tool as `{url}`.

**First run: two ways to authenticate.**

- **Import your existing login (macOS, zero typing).** Run `npm run import-login` (or the `wix_import_login` tool). It decrypts the Wix session cookies from your everyday Chrome profile and injects them into the MCP's isolated profile. The editor then opens already logged in. Approve the one macOS Keychain prompt (`Chrome Safe Storage`). Re-run whenever the session expires. It reads Chrome's `Default` profile. If your Wix login lives in another profile, set `WIX_CHROME_PROFILE` (e.g. `"Profile 1"`). Close the MCP's own Chrome while importing. Requires Node ≥22.5 (uses `node:sqlite`).
- **Manual (all platforms).** Call `wix_open_editor`. A Chrome window opens at the Wix login. Log in once. The session persists in `~/.wix-editor-mcp/profile`.

After either path, every tool works unattended.

> Why import instead of reusing Chrome's profile directly? Chrome locks a profile while it is open, so Playwright cannot launch against your live profile. Copying the cookies into an isolated profile avoids the lock and keeps your everyday browser untouched.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `WIX_EDITOR_URL` | *(unset)* | Which site's editor to open (copy from the address bar after you click Edit Site). Can also be set per session via `wix_open_editor {url}` |
| `WIX_PROFILE_DIR` | `~/.wix-editor-mcp/profile` | Chrome profile that holds the Wix session |
| `WIX_CHROME_PROFILE` | `Default` | Which everyday-Chrome profile `wix_import_login` reads cookies from |
| `WIX_HEADLESS` | off | `1` runs Chrome headless (log in headed first) |
| `WIX_CHROME_CHANNEL` | `chrome` | Playwright browser channel |

## Tools

Grouped by what they touch. Every tool is a direct `documentServices` call (or, for CMS/blog/business data, a Wix data-gateway call driven from the same session).

### Session

| Tool | Purpose |
|---|---|
| `wix_import_login` | macOS: decrypt and inject your Chrome Wix cookies, no manual login |
| `wix_open_editor` | Open the editor and wait until it is scriptable |
| `wix_status` | Report browser, editor, and session state |
| `wix_screenshot` | PNG of the editor window |

### Pages

| Tool | Purpose |
|---|---|
| `wix_list_pages` | List pages: id, title, slug, static/app, hidden, SEO |
| `wix_add_page` | Create a blank static page |
| `wix_duplicate_page` | Duplicate a page with its design (auto-adds a nav item) |
| `wix_delete_page` | Delete a page from the draft |
| `wix_update_page` | Title, slug, SEO title, meta description, hidden, indexable |
| `wix_export_page` | Serialize a whole page to WML (JSON) |

### Page content

| Tool | Purpose |
|---|---|
| `wix_page_structure` | Component tree and text ids for a page (accepts `masterPage`) |
| `wix_get_text` | Read one text component |
| `wix_set_text` | Set one text component's HTML |
| `wix_set_texts` | Batch-set many components in one call |

### Images

| Tool | Purpose |
|---|---|
| `wix_find_images` | List image components: uri, alt, size, link |
| `wix_set_image` | Swap media uri and/or set alt (Builder.Image and classic WPhoto) |
| `wix_upload_image` | Upload a local file or URL to the Media Manager |

### Links & buttons

| Tool | Purpose |
|---|---|
| `wix_find_links` | List buttons and linkable components |
| `wix_set_link` | Set a link (page/external/phone/email/anchor) and/or label |

### Components

| Tool | Purpose |
|---|---|
| `wix_copy_component` | Copy a component subtree across pages |
| `wix_delete_component` | Delete a component and its subtree |
| `wix_set_layout` | Move or resize a component |

### Galleries

| Tool | Purpose |
|---|---|
| `wix_find_galleries` | List Pro Gallery cards that `wix_page_structure` misses |
| `wix_set_gallery` | Retext gallery cards |

### SEO & schema

| Tool | Purpose |
|---|---|
| `wix_add_schema` | Add per-page JSON-LD |
| `wix_site_seo` | Site title, description, indexing |
| `wix_redirects` | 301 redirect manager |
| `wix_head_tags` | Site-wide custom `<head>` HTML |

### Navigation

| Tool | Purpose |
|---|---|
| `wix_nav_menu` | Read the navigation menus |
| `wix_nav_add` | Add a page link to a menu |
| `wix_nav_remove` | Remove a menu item |

### Site & style

| Tool | Purpose |
|---|---|
| `wix_undo` | Undo or redo the last change |
| `wix_set_homepage` | Get or set the homepage |
| `wix_theme` | Read the palette and fonts (keep content on-brand) |
| `wix_favicon` | Get or set the favicon |
| `wix_page_background` | Get or set a page background |
| `wix_popups` | Lightboxes: list/add/open/close |
| `wix_mobile_optimize` | Re-run mobile layout after heavy edits |
| `wix_component_style` | Raw style read/write (mind GlobalStyles) |

### CMS, blog & business info

Same content as the official Wix REST APIs, driven from this server's own editor session (no second login).

| Tool | Purpose |
|---|---|
| `wix_collections` | Wix Data CMS: list/query/get/insert/update/remove items |
| `wix_blog` | Blog posts: list/get/create/update/publish/delete |
| `wix_business_info` | Read business name, hours, locale (read-only) |

### Persistence

| Tool | Purpose |
|---|---|
| `wix_save` | Save the draft (no publish) |
| `wix_publish` | Publish LIVE (requires `confirm:true`) |

### Escape hatch

| Tool | Purpose |
|---|---|
| `wix_eval` | Run raw JS with `ds` and `e2e` in scope |

## The workflow for a new page (proven in production)

1. `wix_duplicate_page` an existing designed page with `title` and `slug`. This auto-adds a nav menu item for the new page, so do not also call `wix_nav_add`.
2. `wix_page_structure {pageId, textOnly:true}` returns text componentIds and current text.
3. `wix_find_galleries {pageId}` returns the Pro Gallery cards that step 2 cannot see.
4. `wix_set_texts` batch-replaces the body copy. `wix_set_gallery` retexts the gallery cards.
5. If the layout lacks a section (e.g. an FAQ), duplicate an existing section via `wix_eval`: `ds.components.duplicate(sectionRef, ds.pages.getReference(pageId))`, then retext it. The clone carries any gallery or child the source had. Remove extras with `ds.components.remove(ref, ()=>{})`.
6. `wix_update_page` sets the SEO title and meta description. It writes to `advancedSeoData`, where Wix actually reads them.
7. `wix_add_schema` adds per-page Service or FAQPage JSON-LD.
8. `wix_save`, then screenshot to review, then `wix_publish {confirm:true}` when the owner says go.
9. Verify the live URL (title tag, content, no stray sections) after ~1-2 min propagation.

## Hard-won gotchas (encoded in the tools, listed for `wix_eval` users)

- `documentServices` lives in a **same-origin child frame**, not the top window. `__OdeditorE2EApi__` (which has `addPage`) is on the top window.
- **Await `ds.waitForChangesAppliedAsync()` after every mutation.** DS applies changes async, so reads race otherwise.
- A page's components are only readable while the editor is **rendering that page**. Call `ds.pages.navigateTo(pageId)` first. Otherwise you only see masterPage header/footer components.
- Text on newer components lives at `data.richText.text` (`Builder.RichText`). Classic components use `data.text`. **Partial nested updates are silently ignored.** Send the full `richText` object back with only `.text` changed.
- `ds.menu.removeItem(menuId, itemId)` needs **both args**. The 1-arg form silently no-ops. In the same family, `ds.mainMenu.addLinkItem` creates an orphaned dataItem that never attaches. Use `ds.menu.addItem('CUSTOM_MAIN_MENU', {...})`.
- `ds.save(onSuccess, onError)` is callback-style and saves the **draft**. The live site changes only on `ds.publish`.
- **SEO title/description are rendered from `advancedSeoData`, NOT the legacy `pageTitleSEO`/`descriptionSEO` fields.** `advancedSeoData` is a JSON *string* that holds `{tags:[{type:"title",children},{type:"meta",props:{name:"description",content}},{type:"script",...JSON-LD...}]}`. A **duplicated page inherits the source page's tags verbatim** (title, description, AND schema). The new page silently shows the source page's title until you rewrite these tags. `wix_update_page` and `wix_add_schema` handle this for you. Via `wix_eval`: parse, edit the tags, `JSON.stringify`, then `ds.pages.data.update(id,{advancedSeoData})`.
- **Pro Gallery (FastGallery) cards are invisible to component traversal.** Their titles and descriptions live in `component.data.items[]`, not as child text comps. `wix_page_structure` misses them. Use `wix_find_galleries` / `wix_set_gallery`.
- **A duplicated page auto-creates a nav menu item** for itself, so skip `wix_nav_add` after a duplicate.
- **A duplicated section** copies its whole subtree, galleries included. `ds.components.duplicate(sectionRef, pageContainerRef)` needs the container as the 2nd arg. After you clone a section for new content, remove any inherited gallery or child you do not want.
- A change to a WRichText's inline tag (e.g. `<h1>` to `<h2>`) **changes the semantic tag without shrinking the display styling**. This is a safe way to fix multiple-H1 pages.
- **Header/footer content does NOT live inside `SITE_HEADER`/`SITE_FOOTER`** (those containers report no children). It lives in sibling `HeaderSection`/`FooterSection` components under `masterPage`. `masterPage` is itself walkable via `ds.pages.getReference('masterPage')` from any page. The structure, image, and link tools accept `pageId: "masterPage"` for this.
- Newer image components nest their media under **`data.image` (`Builder.Image`)**. Classic `WPhoto` keeps it flat on `data`. Same partial-update trap as richText: send the **full nested `image` object** back with only the changed fields replaced. `wix_set_image` handles both.
- Component links (buttons, images) take **bare page ids** (`{type:'PageLink', pageId:'abc12'}`). Menu links take **`#`-prefixed ids** (`{type:'PageLink', pageId:'#abc12'}`). Yes, really.
- `ds.importExport.pages.wml.export(pageRef)` works (note: it takes a page *reference*, not an id) and returns `{structure, data, style, version}`. But the matching **`add`/`replace` importers return page pointers without ever materializing content** in the current editor build (three live attempts). Export ships as `wix_export_page`. For templating, use `wix_duplicate_page` plus `wix_copy_component`.
- `ds.seo.redirectUrls` is a working 301 redirect manager: `update({'/old':'/new'})`, `remove(['/old'])`, `get()`. Verified with a live round-trip.
- **Media upload** takes two steps. Call `ds.generalInfo.media.getSiteUploadToken()` in the editor. Then `GET files.wix.com/site/media/files/upload/url?media_type=picture&site_token=…` **with the browser session's cookies** (401 without them, so the server reuses Playwright's cookie jar). Then multipart-POST the file to the returned `upload_url`. The response's `file_name` is the media uri that image components want.
- **Many components share a `GlobalStyle`** (e.g. every primary button uses style id `button-primary`). `ds.components.style.update` on one restyles them ALL. Fork first (`ds.components.style.fork(ref)`) to restyle a single component.
- `ds.pages.background.get(pageId)` throws `unknown device for background`. The device arg (`'desktop'`/`'mobile'`) is mandatory.
- Popups/lightboxes are pages. `ds.pages.popupPages.add(title)` returns a page pointer, they show up in `getDataList()`, and `ds.pages.remove(popupId)` deletes them.
- **CMS/Blog/business data live behind `manage.wix.com/_api`, not documentServices.** Session cookies alone return 401/403 there. The fix (verified): read a signed app instance token from the editor (`ds.tpa.app.getDataByAppDefId(appDefId).instance`) and send it as `Authorization`, plus the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`. Any app's instance authorizes the whole data gateway. `wix_collections`, `wix_blog`, and `wix_business_info` do this for you.
- **CMS items are LIVE data, no publish step.** `cloud-data/v2` writes (`wix_collections` insert/update) take effect at once. An item bound to a dynamic page shows on the public site immediately, unlike editor draft changes.
- **Blog `update`/`create` act on the DRAFT.** New posts stay private until `wix_blog {action:'publish', confirm:true}`. The `site-properties/v4` write endpoint rejects every payload shape tried, so `wix_business_info` is read-only. Set business fields in the Wix dashboard.

## Safety

- Everything is draft-only until `wix_publish`. That tool demands `confirm:true` and should only run with the site owner's go-ahead.
- `wix_delete_page` is irreversible once the draft is saved and published. For same-session mistakes, `ds.history.undo()` is available via `wix_eval`.
- `wix_import_login` reads cookies from **your own local Chrome profile** on your own machine. Nothing leaves your computer.

## Compatibility

Built and verified against the **classic Wix Editor** ("Harmony" / Odeditor) in August 2026. Not for Wix Studio or ADI editors. Their internals differ, though Studio also exposes a documentServices-like surface (PRs welcome). Internal APIs can change without notice. If a tool stops working, `wix_eval` plus the gotchas above are your debugging kit.

## License

MIT
