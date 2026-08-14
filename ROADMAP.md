# Roadmap

Gap analysis from introspecting the full `documentServices` surface on a live classic-Editor site (2026-08-14). The 22 shipped tools cover session/login, page CRUD + per-page SEO + JSON-LD, text read/write, Pro Gallery retexting, nav menus, save/publish, screenshot, and `wix_eval`. Everything below exists in the editor's internal API but has no typed tool yet — and (except where noted) **no other API, official or community, can do these on classic sites**.

## Planned tools, impact-first

1. **Images** — `wix_find_images` / `wix_set_image` via `ds.components.data.update` on image components, plus media-upload glue (`ds.generalInfo.media.getSiteUploadToken()`). The single biggest content gap: today you can retext a duplicated page but not swap its photos.
2. **Links & buttons** — `wix_set_link`: point a button or text link at a page / URL / phone. Link data lives in component data.
3. **Header & footer** — extend `wix_page_structure` with `scope: header|footer|masterPage` via `ds.siteSegments.getHeader()/getFooter()`. Currently header/footer text (phone numbers, footer links) is invisible.
4. **Component CRUD** — `wix_add_component` / `wix_delete_component` / `wix_set_layout` using `ds.components.add / remove / serialize / setContainer / arrangement` and `ds.components.layout.get/update`. `serialize` + `add` = copy any component between pages. Needs a live verification pass for exact call shapes.
5. **Site-level SEO, redirects, head tags** — `ds.seo.title/description/keywords/indexing`, `ds.seo.headTags` (site-wide head HTML: verification tags, analytics), and `ds.seo.redirectUrls.get/update/remove` — a full 301 redirect manager.
6. **Page export/import** — `ds.importExport.pages` / `.components` with `wml`/`eml`/`jsx` formats. Whole-page serialization to markup and back; the killer feature for templating.
7. **Safety & polish** — `wix_undo` (`ds.history.undo/redo/canUndo`), `wix_set_homepage` (`ds.homePage.set`), favicon, theme read (`ds.theme.colors/fonts` — keep generated content on-brand), page background, lightboxes/popups (`ds.pages.popupPages`), mobile re-optimization (`ds.mobileAlgo.runForPage`), `ds.viewMode` switch.

## Deliberately out of scope

CMS collections, blog, business data, and media *upload* are covered by the official [Wix MCP](https://github.com/wix/wix-mcp) and REST APIs; Velo code by the Wix CLI. This server stays focused on the thing nothing else can touch: the classic Editor canvas. (`ds.tpa.*` app installs, multilingual, branches/revisions are reachable via `wix_eval` for the rare need. Curiosity for spelunkers: Wix's internal AI namespaces `ds.ai.content` / `ds.ai.images` are sitting right there in DS.)
