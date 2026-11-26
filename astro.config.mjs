import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { createRemarkCassiniDocs, rehypeCassiniTables } from "@titan-lang/cassini/markdown";
import { cassiniDarkTheme, cassiniPrintTheme, loadTitanLanguage } from "@titan-lang/cassini/shiki";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));
const grammarPath = path.join(ROOT, ".generated/sources/vscode-titan/syntaxes/titan.tmLanguage.json");

const titanLang = loadTitanLanguage(grammarPath);

const remarkCassiniDocs = createRemarkCassiniDocs({
  sections: [
    {
      matchPath: "/.generated/sources/titan/",
      repoUrl: `https://github.com/${sources.titan.repo}`,
      ref: sources.titan.sha,
      resolveInternal(repoRel, frag) {
        if (repoRel === "doc/style-guide.md") {
          return `/book/style-guide/${frag}`;
        }
        if (repoRel.startsWith("doc/language/") && repoRel.endsWith(".md")) {
          const rel = repoRel.slice("doc/language/".length).replace(/\.md$/, "");
          return rel === "index" ? `/book/${frag}` : `/book/${rel}/${frag}`;
        }
        return null;
      },
      resolveAsset(repoRel) {
        if (repoRel === "doc/images/titan-logo.svg") {
          return "/assets/titan-logo.svg";
        }
        return null;
      },
    },
    {
      matchPath: "/.generated/sources/vscode-titan/",
      repoUrl: `https://github.com/${sources.vscodeTitan.repo}`,
      ref: sources.vscodeTitan.sha,
      resolveInternal(repoRel, frag) {
        if (repoRel === "README.md") {
          return `/vscode/${frag}`;
        }
        if (repoRel === "docs/index.md") {
          return `/vscode/architecture/${frag}`;
        }
        if (repoRel.startsWith("docs/") && repoRel.endsWith(".md")) {
          const name = repoRel.slice("docs/".length).replace(/\.md$/, "");
          return `/vscode/${name}/${frag}`;
        }
        return null;
      },
      rewriteExternal(url) {
        const m = url.match(
          /^https:\/\/github\.com\/mascarenhas\/titan\/blob\/[^/]+\/doc\/language\/(.+?)\.md(#.*)?$/i,
        );
        if (!m) return null;
        const rel = m[1];
        const frag = m[2] || "";
        return rel === "index" ? `/book/${frag}` : `/book/${rel}/${frag}`;
      },
    },
  ],
});

export default defineConfig({
  site: "https://titan-lang.dev",
  trailingSlash: "always",
  markdown: {
    processor: unified({
      remarkPlugins: [remarkCassiniDocs],
      rehypePlugins: [rehypeCassiniTables],
    }),
    shikiConfig: {
      themes: {
        dark: cassiniDarkTheme,
        light: cassiniPrintTheme,
      },
      defaultColor: "dark",
      langs: [titanLang],
    },
  },
  // The playground engine starts `{ type: "module" }` Workers that import verified blob-URL modules.
  vite: {
    worker: { format: "es" },
  },
});
