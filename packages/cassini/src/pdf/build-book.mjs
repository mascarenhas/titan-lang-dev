import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import GithubSlugger from "github-slugger";
import {
  cassiniPrintTheme,
  createCassiniHighlighter,
  normalizeShikiLang,
} from "../shiki/index.mjs";
import { parseBookToc, parseTitanBookToc } from "../nav/book-toc.mjs";
import { escapeTableInlineCodePipes } from "../markdown/remark-cassini-docs.mjs";

const PACKAGE_PDF_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_THEME_PATH = path.join(PACKAGE_PDF_DIR, "theme.typ");
const mdProcessor = unified().use(remarkParse).use(remarkGfm);

function parseMarkdownDoc(absPath) {
  const raw = escapeTableInlineCodePipes(fs.readFileSync(absPath, "utf8"));
  const tree = mdProcessor.parse(raw);
  const slugger = new GithubSlugger();
  const headings = [];
  visit(tree, "heading", (n) => {
    const text = toString(n);
    const slug = slugger.slug(text);
    n._ghSlug = slug;
    headings.push({ depth: n.depth, text, slug });
  });
  return { raw, tree, headings };
}

function sanitizeLabelPart(s) {
  return (
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sec"
  );
}

function makeLabelHelpers(stripPrefixes) {
  const normalized = stripPrefixes
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  function repoRelToFileKey(repoRel) {
    let trimmed = repoRel;
    for (const prefix of normalized) {
      if (trimmed.startsWith(`${prefix}/`)) {
        trimmed = trimmed.slice(prefix.length + 1);
        break;
      }
    }
    trimmed = trimmed.replace(/\.md$/i, "").replace(/\//g, "--");
    return sanitizeLabelPart(trimmed);
  }

  return {
    chapterLabel: (repoRel) => `doc-${repoRelToFileKey(repoRel)}`,
    headingLabel: (repoRel, ghSlug) =>
      `doc-${repoRelToFileKey(repoRel)}--${sanitizeLabelPart(ghSlug)}`,
  };
}

function escTypstContent(s, mathPatterns = []) {
  // Preserve configured inline math patterns (e.g. $O(1)$) while escaping every other `$`
  // (such as $PREFIX, $PATH, $env:...).
  const placeholders = [];
  let out = s;
  for (const pat of mathPatterns) {
    const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : `${pat.flags}g`);
    out = out.replace(re, (match) => {
      const idx = placeholders.length;
      placeholders.push(match);
      return `\uE000MATH${idx}\uE001`;
    });
  }
  out = out
    .replace(/\\/g, "\\\\")
    .replace(/([#$*_`<>\[\]@~])/g, "\\$1")
    .replace(/\/\//g, "\\/\\/")
    .replace(/\/\*/g, "\\/*")
    .replace(/\*\//g, "*\\/")
    .replace(/---/g, "\u2014")
    .replace(/--/g, "\u2013")
    .replace(/-\\>/g, '#box("->");');
  // The placeholder token avoids every character escaped above.
  for (let i = 0; i < placeholders.length; i++) {
    out = out.replaceAll(`\uE000MATH${i}\uE001`, placeholders[i]);
  }
  return out;
}

function escTypstStr(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function formatTypstLines(linesOrString, fallback) {
  if (Array.isArray(linesOrString) && linesOrString.length > 0) {
    return `[${linesOrString.map((line) => escTypstContent(line)).join("\\\n  ")}]`;
  }
  if (typeof linesOrString === "string" && linesOrString.trim() !== "") {
    return `[${linesOrString
      .split("\n")
      .map((line) => escTypstContent(line))
      .join("\\\n  ")}]`;
  }
  return `"${escTypstStr(fallback)}"`;
}

function splitCodeTokenIntoBoxes(tok, splitThreshold) {
  // Never split after ASCII `-` so CLI flags (`-c`, `--incremental`, `--c-source`)
  // and hyphenated identifiers never dangle `-`/`--` at line ends, while preserving
  // literal ASCII `-` (U+002D) in PDF text extraction.
  if (tok.length <= splitThreshold) return [tok];
  const chunks = [];
  let cur = "";
  for (let i = 0; i < tok.length; i++) {
    const ch = tok[i];
    cur += ch;
    if (i === tok.length - 1) continue;
    const next = tok[i + 1];
    if (next === " ") continue;
    // Safe break opportunities: after `/`, `(`, `[`, `,`, `:` or after `.` / `_`
    // when preceded by an alphanumeric/closer and NOT part of `..` / `...`.
    if ("/([,:".includes(ch)) {
      chunks.push(cur);
      cur = "";
    } else if ((ch === "." || ch === "_") && i > 0 && /[A-Za-z0-9)\]}]/.test(tok[i - 1]) && !(ch === "." && next === ".")) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function renderInlineCodeTypst(val, inTable) {
  // CommonMark §6.1: line endings inside inline code spans become single ASCII spaces.
  // Normalizing first guarantees no multi-line `#ic-seg(...)` box drops onto the next row.
  const norm = val.replace(/\r?\n/g, " ");
  // Keep short spans atomic (`#ic`), while allowing spans > 12 chars that contain
  // spaces or safe punctuation (`.`, `/`, `_`, `,`) to break cleanly so preceding
  // justified lines do not stretch (#52.1). Hyphens inside tokens NEVER break (#52.2).
  const hasSafeBreak = /[ ./_,([:]/.test(norm);
  if (!inTable && (norm.length <= 10 || (!hasSafeBreak && norm.length <= 16))) {
    return `#ic("${escTypstStr(norm)}");`;
  }
  const splitThreshold = 10;
  const tokens = norm.split(" ");
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) parts.push("#ic-sp");
    const tok = tokens[i];
    if (!tok) continue;
    const chunks = splitCodeTokenIntoBoxes(tok, splitThreshold);
    parts.push(chunks.map((c) => `#ic-seg("${escTypstStr(c)}")`).join("#sym.zws"));
  }
  return `#ic-rich[${parts.join("")}];`;
}

function computeTableColumns(tableNode) {
  const rows = tableNode.children;
  const colCount = rows[0]?.children?.length || 1;
  const isCompact = colCount >= 4;
  // Exact rail widths matching `theme.typ`: 138.8mm (393.4pt) for 4-5 col wide tables,
  // 122.8mm (348.1pt) for 2-3 col prose-seated tables.
  const availPt = isCompact ? 393.4 : 348.1;
  const cellPadPt = isCompact ? 9.5 : 11.5;
  const monoCharPt = isCompact ? 4.65 : 5.0;
  const sansCharPt = isCompact ? 4.95 : 5.3;
  const hdrCharPt = isCompact ? 5.25 : 5.6;

  const maxLens = new Array(colCount).fill(4);
  const colLens = Array.from({ length: colCount }, () => []);
  const minColPt = new Array(colCount).fill(32);
  const maxHyphenTokLens = new Array(colCount).fill(0);

  const measureCellMinPt = (node, colIdx, isHeader) => {
    if (!node) return;
    if (node.type === "inlineCode") {
      const norm = (node.value || "").replace(/\r?\n/g, " ");
      for (const tok of norm.split(" ")) {
        if (!tok) continue;
        for (const seg of splitCodeTokenIntoBoxes(tok, 10)) {
          const pt = seg.length * monoCharPt + cellPadPt + 3.5;
          if (pt > minColPt[colIdx]) minColPt[colIdx] = pt;
          if (seg.includes("-") && seg.length > maxHyphenTokLens[colIdx]) {
            maxHyphenTokLens[colIdx] = seg.length;
          }
        }
      }
      return;
    }
    if (node.type === "text") {
      const chPt = isHeader ? hdrCharPt : sansCharPt;
      for (const rawWord of (node.value || "").split(/\s+/)) {
        if (!rawWord) continue;
        // Prose breaks after `/`, so measure slash-separated segments unless hyphenated flag
        const subWords = rawWord.startsWith("-") ? [rawWord] : rawWord.split(/(?<=\/)/);
        for (const w of subWords) {
          if (!w) continue;
          const pt = w.length * chPt + cellPadPt + 3.5;
          if (pt > minColPt[colIdx]) minColPt[colIdx] = pt;
        }
      }
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        measureCellMinPt(child, colIdx, isHeader);
      }
    }
  };

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const isHeader = rIdx === 0;
    for (let c = 0; c < colCount; c++) {
      const cell = row.children[c] || { type: "text", value: "" };
      const txt = toString(cell).replace(/\s+/g, " ").trim();
      maxLens[c] = Math.max(maxLens[c], txt.length);
      colLens[c].push(txt.length);
      measureCellMinPt(cell, c, isHeader);
    }
  }

  // Align sibling 5-column reference/catalog tables (4 compact metadata cols + 1 wide description col)
  // to consistent fixed proportions so stacked tables never jump horizontally (#52.7).
  if (
    colCount === 5 &&
    maxLens[0] <= 22 &&
    maxLens[1] <= 22 &&
    maxLens[2] <= 26 &&
    maxLens[3] <= 28 &&
    maxLens[4] >= 28
  ) {
    return { colCount, cols: ["13%", "15%", "21%", "16%", "35%"] };
  }

  // For 2-column CLI flag/option tables whose first column has long hyphenated flags,
  // allocate exact pt width for column 0 and `1fr` for description column (#52.2).
  if (colCount === 2 && maxHyphenTokLens[0] >= 10) {
    const col0Pt = Math.min(160, Math.ceil(Math.max(minColPt[0], maxHyphenTokLens[0] * 4.95 + 16)));
    return { colCount, cols: [`${col0Pt}pt`, "1fr"] };
  }

  // Compute desired proportional weights from each column's text length distribution
  const weights = colLens.map((arr, idx) => {
    arr.sort((a, b) => a - b);
    const p85 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.85))] || 6;
    return Math.max(12, Math.min(80, Math.round(p85 * 0.65 + maxLens[idx] * 0.35)));
  });
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  // Enforce every column's minimum unbreakable word/code-segment width so glyphs NEVER
  // spill into the adjacent column (pp. 68, 389, 529), then distribute remaining width.
  const floorPts = minColPt.map((v) => Math.ceil(v));
  let sumFloor = floorPts.reduce((a, b) => a + b, 0);
  const finalPts = [...floorPts];

  if (sumFloor > availPt) {
    const scale = availPt / sumFloor;
    for (let c = 0; c < colCount; c++) {
      finalPts[c] = Math.floor(floorPts[c] * scale);
    }
  } else {
    const remPt = availPt - sumFloor;
    const extraNeeds = weights.map((w, c) => Math.max(0, (availPt * w) / weightSum - floorPts[c]));
    const needSum = extraNeeds.reduce((a, b) => a + b, 0);
    for (let c = 0; c < colCount; c++) {
      const share = needSum > 0 ? extraNeeds[c] / needSum : 1 / colCount;
      finalPts[c] = Math.round(floorPts[c] + remPt * share);
    }
  }

  // Give `1fr` to the widest column so the table spans 100% of the rail cleanly
  let widestIdx = 0;
  for (let c = 1; c < colCount; c++) {
    if (finalPts[c] > finalPts[widestIdx]) widestIdx = c;
  }
  const cols = finalPts.map((pt, c) => (c === widestIdx ? "1fr" : `${pt}pt`));
  return { colCount, cols };
}

