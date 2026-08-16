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
| `wix_business_info` | Read business info; update name and description |

### Persistence

| Tool | Purpose |
|---|---|
| `wix_save` | Save the draft (no publish) |
| `wix_publish` | Publish LIVE (requires `confirm:true`) |

### Escape hatch

| Tool | Purpose |
|---|---|
| `wix_eval` | Run raw JS with `ds` and `e2e` in scope |

## Workflow: create a new page

1. `wix_duplicate_page` an existing designed page with `title` and `slug`. This auto-adds a nav menu item for the new page, so do not also call `wix_nav_add`.
2. `wix_page_structure {pageId, textOnly:true}` returns text componentIds and current text.
3. `wix_find_galleries {pageId}` returns the Pro Gallery cards that step 2 cannot see.
4. `wix_set_texts` batch-replaces the body copy. `wix_set_gallery` retexts the gallery cards.
5. If the layout lacks a section (e.g. an FAQ), duplicate an existing section via `wix_eval`: `ds.components.duplicate(sectionRef, ds.pages.getReference(pageId))`, then retext it. The clone carries any gallery or child the source had. Remove extras with `ds.components.remove(ref, ()=>{})`.
6. `wix_update_page` sets the SEO title and meta description. It writes to `advancedSeoData`, where Wix actually reads them.
7. `wix_add_schema` adds per-page Service or FAQPage JSON-LD.
8. `wix_save`, then screenshot to review, then `wix_publish {confirm:true}` when the owner says go.
9. Verify the live URL (title tag, content, no stray sections) after ~1-2 min propagation.

## FAQ

