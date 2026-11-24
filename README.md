# titan-lang.dev

Website, online book, VS Code / LSP documentation, and downloadable Typst PDF for the [Titan programming language](https://github.com/mascarenhas/titan), deployed to Cloudflare Workers Static Assets (`titan-lang`).

## Prerequisites

- **Node.js** `>=22.23.4` (22.23.4+ or 24; required by Astro 7.4) with `npm`
- **Typst** 0.15.1 (`typst` on `PATH` or pointed to via `TYPST_BIN`)
- **Python 3 + `pypdf`** (for `npm run verify:pdf`; override interpreter with `PYTHON_BIN`)

## Local Development & Build

```sh
npm ci
npm run dev       # fetches pinned upstream docs and starts Astro dev server
npm run build     # fetch sources -> Typst PDF monograph -> Astro site -> Pagefind index
npm run verify    # verify all HTML links/fragments/assets/limits + PDF bookmarks/links
```

Output is written to `dist/`, including:
- HTML routes (`/`, `/book/`, `/vscode/`, `/changelog/`, `/404.html`)
- Search index (`dist/pagefind/`)
- Downloadable book PDF (`dist/titan-programming-language.pdf`) — 50 TOC chapters + Style Guide (51 chapters total; 52 source files including Preface)

## Previewing Local Upstream Checkouts

By default `scripts/fetch-sources.mjs` downloads immutable commit-SHA tarballs declared in `sources.json` into gitignored `.generated/cache/`. To preview local checkouts without editing `sources.json`:

```sh
TITAN_LOCAL_DIR=~/Code/titan \
VSCODE_TITAN_LOCAL_DIR=~/Code/vscode-titan \
VSCODE_TITAN_LOCAL_REF=origin/main \
TYPST_BIN=/path/to/typst \
npm run build
```

When `VSCODE_TITAN_LOCAL_DIR` (or `--vscode-dir`) is set, `fetch-sources.mjs` always reads via `git -C <dir> archive <ref>` (defaulting `VSCODE_TITAN_LOCAL_REF` / `--vscode-ref` to `origin/main`) so the local repository's checked-out branch and working tree are never touched.

## Updating Upstream Releases (`sources.json`)

1. Update `ref`, `sha` (40-character commit SHA), and `version` in `sources.json`.
2. Add release highlights to `src/content/site/changelog.md` and update `src/content/site/install.json` if install instructions changed.
3. Run `npm run build && npm run verify`, then open a PR to inspect the automatic Cloudflare preview deployment before merging to `main`.

## Cloudflare Workers Deployment & First-Time Bootstrap

Production deploys to the assets-only Cloudflare Worker `titan-lang` (`wrangler.jsonc` intentionally omits `routes` so dashboard-managed Custom Domains are preserved, and sets `workers_dev: false` with `preview_urls: true`).

- **First-time PR preview bootstrap:** `wrangler versions upload --preview-alias pr-<N>` reads remote `previews_enabled` without mutating it. Before opening the first PR that expects a preview URL, either run one production deploy on `main` (`wrangler deploy`, which applies `preview_urls: true`) or enable **Preview URLs** once in the Cloudflare dashboard (**Workers & Pages → `titan-lang` → Settings → Domains & Routes**).
- **Production branch guard:** `workflow_dispatch` only deploys to production when run on `refs/heads/main`.

## Styling & Reusable `@titan-lang/cassini` Package

Shared documentation engine modules live in the npm workspace package `packages/cassini/` (`@titan-lang/cassini`):

- **Design tokens & theme:** `packages/cassini/src/styles/tokens.css` (Cassini Dark default, Archival Paper `[data-theme="light"]` toggle, 7-token `--brand-*` override contract for sister sites, and self-hosted `@font-face` WOFF2 declarations) and `theme.css` (layouts/components)
- **Self-hosted fonts:** Vendored SIL OFL 1.1 **Source Serif 4**, **IBM Plex Sans**, and **IBM Plex Mono** binaries live in `packages/cassini/src/fonts/web/` (synced into `/fonts/*.woff2` for web) and `packages/cassini/src/fonts/typst/` (passed via `--font-path` + `--ignore-system-fonts` for deterministic Typst PDF embedding with zero system fallbacks). See `packages/cassini/src/fonts/LICENSES.txt`.
- **Print PDF theme & AST emitter:** `packages/cassini/src/pdf/theme.typ` (Cassini Observatory Monograph stylesheet) and `buildBookPdf` / `buildTitanBookPdf` (`@titan-lang/cassini/pdf`), emitting `.generated/pdf-meta.json` so web CTAs display the exact built page count and MiB size dynamically.
- **Shiki 4 Titan grammar loader & themes:** `@titan-lang/cassini/shiki` (`cassini-dark`, `cassini-print`)
- **Markdown link rewriter & build-time Mermaid SVG:** `@titan-lang/cassini/markdown`
- **Navigation, TOC parser, layouts & components:** `@titan-lang/cassini/nav` (`parseBookToc`, `parseTitanBookToc`, `flattenSidebar`, `findPrevNext`), `layouts/*` (`BaseLayout`, `DocsLayout`), and `components/*` (`Header`, `Sidebar`, `OnPageToc`, `PrevNext`, `InstallTabs`, `SearchModal`, `Footer`)

### Reusing `@titan-lang/cassini` in sister sites (e.g. `titan-mk`)

`@titan-lang/cassini` provides the shared rendering, highlighting, Mermaid, TOC parsing (`parseBookToc`), Typst PDF emission (`buildBookPdf`), layouts, components, and CSS/Typst themes. Each site repository still owns its site-specific glue:

- Upstream pin manifest and fetch script (`sources.json`, `scripts/fetch-sources.mjs`)
- Site metadata, content collections, Astro config, and routes (`src/site.config.mjs`, `src/content.config.ts`, `astro.config.mjs`, `src/pages/*`)
- Optional PDF entrypoint (`scripts/build-pdf.mjs`) and site-specific verification checks (`scripts/verify-site.mjs`, `scripts/verify-pdf.py`)
