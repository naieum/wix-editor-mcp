# Roadmap

Gap analysis from introspecting the full `documentServices` surface on a live classic-Editor site (2026-08-14). Nothing else — official or community — can do these on classic sites. **Update 2026-08-14: waves 1–5 and 7 shipped in v0.2.0** (36 tools total), every call shape verified live on a scratch page.

## Shipped in v0.2.0

1. ✅ **Images** — `wix_find_images` / `wix_set_image` (Builder.Image nested + classic WPhoto flat shapes).
2. ✅ **Links & buttons** — `wix_find_links` / `wix_set_link` (page/external/phone/email/anchor + labels).
3. ✅ **Header & footer** — `wix_page_structure` / `wix_find_images` / `wix_find_links` accept `pageId: "masterPage"` (content lives in HeaderSection/FooterSection there, not inside SITE_HEADER — see README gotchas).
4. ✅ **Component CRUD** — `wix_copy_component` (serialize + add, cross-page), `wix_delete_component`, `wix_set_layout`.
5. ✅ **Site SEO, redirects, head tags** — `wix_site_seo`, `wix_redirects` (301 manager, live round-trip verified), `wix_head_tags`.
6. ⚠️ **Page export** — `wix_export_page` ships (WML export verified); **import does not**: `importExport.pages.wml.add/replace` return page pointers but never materialize content in the current editor build (three live attempts). Templating = `wix_duplicate_page` + `wix_copy_component`. Re-test import on future editor builds.
7. ✅ **Safety & site** — `wix_undo`/redo, `wix_set_homepage`, `wix_theme` (palette + fonts).

## Still open

- **Media upload glue** — `ds.generalInfo.media.getSiteUploadToken()` exists; wiring an upload→place flow would remove the "uri must already be in the media manager" limitation of `wix_set_image`.
- **Favicon, page background, lightboxes/popups** (`ds.favicon`, `ds.pages.background`, `ds.pages.popupPages`), **mobile re-optimization** (`ds.mobileAlgo.runForPage`), `ds.viewMode` switching — all present in DS, thin wrappers away.
- **Component styles** — `ds.components.style.get/update` + `ds.components.design` for on-brand restyling beyond layout.
- **WML import** — revisit `importExport.pages.wml.add/replace` on newer editor builds; it's the missing half of the templating story.

## Deliberately out of scope

CMS collections, blog, business data, and media *upload* are covered by the official [Wix MCP](https://github.com/wix/wix-mcp) and REST APIs; Velo code by the Wix CLI. This server stays focused on the thing nothing else can touch: the classic Editor canvas. (`ds.tpa.*` app installs, multilingual, branches/revisions are reachable via `wix_eval` for the rare need. Curiosity for spelunkers: Wix's internal AI namespaces `ds.ai.content` / `ds.ai.images` are sitting right there in DS.)