Common questions about Wix quirks the tools already handle. The internal details behind them are in [For `wix_eval` and contributors](#for-wix_eval-and-contributors).

### Text and content

<details>
<summary><strong>Why did my text edit silently not apply?</strong></summary>

Newer components (`Builder.RichText`) store text at `data.richText.text`. Classic ones use `data.text`. Partial nested updates are ignored, so the full `richText` object must go back with only `.text` changed. `wix_set_text` handles both shapes. Images have the same trap under `data.image`, and `wix_set_image` handles it too.

</details>

<details>
<summary><strong>Why don't the tools show my Pro Gallery text?</strong></summary>

Pro Gallery (FastGallery) card titles and descriptions live in `component.data.items[]`, not as child text components, so `wix_page_structure` cannot see them. Use `wix_find_galleries` to list the cards and `wix_set_gallery` to edit them.

</details>

<details>
<summary><strong>Why can't I read a page's components?</strong></summary>

They are only readable while the editor is rendering that page. The tools call `ds.pages.navigateTo(pageId)` first. Before that you only see the masterPage header and footer.

</details>

### Pages and sections

<details>
<summary><strong>Do I need to add a nav item after duplicating a page?</strong></summary>

No. Duplicating a page auto-creates a nav menu item, so do not also call `wix_nav_add`.

</details>

<details>
<summary><strong>What happens when I duplicate a section?</strong></summary>

It copies the whole subtree, galleries included. When you clone a section for new content, remove any inherited gallery or child you do not want with `wix_delete_component`.

</details>

<details>
<summary><strong>How do I edit the header or footer?</strong></summary>

Their content is not inside `SITE_HEADER`/`SITE_FOOTER` (those report no children). It lives in sibling `HeaderSection`/`FooterSection` components under `masterPage`. Pass `pageId: "masterPage"` to the structure, image, and link tools.

</details>

<details>
<summary><strong>Can I import or export a page as a file?</strong></summary>

Export yes, via `wix_export_page` (WML JSON). Import no: the WML importers return page pointers but do not materialize content in the current editor build. To copy a page's design, use `wix_duplicate_page` plus `wix_copy_component`.

</details>

### SEO

<details>
<summary><strong>Why does my new page show the wrong SEO title?</strong></summary>

Wix renders the SEO title and description from `advancedSeoData`, not the legacy `pageTitleSEO`/`descriptionSEO` fields. A duplicated page inherits the source page's tags verbatim (title, description, and schema), so it keeps showing the source's title until you rewrite them. `wix_update_page` and `wix_add_schema` do this for you.

</details>

<details>
<summary><strong>How do I fix a page with more than one H1?</strong></summary>

Change the rich-text inline tag (e.g. `<h1>` to `<h2>`). That changes the semantic tag without changing the visible size.

</details>

### Links and menus

<details>
<summary><strong>Why doesn't my button or menu link work?</strong></summary>

They take different id formats. Component links (buttons, images) use bare page ids (`{type:'PageLink', pageId:'abc12'}`). Menu links use `#`-prefixed ids (`{type:'PageLink', pageId:'#abc12'}`).

</details>

<details>
<summary><strong>Why didn't removing a menu item do anything?</strong></summary>

`ds.menu.removeItem` needs both `menuId` and `itemId`. The one-argument form silently does nothing. `wix_nav_remove` passes both.

</details>

### Styling

<details>
<summary><strong>Why did styling one button change all of them?</strong></summary>

Many components share a `GlobalStyle` (every primary button uses `button-primary`, for example), so updating it restyles all of them. To change one component only, fork its style first with `ds.components.style.fork(ref)` via `wix_eval`.

</details>

### Saving and publishing

<details>
<summary><strong>Does saving change the live site?</strong></summary>

No. `wix_save` writes the draft only. The public site changes only when you run `wix_publish`, which requires `confirm:true`.

</details>

<details>
<summary><strong>Are CMS items and new blog posts public right away?</strong></summary>

CMS items are live data with no publish step, so a `wix_collections` insert or update shows on the public site at once (an item bound to a dynamic page appears immediately). Blog `create` and `update` act on a private draft. A post goes public only on `wix_blog {action:'publish', confirm:true}`.

</details>

<details>
<summary><strong>Can I edit the business name or description?</strong></summary>

Yes. `wix_business_info` writes `businessName` and `shortDescription` through the `business-settings/v3` service (the one the dashboard uses; `site-properties/v4` rejects these writes, which is why the field went through a different service). Phone, hours, logo, and address stay read-only here. Set those in the Wix dashboard (Settings → Business Info).

</details>

## For `wix_eval` and contributors

Internal details behind the FAQ, for anyone dropping to `wix_eval` or extending the server.

<details>
<summary><strong>Two API surfaces</strong></summary>

`documentServices` (`ds`) is in a same-origin child frame. `__OdeditorE2EApi__` (`e2e`, which has `addPage`) is on the top window. `wix_eval` exposes both.

</details>

<details>
<summary><strong>Changes are async</strong></summary>

documentServices applies mutations asynchronously, so reads race. Await `ds.waitForChangesAppliedAsync()` after every mutation.

</details>

<details>
<summary><strong>SEO data shape</strong></summary>

`advancedSeoData` is a JSON *string* holding `{tags:[{type:"title",children},{type:"meta",props:{name:"description",content}},{type:"script",...JSON-LD...}]}`. Via `wix_eval`: parse, edit the tags, `JSON.stringify`, then `ds.pages.data.update(id,{advancedSeoData})`.

</details>

<details>
<summary><strong>Duplicating a section</strong></summary>

Needs the container as the second arg: `ds.components.duplicate(sectionRef, pageContainerRef)`.

</details>

<details>
<summary><strong>Data-gateway auth</strong></summary>

Session cookies alone get 401/403 on `manage.wix.com/_api`. Read a signed app instance token from the editor (`ds.tpa.app.getDataByAppDefId(appDefId).instance`), send it as `Authorization`, and add the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`. Any app's instance authorizes the whole gateway.

</details>

<details>
<summary><strong>Media upload</strong></summary>

Takes two steps: `ds.generalInfo.media.getSiteUploadToken()` in the editor, then a token-and-cookie request to `files.wix.com/site/media/files/upload/url`, then a multipart POST to the returned `upload_url`. The response's `file_name` is the media uri image components want. `wix_upload_image` handles it.

</details>

<details>
<summary><strong>301 redirects</strong></summary>

`ds.seo.redirectUrls` supports `update({'/old':'/new'})`, `remove(['/old'])`, `get()`. Exposed as `wix_redirects`.

</details>

<details>
<summary><strong>Page background</strong></summary>

`ds.pages.background.get(pageId)` throws without a device arg (`'desktop'`/`'mobile'`). That arg is mandatory.

</details>

<details>
<summary><strong>Popups are pages</strong></summary>

`ds.pages.popupPages.add(title)` returns a page pointer, popups show up in `getDataList()`, and `ds.pages.remove(popupId)` deletes them.

</details>

## Safety

- Everything is draft-only until `wix_publish`. That tool demands `confirm:true` and should only run with the site owner's go-ahead.
- `wix_delete_page` is irreversible once the draft is saved and published. For same-session mistakes, `ds.history.undo()` is available via `wix_eval`.
- `wix_import_login` reads cookies from **your own local Chrome profile** on your own machine. Nothing leaves your computer.

## Compatibility

Built and verified against the **classic Wix Editor** ("Harmony" / Odeditor) in August 2026. Not for Wix Studio or ADI editors. Their internals differ, though Studio also exposes a documentServices-like surface (PRs welcome). Internal APIs can change without notice. If a tool stops working, use `wix_eval` with the notes above to debug.

## License

MIT