function toRootRelativeTypstPath(projectRoot, absTarget) {
  const rel = path.relative(projectRoot, absTarget).split(path.sep).join("/");
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes Typst --root (${projectRoot}): ${absTarget}`);
  }
  return `/${rel}`;
}

function splitPartHeading(partTitle) {
  const m = partTitle.match(/^(Part\s+[IVXLCDM0-9]+)\s*[—:-]\s*(.+)$/i);
  if (m) return { numeral: m[1].trim(), title: m[2].trim() };
  return { numeral: partTitle, title: "" };
}

function toColumnMajorPairs(items) {
  // Reorder flat list so a 2-column Typst grid reads top-to-bottom down column 1,
  // then top-to-bottom down column 2.
  const rows = Math.ceil(items.length / 2);
  const out = [];
  for (let r = 0; r < rows; r++) {
    out.push(items[r]);
    if (r + rows < items.length) {
      out.push(items[r + rows]);
    }
  }
  return out;
}

function countPdfPages(pdfPath) {
  try {
    const info = execFileSync("pdfinfo", [pdfPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = info.match(/^Pages:\s+(\d+)/m);
    if (m) return Number.parseInt(m[1], 10);
  } catch {
    // Fall back to scanning PDF object dictionary directly
  }
  const raw = fs.readFileSync(pdfPath).toString("latin1");
  let maxCount = 0;
  for (const m of raw.matchAll(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/g)) {
    const n = Number.parseInt(m[1], 10);
    if (n > maxCount) maxCount = n;
  }
  if (maxCount > 0) return maxCount;
  throw new Error(`Unable to determine page count for generated PDF: ${pdfPath}`);
}

/**
 * Compiles a structured Markdown manual/book to PDF via unified AST + Shiki 4.6 -> Typst.
 * Parameterized for reuse across `@titan-lang/cassini` sites (e.g. Titan book, `titan-mk` manual).
 */
export async function buildBookPdf(options) {
  const tStart = performance.now();
  const {
    projectRoot,
    docsDir,
    langDir,
    indexFile = "index.md",
    repoDocsPrefix = "doc",
    includePreface = true,
    prefaceTitle,
    prefaceKicker = "Preface",
    toc: providedToc,
    tocOptions = {},
    partSummaries = {},
    logoPath = null,
    grammarPath = null,
    outPdfPath,
    outTypPath = outPdfPath.replace(/\.pdf$/i, ".typ"),
    metaOutPath = null,
    copyToPaths = [],
    themePath = DEFAULT_THEME_PATH,
    siteBase = "",
    bookUrlPrefix = "/book",
    onlineDocsPrefixes,
    repoUrl = "",
    repoSha = "main",
    version = "",
    title = "Documentation",
    coverTitle = null,
    subtitle = "",
    coverSubtitle = null,
    author = "",
    dateStr = String(new Date().getUTCFullYear()),
    copyrightNotice = "",
    license = "MIT License",
    keywords = [],
    edition = "",
    editionNote = "",
    sourceNote = "",
    duplex = false,
    mathPatterns = [/\$O\([^$\n]+\)\$/g],
    typstBin = process.env.TYPST_BIN || "typst",
    fontPaths = [],
    shikiTheme = cassiniPrintTheme,
  } = options;

  const resolvedDocsDir = docsDir || langDir;
  if (!resolvedDocsDir && !providedToc) {
    throw new Error("buildBookPdf requires `docsDir` (or a pre-parsed `toc`)");
  }

  const normalizedRepoPrefix = repoDocsPrefix.replace(/^\/+|\/+$/g, "");
  const normalizedSiteBase = siteBase.replace(/\/+$/, "");
  const normalizedBookPrefix = bookUrlPrefix.replace(/\/+$/, "");
  const normalizedRepoUrl = repoUrl.replace(/\/+$/, "");
  const ghBlobBase = normalizedRepoUrl ? `${normalizedRepoUrl}/blob/${repoSha}` : "";
  const ghTreeBase = normalizedRepoUrl ? `${normalizedRepoUrl}/tree/${repoSha}` : "";
  const { chapterLabel, headingLabel } = makeLabelHelpers([normalizedRepoPrefix, "doc"]);

  // 1. Parse TOC (or use caller-provided TOC)
  const toc =
    providedToc ||
    parseBookToc({
      docsDir: resolvedDocsDir,
      indexFile,
      repoDocsPrefix: normalizedRepoPrefix,
      baseUrl: normalizedBookPrefix,
      ...tocOptions,
    });

  const includedDocs = new Map(); // repoRel -> { absPath, parsed }
  const emittedLabels = new Set();

  function registerDoc(repoRel, absPath) {
    const parsed = parseMarkdownDoc(absPath);
    includedDocs.set(repoRel, { absPath, parsed });
    emittedLabels.add(chapterLabel(repoRel));
    for (const h of parsed.headings) {
      emittedLabels.add(headingLabel(repoRel, h.slug));
    }
  }

  const indexRepoRel = toc.indexEntry.repoRel;
  if (includePreface) {
    registerDoc(indexRepoRel, toc.indexEntry.absPath);
  }
  let chaptersIncluded = 0;
  for (const part of toc.parts) {
    for (const entry of part.entries) {
      registerDoc(entry.repoRel, entry.absPath);
      chaptersIncluded++;
    }
  }

  const resolvedOnlinePrefixes = (
    onlineDocsPrefixes || [
      {
        repoPrefix: normalizedRepoPrefix ? `${normalizedRepoPrefix}/` : "",
        urlPrefix: normalizedBookPrefix,
      },
    ]
  ).map((rule) => ({
    repoPrefix: rule.repoPrefix,
    urlPrefix: rule.urlPrefix.replace(/\/+$/, ""),
  }));

  // 2. Initialize Shiki 4.6 with optional Titan TextMate grammar + 6-voice print theme
  const tShiki0 = performance.now();
  const highlighter = await createCassiniHighlighter({
    grammarPath,
    themes: [shikiTheme],
  });
  const tShikiInit = performance.now() - tShiki0;
  const defaultInkHex = (shikiTheme.colors?.["editor.foreground"] || "#1B1D18").toUpperCase();

  // 3. Link resolution & AST -> Typst emitters
  const linkStats = { internal: 0, externalSite: 0, externalGithub: 0, externalWeb: 0 };
  const referencedLabels = [];
  const unresolvedInternalLinks = [];
  const unknownNodes = new Set();

  function resolveLink(rawUrl, currentRepoRel) {
    if (/^https?:\/\//i.test(rawUrl) || /^mailto:/i.test(rawUrl)) {
      linkStats.externalWeb++;
      return { type: "url", target: rawUrl };
    }

    const hashIdx = rawUrl.indexOf("#");
    const rawFile = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
    let rawAnchor = hashIdx >= 0 ? rawUrl.slice(hashIdx + 1) : null;
    if (rawAnchor !== null) {
      try {
        rawAnchor = decodeURIComponent(rawAnchor);
      } catch {
        // Keep raw
      }
    }

    // Same-file anchor: must resolve inside this PDF chapter (never silently degrade!)
    if (rawFile === "" && rawAnchor !== null) {
      const lbl = headingLabel(currentRepoRel, rawAnchor);
      if (emittedLabels.has(lbl)) {
        linkStats.internal++;
        referencedLabels.push({ source: currentRepoRel, url: rawUrl, label: lbl });
        return { type: "label", target: lbl };
      }
      unresolvedInternalLinks.push({
        source: currentRepoRel,
        url: rawUrl,
        targetRepoRel: currentRepoRel,
        expectedLabel: lbl,
      });
      return { type: "label", target: lbl };
    }

    const isDirHint = rawFile.endsWith("/");
    let decodedFile = rawFile;
    try {
      decodedFile = decodeURIComponent(rawFile);
    } catch {
      // Keep raw
    }
    const targetRepoRel = rawFile
      ? path.posix.normalize(path.posix.join(path.posix.dirname(currentRepoRel), decodedFile))
      : currentRepoRel;

    // Target document included in PDF -> MUST resolve to an internal PDF label
    if (includedDocs.has(targetRepoRel)) {
      const lbl = rawAnchor
        ? headingLabel(targetRepoRel, rawAnchor)
        : chapterLabel(targetRepoRel);
      if (emittedLabels.has(lbl)) {
        linkStats.internal++;
        referencedLabels.push({ source: currentRepoRel, url: rawUrl, label: lbl });
        return { type: "label", target: lbl };
      }
      unresolvedInternalLinks.push({
        source: currentRepoRel,
        url: rawUrl,
        targetRepoRel,
        expectedLabel: lbl,
      });
      return { type: "label", target: lbl };
    }

    // Excluded docs under configured online prefixes (e.g. Titan's 35 uv/ sub-docs) -> live website
    if (normalizedSiteBase && targetRepoRel.endsWith(".md")) {
      for (const rule of resolvedOnlinePrefixes) {
        if (rule.repoPrefix && targetRepoRel.startsWith(rule.repoPrefix)) {
          const relInSection = targetRepoRel.slice(rule.repoPrefix.length);
          const route =
            relInSection === "index.md"
              ? `${rule.urlPrefix}/`
              : `${rule.urlPrefix}/${relInSection.replace(/\.md$/i, "")}/`;
          const anchor = rawAnchor ? `#${rawAnchor}` : "";
          linkStats.externalSite++;
          return { type: "url", target: `${normalizedSiteBase}${route}${anchor}` };
        }
      }
    }

    // Everything else in repo (implementation docs, .titan examples, browser-app/, vendor/*) -> GitHub
    const cleanRel = targetRepoRel.replace(/^(\.\.\/)+/, "").replace(/\/+$/, "");
    const base = isDirHint ? ghTreeBase : ghBlobBase;
    const anchor = rawAnchor ? `#${rawAnchor}` : "";
    linkStats.externalGithub++;
    return { type: "url", target: base ? `${base}/${cleanRel}${anchor}` : rawUrl };
  }

  function extractCodeTitle(meta) {
    if (!meta) return "";
    const m = String(meta).match(/\btitle=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    return m ? (m[1] || m[2] || m[3] || "") : "";
  }

  function renderCodeBlock(code, lang, meta) {
    const rawLang = (lang || "").trim().toLowerCase();
    const mapped = normalizeShikiLang(rawLang);
    const title = extractCodeTitle(meta);
    const { tokens } = highlighter.codeToTokens(code, {
      lang: mapped,
      theme: shikiTheme.name,
    });
    const emitTokChunk = (content, color, isBold, isItalic) => {
      const txt = escTypstStr(content);
      if (isBold && isItalic) return `#tbi("${color}","${txt}");`;
      if (isBold) return `#tb("${color}","${txt}");`;
      if (isItalic) return `#ti("${color}","${txt}");`;
      if (color === defaultInkHex) return `#"${txt}";`;
      return `#t("${color}","${txt}");`;
    };

    const typLines = tokens.map((line) => {
      if (line.length === 0) return "#sym.space.nobreak";
      const plainLen = line.reduce((sum, tok) => sum + tok.content.length, 0);
      if (plainLen <= 76) {
        return line
          .map((tok) => {
            const color = (tok.color || defaultInkHex).toUpperCase();
            const style = tok.fontStyle || 0;
            return emitTokChunk(tok.content, color, Boolean(style & 2), Boolean(style & 1));
          })
          .join("");
      }
      // For long lines (> 76 cols) that may wrap in print, group contiguous non-space
      // token runs containing `-` into `#box[...]` so wraps break at spaces only
      // (never mid-flag after `-`/`--`, with zero invisible Unicode characters).
      const items = []; // { ws: boolean, text: string, parts: Array<{content, color, isBold, isItalic}> }
      for (const tok of line) {
        const color = (tok.color || defaultInkHex).toUpperCase();
        const style = tok.fontStyle || 0;
        const isBold = Boolean(style & 2);
        const isItalic = Boolean(style & 1);
        for (const piece of tok.content.match(/\s+|\S+/g) || []) {
          const ws = /^\s+$/.test(piece);
          const last = items[items.length - 1];
          if (!ws && last && !last.ws) {
            last.text += piece;
            last.parts.push({ content: piece, color, isBold, isItalic });
          } else {
            items.push({ ws, text: piece, parts: [{ content: piece, color, isBold, isItalic }] });
          }
        }
      }
      // Keep comment marker `--` glued to the following comment word so `--` never dangles at line end.
      const merged = [];
      for (let i = 0; i < items.length; i++) {
        const cur = items[i];
        if (
          !cur.ws &&
          cur.text === "--" &&
          i + 2 < items.length &&
          items[i + 1].ws &&
          !items[i + 2].ws &&
          cur.text.length + items[i + 1].text.length + items[i + 2].text.length <= 44
        ) {
          merged.push({
            ws: false,
            text: cur.text + items[i + 1].text + items[i + 2].text,
            parts: [...cur.parts, ...items[i + 1].parts, ...items[i + 2].parts],
          });
          i += 2;
        } else {
          merged.push(cur);
        }
      }
      return merged
        .map((item) => {
          const rendered = item.parts
            .map((p) => emitTokChunk(p.content, p.color, p.isBold, p.isItalic))
            .join("");
          if (!item.ws && item.text.includes("-") && item.text.length <= 76) {
            return `#box[${rendered}];`;
          }
          return rendered;
        })
        .join("");
    });
    const isNonEmpty = (ln) => ln !== "#sym.space.nobreak";
    const nonEmptyCount = typLines.filter(isNonEmpty).length;
    const keepWhole = typLines.length <= 12 || nonEmptyCount <= 7;
    const argParts = [];
    if (title) argParts.push(`title: "${escTypstStr(title)}"`);
    if (keepWhole) argParts.push("breakable: false");
    const argStr = argParts.length > 0 ? `(${argParts.join(", ")})` : "";
    if (keepWhole) {
      return `#codeframe${argStr}[${typLines.join("\\\n")}]\n\n`;
    }
    // Protect >= 3 NON-EMPTY lines at head and tail so page breaks never leave 1-2 stranded lines (#52.8).
    let headEnd = 0;
    let seen = 0;
    while (headEnd < typLines.length && seen < 3) {
      if (isNonEmpty(typLines[headEnd])) seen++;
      headEnd++;
    }
    let tailStart = typLines.length;
    seen = 0;
    while (tailStart > headEnd && seen < 3) {
      tailStart--;
      if (isNonEmpty(typLines[tailStart])) seen++;
    }
    if (tailStart <= headEnd) {
      return `#codeframe${argParts.length > 0 ? `(${[...argParts, "breakable: false"].join(", ")})` : "(breakable: false)"}[${typLines.join("\\\n")}]\n\n`;
    }
    const head = typLines.slice(0, headEnd).join("\\\n");
    const mid = typLines.slice(headEnd, tailStart).join("\\\n");
    const tail = typLines.slice(tailStart).join("\\\n");
    return `#codeframe${argStr}[#code-keep[${head}]#code-flow[${mid}]#code-keep[${tail}]]\n\n`;
  }

  function renderInline(nodes, ctx) {
    let out = "";
    for (const n of nodes || []) {
      switch (n.type) {
        case "text":
          out += escTypstContent(n.value, mathPatterns);
          break;
        case "inlineCode": {
          // Every call ends with `;` so a following literal `;` in prose stays in markup mode (#43).
          out += renderInlineCodeTypst(n.value, Boolean(ctx.inTable));
          break;
        }
        case "strong":
          out += `#strong[${renderInline(n.children, ctx)}];`;
          break;
        case "emphasis":
          out += `#emph[${renderInline(n.children, ctx)}];`;
          break;
        case "delete":
          out += `#strike[${renderInline(n.children, ctx)}];`;
          break;
        case "link": {
          const res = resolveLink(n.url, ctx.repoRel);
          const body = renderInline(n.children, ctx);
          if (res.type === "label") {
            out += `#link(<${res.target}>)[${body}];`;
          } else {
            out += `#link("${escTypstStr(res.target)}")[${body}];`;
          }
          break;
        }
        case "break":
          out += " \\\n";
          break;
        case "html":
          if (!n.value.trim().startsWith("<!--")) {
            unknownNodes.add(`inline-html:${n.value.slice(0, 40)}`);
          }
          break;
        default:
          unknownNodes.add(n.type);
          out += escTypstContent(toString(n), mathPatterns);
      }
    }
    return out;
  }

  function renderListItem(item, ctx) {
    let out = "";
    for (let i = 0; i < item.children.length; i++) {
      const child = item.children[i];
      if (child.type === "paragraph") {
        out += renderInline(child.children, ctx) + "\n";
        if (i + 1 < item.children.length) out += "\n";
      } else {
        out += renderBlocks([child], ctx);
      }
    }
    return out;
  }

  function renderBlockquote(blockquoteNode, ctx) {
    // Detect `> **Title:** body...` editorial callouts and render them with R3
    // fill-free run-in uppercase sans titles.
    const kids = blockquoteNode.children || [];
    if (kids.length > 0 && kids[0].type === "paragraph") {
      const pKids = kids[0].children || [];
      if (pKids.length > 0 && pKids[0].type === "strong") {
        const strongText = toString(pKids[0]).trim();
        let leadTitle = null;
        let restInline = pKids.slice(1);
        if (strongText.endsWith(":")) {
          leadTitle = strongText.slice(0, -1).trim();
          if (restInline[0]?.type === "text") {
            restInline = [
              { ...restInline[0], value: restInline[0].value.replace(/^\s+/, "") },
              ...restInline.slice(1),
            ];
          }
        } else if (restInline[0]?.type === "text" && /^\s*:\s*/.test(restInline[0].value)) {
          leadTitle = strongText;
          restInline = [
            { ...restInline[0], value: restInline[0].value.replace(/^\s*:\s*/, "") },
            ...restInline.slice(1),
          ];
        }
        if (leadTitle) {
          const firstParaBody = renderInline(restInline, ctx);
          const remainingBlocks = kids.length > 1 ? "\n\n" + renderBlocks(kids.slice(1), ctx) : "";
          return `#callout(title: "${escTypstStr(leadTitle)}")[${firstParaBody}${remainingBlocks}]\n\n`;
        }
      }
    }
    return `#callout(kind: "blockquote")[${renderBlocks(kids, ctx).trimEnd()}]\n\n`;
  }

  function renderBlocks(nodes, ctx) {
    let out = "";
    for (const n of nodes || []) {
      switch (n.type) {
        case "heading": {
          if (n.depth === 1 && ctx.skipFirstH1) {
            ctx.skipFirstH1 = false;
            const hLbl = headingLabel(ctx.repoRel, n._ghSlug);
            if (hLbl !== chapterLabel(ctx.repoRel)) {
              out += `#box[] <${hLbl}>\n\n`;
            }
            break;
          }
          const level = Math.min(6, n.depth + (ctx.headingShift ?? 1));
          const eq = "=".repeat(level);
          const headingText = renderInline(n.children, ctx);
          const lbl = headingLabel(ctx.repoRel, n._ghSlug);
          out += `${eq} ${headingText} <${lbl}>\n\n`;
          break;
        }
        case "paragraph":
          out += `${renderInline(n.children, ctx)}\n\n`;
          break;
        case "code":
          out += renderCodeBlock(n.value, n.lang, n.meta);
          break;
        case "list": {
          const start = n.ordered ? (n.start ?? 1) : null;
          for (let i = 0; i < n.children.length; i++) {
            const item = n.children[i];
            const prefix = n.ordered ? `${start + i}. ` : "- ";
            const itemBody = renderListItem(item, ctx);
            const indented = itemBody
              .trimEnd()
              .split("\n")
              .map((ln, idx) => (idx === 0 ? prefix + ln : "  " + ln))
              .join("\n");
            out += indented + "\n";
          }
          out += "\n";
          break;
        }
        case "table": {
          const { colCount, cols } = computeTableColumns(n);
          const aligns = (n.align || []).map((a) =>
            a === "right" ? "right + top" : a === "center" ? "center + top" : "left + top",
          );
          while (aligns.length < colCount) aligns.push("left + top");
          const tableCtx = { ...ctx, inTable: true };
          const headerRow = n.children[0];
          const bodyRows = n.children.slice(1);
          const headerCells = headerRow.children
            .map((c) => `[${renderInline(c.children, tableCtx)}]`)
            .join(", ");
          const bodyRowTuples = bodyRows
            .map((r) => {
              const cells = r.children.map((c) => `[${renderInline(c.children, tableCtx)}]`);
              return `(${cells.join(", ")}${cells.length === 1 ? "," : ""})`;
            })
            .join(",\n    ");
          const compact = colCount >= 4;
          out += `#book-table(\n`;
          out += `  columns: (${cols.join(", ")}${cols.length === 1 ? "," : ""}),\n`;
          out += `  align: (${aligns.join(", ")}${aligns.length === 1 ? "," : ""}),\n`;
          out += `  compact: ${compact ? "true" : "false"},\n`;
          out += `  wide: auto,\n`;
          out += `  header: (${headerCells}${headerRow.children.length === 1 ? "," : ""}),\n`;
          out += `  rows: (\n    ${bodyRowTuples}${bodyRows.length === 1 ? "," : ""}\n  ),\n`;
          out += `)\n\n`;
          break;
        }
        case "blockquote":
          out += renderBlockquote(n, ctx);
          break;
        case "thematicBreak":
          out += `#book-rule()\n\n`;
          break;
        case "html":
          if (!n.value.trim().startsWith("<!--") && !n.value.includes("titan-logo.svg")) {
            unknownNodes.add(`block-html:${n.value.slice(0, 50)}`);
          }
          break;
        default:
          unknownNodes.add(n.type);
      }
    }
    return out;
  }

  // 4. Assemble Typst monograph importing R3 theme.typ
  const tEmit0 = performance.now();
  const themeImportPath = toRootRelativeTypstPath(projectRoot, themePath);
  const logoTypstPath = logoPath ? toRootRelativeTypstPath(projectRoot, logoPath) : null;
  const siteLabel = normalizedSiteBase.replace(/^https?:\/\//i, "");
  const repoLabel = normalizedRepoUrl.replace(/^https?:\/\//i, "");
  const typstCoverTitle = formatTypstLines(coverTitle, title);
  const typstCoverSubtitle = formatTypstLines(coverSubtitle, subtitle);
  const typstKeywords =
    keywords && keywords.length > 0
      ? `(${keywords.map((k) => `"${escTypstStr(k)}"`).join(", ")}${keywords.length === 1 ? "," : ""})`
      : "()";

  let typ = `// Auto-generated by @titan-lang/cassini/pdf${version ? ` (v${version})` : ""}
#import "${escTypstStr(themeImportPath)}": *

#show: titan-book.with(
  title: "${escTypstStr(title)}",
  author: "${escTypstStr(author)}",
  keywords: ${typstKeywords},
  duplex: ${duplex ? "true" : "false"},
)

#book-cover(
  title: ${typstCoverTitle},
  subtitle: ${typstCoverSubtitle},
  edition: "${escTypstStr(edition || (version ? `Version ${version}` : ""))}",
  author: "${escTypstStr(author)}",
  url: "${escTypstStr(normalizedSiteBase)}",
  site-label: "${escTypstStr(siteLabel)}",
  logo: ${logoTypstPath ? `image("${escTypstStr(logoTypstPath)}", width: 76mm)` : "none"},
)

#set page(numbering: "i")
#counter(page).update(1)
#book-colophon(
  title: [${escTypstContent(title, mathPatterns)}],
  subtitle: "${escTypstStr(subtitle)}",
  edition-note: "${escTypstStr(editionNote || edition)}",
  author: "${escTypstStr(author)}",
  date-str: "${escTypstStr(dateStr)}",
  copyright-notice: "${escTypstStr(copyrightNotice)}",
  license: "${escTypstStr(license)}",
  repo-url: "${escTypstStr(normalizedRepoUrl)}",
  repo-label: "${escTypstStr(repoLabel)}",
  site-url: "${escTypstStr(normalizedSiteBase)}",
  site-label: "${escTypstStr(siteLabel)}",
  source-note: "${escTypstStr(sourceNote)}",
)

#book-toc(title: "Contents", depth: 2)

`;

  // Optional Preface from index.md (Frontmatter Roman numerals, before Part I resets to 1)
  if (includePreface) {
    const idxEntry = includedDocs.get(indexRepoRel);
    const resolvedPrefaceTitle =
      prefaceTitle || `Preface: ${toc.indexEntry.title || title}`;
    typ += `#chapter-opener(\n`;
    typ += `  kicker: "${escTypstStr(prefaceKicker)}",\n`;
    typ += `  title: [${escTypstContent(resolvedPrefaceTitle, mathPatterns)}],\n`;
    typ += `  lbl: <${chapterLabel(indexRepoRel)}>,\n`;
    typ += `)\n\n`;
    const ctx = {
      repoRel: indexRepoRel,
      headingShift: 1,
      skipFirstH1: true,
      inTable: false,
    };
    typ += renderBlocks(idxEntry.parsed.tree.children, ctx);
  }

  // Main body: Arabic numbering starting at 1 on Part I
  typ += `\n#set page(numbering: "1")\n#counter(page).update(1)\n\n`;

  for (let pIdx = 0; pIdx < toc.parts.length; pIdx++) {
    const part = toc.parts[pIdx];
    const { numeral, title: partSubTitle } = splitPartHeading(part.title);
    const partSummary =
      partSummaries[numeral] ||
      partSummaries[part.title] ||
      partSummaries[String(pIdx)] ||
      "";
    const chapterPairs = toColumnMajorPairs(
      part.entries.map((entry, idx) => {
        const badge = entry.badge
          ? /^\d+$/.test(entry.badge)
            ? entry.badge.padStart(2, "0")
            : entry.badge
          : String(idx + 1).padStart(2, "0");
        return [badge, entry.title];
      }),
    );
    const chaptersTypst = chapterPairs
      .map(([b, t]) => `("${escTypstStr(b)}", "${escTypstStr(t)}")`)
      .join(",\n    ");

    typ += `\n#part-opener(\n`;
    typ += `  numeral: "${escTypstStr(numeral)}",\n`;
    typ += `  title: "${escTypstStr(partSubTitle)}",\n`;
    if (partSummary) {
      typ += `  summary: "${escTypstStr(partSummary)}",\n`;
    }
    typ += `  chapters: (\n    ${chaptersTypst}${chapterPairs.length === 1 ? "," : ""}\n  ),\n`;
    typ += `)\n\n`;

    for (const entry of part.entries) {
      const doc = includedDocs.get(entry.repoRel).parsed;
      const h1 = doc.headings.find((h) => h.depth === 1);
      const chTitle = h1 ? h1.text : entry.fullTitle || entry.title;
      const chLbl = chapterLabel(entry.repoRel);
      typ += `#chapter-opener(\n`;
      typ += `  kicker: "${escTypstStr(entry.kicker || "")}",\n`;
      typ += `  title: [${escTypstContent(chTitle, mathPatterns)}],\n`;
      typ += `  lbl: <${chLbl}>,\n`;
      typ += `)\n\n`;
      const ctx = {
        repoRel: entry.repoRel,
        headingShift: 1,
        skipFirstH1: true,
        inTable: false,
      };
      typ += renderBlocks(doc.tree.children, ctx);
    }
  }

  // Fail fast if any internal PDF link or anchor failed to resolve
  const brokenInternalRefs = [
    ...unresolvedInternalLinks,
    ...referencedLabels.filter((r) => !emittedLabels.has(r.label)),
  ];
  if (brokenInternalRefs.length > 0) {
    highlighter.dispose();
    throw new Error(
      `PDF emitter found ${brokenInternalRefs.length} unresolved internal PDF link(s): ${JSON.stringify(brokenInternalRefs.slice(0, 5))}`,
    );
  }

  fs.mkdirSync(path.dirname(outTypPath), { recursive: true });
  fs.mkdirSync(path.dirname(outPdfPath), { recursive: true });
  fs.writeFileSync(outTypPath, typ, "utf8");
  const tEmit = performance.now() - tEmit0;

  // 5. Compile with Typst (strictly using vendored static TTFs in fonts/typst, zero system fallbacks)
  const resolvedFontPaths = [];
  const defaultTypstFontsDir = path.join(PACKAGE_PDF_DIR, "../fonts/typst");
  const fallbackFontsDir = path.join(PACKAGE_PDF_DIR, "../fonts");
  if (fs.existsSync(defaultTypstFontsDir)) {
    resolvedFontPaths.push(defaultTypstFontsDir);
  } else if (fs.existsSync(fallbackFontsDir)) {
    resolvedFontPaths.push(fallbackFontsDir);
  }
  for (const fp of fontPaths) {
    if (fp && fs.existsSync(fp)) resolvedFontPaths.push(fp);
  }
  if (process.env.TYPST_FONT_PATHS) {
    for (const fp of process.env.TYPST_FONT_PATHS.split(path.delimiter)) {
      if (fp && fs.existsSync(fp)) resolvedFontPaths.push(fp);
    }
  }

  const uniqueFontPaths = [...new Set(resolvedFontPaths)];
  const typstArgs = ["compile", "--ignore-system-fonts", "--root", projectRoot];
  for (const fp of uniqueFontPaths) {
    typstArgs.push("--font-path", fp);
  }
  typstArgs.push(outTypPath, outPdfPath);
  const tTypst0 = performance.now();
  execFileSync(typstBin, typstArgs, { stdio: "inherit" });
  const tTypst = performance.now() - tTypst0;
  const tTotal = performance.now() - tStart;

  highlighter.dispose();

  const typBytes = fs.statSync(outTypPath).size;
  const pdfBytes = fs.statSync(outPdfPath).size;
  const pdfSizeMiB = +(pdfBytes / 1048576).toFixed(2);
  const pages = countPdfPages(outPdfPath);

  for (const dst of copyToPaths) {
    if (!dst) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(outPdfPath, dst);
  }

  if (metaOutPath) {
    fs.mkdirSync(path.dirname(metaOutPath), { recursive: true });
    fs.writeFileSync(
      metaOutPath,
      JSON.stringify(
        {
          pages,
          sizeBytes: pdfBytes,
          sizeMiB: pdfSizeMiB.toFixed(2),
          version,
          chapters: chaptersIncluded,
          filesIncluded: includedDocs.size,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }

  return {
    pages,
    chaptersIncluded,
    filesIncluded: includedDocs.size,
    fontPathsUsed: uniqueFontPaths,
    outTyp: outTypPath,
    outPdf: outPdfPath,
    copiedTo: copyToPaths.filter(Boolean),
    metaOutPath,
    typSizeKiB: +(typBytes / 1024).toFixed(1),
    pdfSizeBytes: pdfBytes,
    pdfSizeMiB,
    timingsMs: {
      shikiInit: +tShikiInit.toFixed(1),
      astAndEmit: +tEmit.toFixed(1),
      typstCompile: +tTypst.toFixed(1),
      total: +tTotal.toFixed(1),
    },
    linkStats,
    brokenInternalRefs: brokenInternalRefs.length,
    unknownNodes: [...unknownNodes],
  };
}

/**
 * Titan-specific preset wrapping `buildBookPdf` for "The Titan Programming Language"
 * (TOC chapters across Parts I–IV, with the Style Guide as the last appendix, plus
 * `doc/language/index.md` as the Preface).
 */
export async function buildTitanBookPdf(options) {
  const {
    langDir,
    docsDir,
    styleGuidePath,
    bookUrlPrefix = "/book",
    version = "0.6.1",
    title = "The Titan Programming Language",
    coverTitle = ["The Titan", "Programming Language"],
    subtitle = "Tutorial, Language Reference, Standard Library, and Toolchain",
    coverSubtitle = ["Tutorial, Language Reference,", "Standard Library, and Toolchain"],
    author = "Fabio Mascarenhas and the Titan Contributors",
    copyrightNotice = "Copyright (c) 2017 The Titan Project Developers",
    keywords = ["Titan", "Lua", "Programming Language", "Manual"],
    edition = `Version ${version}`,
    editionNote,
    sourceNote = "Generated from doc/language/ and doc/style-guide.md.",
    prefaceTitle = "About Titan",
    prefaceKicker = "Preface",
    partSummaries = {
      "Part I":
        "From your first compiled executable to nominal records, closed tagged unions with non-fallthrough coverage analysis, nominal Interfaces, generics, option types, and deterministic cleanup.",
      "Part II":
        "Module boundaries, cooperative async tasks and OS threads, seamless Lua 5.5 interoperability, direct C FFI, and the WebAssembly browser target.",
      "Part III":
        "Complete reference for Titan's twenty-seven standard library modules across strings, parsing, I/O, networking, serialization, databases, reflection, and native tests.",
      "Part IV":
        "Installation on Linux, macOS, and Windows, the titanc toolchain, formal grammar and conversion matrices, design principles, and the Effective Titan Style Guide.",
    },
    siteBase = "https://titan-lang.dev",
    repoUrl = "https://github.com/mascarenhas/titan",
    ...rest
  } = options;

  const toc = parseTitanBookToc({
    docsDir: docsDir || langDir,
    styleGuidePath,
    baseUrl: bookUrlPrefix,
  });
  const chapterCount =
    toc.parts.reduce((count, part) => count + part.entries.length, 0) - (toc.styleGuideEntry ? 1 : 0);

  return buildBookPdf({
    ...rest,
    docsDir: docsDir || langDir,
    repoDocsPrefix: "doc/language",
    bookUrlPrefix,
    toc,
    version,
    title,
    coverTitle,
    subtitle,
    coverSubtitle,
    author,
    copyrightNotice,
    keywords,
    edition,
    editionNote: editionNote || `Titan ${version} (${chapterCount} Chapters + Effective Titan Style Guide).`,
    sourceNote,
    prefaceTitle,
    prefaceKicker,
    partSummaries,
    siteBase,
    repoUrl,
  });
}
