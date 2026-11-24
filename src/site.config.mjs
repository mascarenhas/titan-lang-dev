import fs from "node:fs";
import path from "node:path";
import { parseTitanBookToc } from "@titan-lang/cassini/nav";

const ROOT = process.cwd();
export const SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));

const PDF_META_PATH = path.join(ROOT, ".generated/pdf-meta.json");

export function getPdfMeta() {
  if (fs.existsSync(PDF_META_PATH)) {
    try {
      const meta = JSON.parse(fs.readFileSync(PDF_META_PATH, "utf8"));
      if (meta && Number.isFinite(meta.pages) && meta.pages > 0) {
        return meta;
      }
    } catch {
      // Fall back to null if metadata file is incomplete
    }
  }
  return null;
}

export const PDF_META = getPdfMeta();

export const SITE = {
  brandName: "Titan",
  projectLabel: "Titan Programming Language",
  title: "Titan — A Statically Typed Sister Language to Lua",
  description:
    "Titan is a statically typed, ahead-of-time-compiled sister language to Lua, compiling to native executables, Lua-loadable libraries, and browser WebAssembly.",
  logoSrc: "/assets/titan-logo.svg",
  version: SOURCES.titan.version,
  versionBadge: `v${SOURCES.titan.version}`,
  siteUrl: "https://titan-lang.dev/",
  siteLabel: "titan-lang.dev",
  licenseUrl: `https://github.com/${SOURCES.titan.repo}/blob/master/LICENSE`,
  searchPlaceholder: "Search the Titan book and VS Code docs...",
  githubUrl: `https://github.com/${SOURCES.titan.repo}`,
  vscodeGithubUrl: `https://github.com/${SOURCES.vscodeTitan.repo}`,
  releaseUrl: `https://github.com/${SOURCES.titan.repo}/releases/tag/${SOURCES.titan.ref}`,
  pdfHref: "/titan-programming-language.pdf",
  navLinks: [
    { label: "Book", href: "/book/", matchPrefix: "/book/" },
    { label: "VS Code", href: "/vscode/", matchPrefix: "/vscode/" },
    { label: "Changelog", href: "/changelog/", matchPrefix: "/changelog/" },
  ],
};

export const BOOK_PDF_CTA = {
  label: "Download Book PDF",
  sublabel: PDF_META
    ? `v${SOURCES.titan.version} · ${PDF_META.pages} pp · ${PDF_META.sizeMiB} MiB`
    : `v${SOURCES.titan.version} · Core + Style Guide`,
  href: SITE.pdfHref,
};

export const BOOK_PDF_CHIP = {
  label: PDF_META ? `↓ PDF Edition (${PDF_META.pages} pp)` : "↓ PDF Edition",
  href: SITE.pdfHref,
};

export const VSCODE_SIDEBAR = [
  {
    title: "Overview",
    collapsed: false,
    items: [{ title: "VS Code & Language Server", href: "/vscode/" }],
  },
  {
    title: "User Guides",
    collapsed: false,
    items: [
      { title: "VS Code Extension", href: "/vscode/vscode-extension/" },
      { title: "Standalone Language Server", href: "/vscode/language-server/" },
      { title: "Codex Plugin & Query Client", href: "/vscode/codex/" },
    ],
  },
  {
    title: "Inside vscode-titan Architecture",
    collapsed: false,
    items: [
      { title: "System Architecture & Codebase Map", href: "/vscode/architecture/" },
      { title: "1. Process Architecture & Multi-Root Routing", href: "/vscode/server-data-flow/" },
      { title: "2. Framing, JSON-RPC & Concurrency", href: "/vscode/protocol-and-concurrency/" },
      { title: "3. Crossing Lua & C (Compiler Bridge)", href: "/vscode/compiler-bridge/" },
      { title: "4. Incremental Indexing & SQLite Storage", href: "/vscode/sqlite-backend-storage/" },
      { title: "5. Saved-File Intelligence", href: "/vscode/semantic-features/" },
      { title: "6. Unsaved Buffers & Live Completion", href: "/vscode/completion/" },
    ],
  },
  {
    title: "Engineering Appendices",
    collapsed: false,
    items: [
      { title: "A. Build System, Providers & Packaging", href: "/vscode/native-build/" },
      { title: "B. Executable Line Coverage", href: "/vscode/coverage/" },
      { title: "C. Performance Measurement & Benchmarks", href: "/vscode/benchmarks/" },
    ],
  },
];

let cachedBookToc = null;
export function getBookToc() {
  if (!cachedBookToc) {
    cachedBookToc = parseTitanBookToc({
      langDir: path.join(ROOT, ".generated/sources/titan/doc/language"),
      styleGuidePath: path.join(ROOT, ".generated/sources/titan/doc/style-guide.md"),
      baseUrl: "/book",
    });
  }
  return cachedBookToc;
}
