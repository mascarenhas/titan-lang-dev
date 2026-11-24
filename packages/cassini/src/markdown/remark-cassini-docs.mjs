import path from "node:path";
import { visit } from "unist-util-visit";
import { renderMermaidSVG } from "beautiful-mermaid";

const DEFAULT_MERMAID_THEME = {
  bg: "var(--mermaid-bg)",
  fg: "var(--mermaid-fg)",
  line: "var(--mermaid-line)",
  accent: "var(--mermaid-accent)",
  muted: "var(--ink-muted)",
  surface: "var(--mermaid-node-bg)",
  border: "var(--mermaid-node-border)",
  font: "IBM Plex Sans",
  padding: 16,
  nodeSpacing: 20,
  layerSpacing: 26,
};

function stripGoogleFontsImport(svg) {
  return svg.replace(/^\s*@import\s+url\([^)]*fonts\.googleapis\.com[^)]*\);\s*\n?/gim, "");
}

function isExternalOrSpecial(url) {
  return (
    !url ||
    url.startsWith("#") ||
    url.startsWith("/") ||
    /^https?:\/\//i.test(url) ||
    /^[a-z][a-z0-9+.-]*:/i.test(url)
  );
}

function splitUrlFragment(url) {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) return { filePart: url, fragment: "" };
  return {
    filePart: url.slice(0, hashIdx),
    fragment: url.slice(hashIdx),
  };
}

function resolveRepoRelativePath(currentRepoRel, rawFilePart) {
  let decoded = rawFilePart;
  try {
    decoded = decodeURIComponent(rawFilePart);
  } catch {
    // Preserve raw string if percent-encoding is malformed
  }
  const dir = path.posix.dirname(currentRepoRel);
  const joined = dir === "." ? decoded : path.posix.join(dir, decoded);
  return path.posix.normalize(joined);
}

/**
 * Configurable remark plugin for @titan-lang/cassini sites.
 *
 * Options:
 *   sections: Array<{
 *     matchPath: string,         // substring matched against normalized file path
 *     repoUrl: string,           // e.g. "https://github.com/mascarenhas/titan"
 *     ref: string,               // pinned commit SHA or tag
 *     resolveInternal(repoRelPath, fragment): string | null,
 *     resolveAsset?(repoRelPath): string | null,
 *     rewriteExternal?(url): string | null,
 *   }>
 *   mermaid?: Partial<typeof DEFAULT_MERMAID_THEME>
 */
