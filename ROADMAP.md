# Roadmap

Gap analysis from introspecting the full `documentServices` surface on a live classic-Editor site (2026-08-14). Nothing else, official or community, can do these on classic sites. **Update 2026-08-14: waves 1-5 and 7 shipped in v0.2.0** (36 tools total). We verified every call shape live on a scratch page.

## Shipped in v0.2.0

1. ✅ **Images:** `wix_find_images` / `wix_set_image` (Builder.Image nested and classic WPhoto flat shapes).
2. ✅ **Links & buttons:** `wix_find_links` / `wix_set_link` (page/external/phone/email/anchor plus labels).
3. ✅ **Header & footer:** `wix_page_structure` / `wix_find_images` / `wix_find_links` accept `pageId: "masterPage"`. Content lives in HeaderSection/FooterSection there, not inside SITE_HEADER (see README gotchas).
4. ✅ **Component CRUD:** `wix_copy_component` (serialize and add, cross-page), `wix_delete_component`, `wix_set_layout`.
5. ✅ **Site SEO, redirects, head tags:** `wix_site_seo`, `wix_redirects` (301 manager, live round-trip verified), `wix_head_tags`.
6. ⚠️ **Page export:** `wix_export_page` ships (WML export verified). **Import does not:** `importExport.pages.wml.add/replace` return page pointers but never materialize content in the current editor build (three live attempts). For templating, use `wix_duplicate_page` plus `wix_copy_component`. Re-test import on future editor builds.
7. ✅ **Safety & site:** `wix_undo`/redo, `wix_set_homepage`, `wix_theme` (palette and fonts).

## Shipped in v0.3.0

- ✅ **Media upload:** `wix_upload_image` sends a local file or URL to the Media Manager via the token and cookie-jar flow. It can also place the image on a component in one step. Verified with a live upload.
- ✅ **Favicon** (`wix_favicon`) and **page background** (`wix_page_background`, device arg mandatory). **Lightboxes/popups** (`wix_popups`: list/add/open/close, delete via `wix_delete_page`). **Mobile re-optimization** (`wix_mobile_optimize`).
- ✅ **Component styles:** `wix_component_style` raw read/write, with the GlobalStyle shared-style warning (fork via `wix_eval` to restyle one component).

## Shipped in v0.4.0

The `manage.wix.com/_api` data gateway (the ground the official Wix REST APIs cover), driven from this server's own editor session. All call shapes verified live 2026-08 (temp collection and blog draft round-trips).

- ✅ **CMS (Wix Data):** `wix_collections` list/query/get/insert/update/remove items in any collection. Update merges against current data, so partial field writes are safe.
- ✅ **Blog:** `wix_blog` list published posts, get/create/update/delete drafts, publish (confirm-gated).
- ✅ **Business info:** `wix_business_info` reads the real business name, description, locale, timezone, and currency. Read-only: the site-properties write endpoint rejects every payload shape tried.
- Auth: a signed app instance token from the editor plus the XSRF cookie authorizes the whole gateway (see README gotchas). No second OAuth flow.

## Still open

- **Business-info write:** the `site-properties/v4` PATCH rejects every payload shape tried (2026-08). Crack the shape (capture a real dashboard save) to make `wix_business_info` read/write.
- **Blog publish:** `wix_blog {action:'publish'}` uses the standard `draft-posts/{id}/publish` call but is the one path not round-trip-verified live (to avoid a test post flashing on the public feed). Confirm on first real use.
- **WML import:** re-tested 2026-08-15 and still broken. `importExport.pages.wml.add(wml)` returns a page pointer, but the new page has 0 components (content never materializes). Blocked by the Wix build, not our code. Retry on future builds; it is the missing half of the templating story.
- **View mode / mobile editing:** re-tested 2026-08-15. `ds.viewMode` exposes `get`/`set`/`VIEW_MODES` (DESKTOP, MOBILE), but `ds.viewMode.set('MOBILE')` is a silent no-op (the mode stays DESKTOP), and `ds.mobile` is undefined (no `hiddenComponents` API on this build). No working path to mobile-specific editing here yet.
- Wix Studio support: Studio exposes a documentServices-like surface, untested here (Cornerstone is a classic-editor site, so there is no Studio site to verify against). PRs welcome.

## Deliberately out of scope

Velo/Wix Code source files stay with the Wix CLI (a different toolchain with local file sync). Everything else the site needs (editor canvas, CMS, blog, business data, media) this server now covers from one session.

`ds.tpa.*` app installs, multilingual, and branches/revisions are reachable via `wix_eval` for the rare need. Curiosity for spelunkers: Wix's internal AI namespaces `ds.ai.content` / `ds.ai.images` sit right there in DS.