export function createRemarkCassiniDocs(options = {}) {
  const sections = options.sections || [];
  const mermaidOpts = { ...DEFAULT_MERMAID_THEME, ...(options.mermaid || {}) };

  return function remarkCassiniDocs() {
    return (tree, file) => {
      const absPath = (file.history?.[0] || file.path || "").replace(/\\/g, "/");
      let activeSection = null;
      let fileRepoRel = "";

      for (const sec of sections) {
        const idx = absPath.indexOf(sec.matchPath);
        if (idx !== -1) {
          activeSection = sec;
          fileRepoRel = absPath.slice(idx + sec.matchPath.length).replace(/^\/+/, "");
          break;
        }
      }

      visit(tree, (node, idx, parent) => {
        // 1. Links
        if (node.type === "link" && activeSection && typeof node.url === "string") {
          const rawUrl = node.url.trim();
          if (/^https?:\/\//i.test(rawUrl)) {
            const rewritten = activeSection.rewriteExternal?.(rawUrl);
            if (rewritten) node.url = rewritten;
            return;
          }
          if (isExternalOrSpecial(rawUrl)) return;

          const { filePart, fragment } = splitUrlFragment(rawUrl);
          if (!filePart) return;
          const isDirHint = filePart.endsWith("/");
          const repoRel = resolveRepoRelativePath(fileRepoRel, filePart);

          const internalRoute = activeSection.resolveInternal?.(repoRel, fragment);
          if (internalRoute) {
            node.url = internalRoute;
            return;
          }

          const assetRoute = activeSection.resolveAsset?.(repoRel);
          if (assetRoute) {
            node.url = `${assetRoute}${fragment}`;
            return;
          }

          const cleanRepoRel = repoRel.replace(/^(\.\.\/)+/, "").replace(/\/+$/, "");
          const ghKind = isDirHint ? "tree" : "blob";
          node.url = `${activeSection.repoUrl}/${ghKind}/${activeSection.ref}/${cleanRepoRel}${fragment}`;
          return;
        }

        // 2. Markdown images
        if (node.type === "image" && activeSection && typeof node.url === "string") {
          const rawUrl = node.url.trim();
          if (!isExternalOrSpecial(rawUrl)) {
            const { filePart } = splitUrlFragment(rawUrl);
            const repoRel = resolveRepoRelativePath(fileRepoRel, filePart);
            const assetRoute = activeSection.resolveAsset?.(repoRel);
            if (assetRoute) {
              node.url = assetRoute;
            }
          }
          return;
        }

        // 3. Raw HTML: strip <!-- doc-check: ... --> comments & rewrite <img src="...">
        if (node.type === "html" && typeof node.value === "string") {
          let val = node.value;
          if (/<!--\s*doc-check:/i.test(val)) {
            val = val.replace(/<!--\s*doc-check:[\s\S]*?-->\s*/gi, "");
            if (val.trim() === "" && parent && typeof idx === "number") {
              parent.children.splice(idx, 1);
              return idx;
            }
          }
          if (activeSection && /<img\b/i.test(val)) {
            val = val.replace(
              /(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi,
              (match, pre, quote, src) => {
                if (isExternalOrSpecial(src)) return match;
                const { filePart } = splitUrlFragment(src);
                const repoRel = resolveRepoRelativePath(fileRepoRel, filePart);
                const assetRoute = activeSection.resolveAsset?.(repoRel);
                return assetRoute ? `${pre}${quote}${assetRoute}${quote}` : match;
              },
            );
            val = val.replace(/<p\s+align=["']center["']\s*>/gi, '<p class="doc-center-figure">');
          }
          node.value = val;
          return;
        }

        // 4. Build-time Mermaid SVG rendering via beautiful-mermaid
        if (
          node.type === "code" &&
          (node.lang || "").trim().toLowerCase() === "mermaid" &&
          parent &&
          typeof idx === "number"
        ) {
          const rawSvg = renderMermaidSVG(node.value, mermaidOpts);
          const cleanSvg = stripGoogleFontsImport(rawSvg);
          parent.children[idx] = {
            type: "html",
            value:
              `<figure class="cassini-diagram mermaid-diagram" data-pagefind-ignore>` +
              `<div class="cassini-diagram-bar"><span>Architecture Diagram</span><span>Scroll horizontally to inspect →</span></div>` +
              `<div class="cassini-diagram-viewport mermaid-scroll">${cleanSvg}</div>` +
              `</figure>`,
          };
        }
      });
    };
  };
}

/**
 * Rehype plugin that wraps Markdown tables in `.cassini-table-wrap` so wide
 * 4–5 column tables scroll cleanly on narrow viewports without breaking layout.
 */
export function rehypeCassiniTables() {
  return (tree) => {
    const extractPlainText = (node) => {
      if (!node) return "";
      if (node.type === "text") return node.value || "";
      if (Array.isArray(node.children)) return node.children.map(extractPlainText).join("");
      return "";
    };
    visit(tree, "element", (node, idx, parent) => {
      if (node.tagName === "table" && parent && typeof idx === "number") {
        const alreadyWrapped =
          parent.type === "element" &&
          parent.tagName === "div" &&
          Array.isArray(parent.properties?.className) &&
          parent.properties.className.includes("cassini-table-wrap");
        if (alreadyWrapped) return;
        parent.children[idx] = {
          type: "element",
          tagName: "div",
          properties: { className: ["cassini-table-wrap"] },
          children: [node],
        };
      }
      if (
        node.tagName === "code" &&
        parent &&
        !(parent.type === "element" && parent.tagName === "pre")
      ) {
        const txt = extractPlainText(node);
        if (txt.length > 0 && txt.length <= 22 && /\s/.test(txt)) {
          node.properties = node.properties || {};
          const existing = Array.isArray(node.properties.className)
            ? node.properties.className
            : node.properties.className
              ? [String(node.properties.className)]
              : [];
          if (!existing.includes("ic-short")) {
            node.properties.className = [...existing, "ic-short"];
          }
        }
      }
    });
  };
}

/**
 * Pre-normalizes Markdown GFM pipe tables by escaping unescaped `|` characters
 * inside backtick inline-code spans (`<|T|>`, `{| p |}`) as `\|` before
 * `remark-gfm` splits table cells. Skips fenced code blocks and is idempotent.
 */
export function escapeTableInlineCodePipes(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fenceChar = null;
  let fenceLen = 0;
  let changed = false;

  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = len;
      } else if (ch === fenceChar && len >= fenceLen && trimmed.slice(len).trim() === "") {
        fenceChar = null;
        fenceLen = 0;
      }
      return line;
    }
    if (fenceChar || !trimmed.startsWith("|")) {
      return line;
    }

    let res = "";
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (line[i] === "`") {
        let j = i;
        while (j < n && line[j] === "`") j++;
        const ticks = j - i;
        let k = j;
        let closeIdx = -1;
        while (k < n) {
          if (line[k] === "`") {
            let m = k;
            while (m < n && line[m] === "`") m++;
            if (m - k === ticks) {
              closeIdx = k;
              break;
            }
            k = m;
          } else {
            k++;
          }
        }
        if (closeIdx !== -1) {
          const inner = line.slice(j, closeIdx);
          const escaped = inner.replace(/(?<!\\)\|/g, "\\|");
          if (escaped !== inner) changed = true;
          res += line.slice(i, j) + escaped + line.slice(closeIdx, closeIdx + ticks);
          i = closeIdx + ticks;
          continue;
        }
      }
      res += line[i];
      i++;
    }
    return res;
  });

  return changed ? out.join("\n") : markdown;
}
