import fs from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";

const mdParser = unified().use(remarkParse).use(remarkGfm);

function walkMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMdFiles(abs));
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out.sort();
}

function readFirstH1(absPath, fallback) {
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    const m = raw.match(/^#\s+(.+)$/m);
    if (m) return m[1].replace(/`([^`]+)`/g, "$1").trim();
  } catch {
    // Use fallback title
  }
  return fallback;
}

function matchesRule(rule, text, depth) {
  if (typeof rule === "function") return Boolean(rule(text, depth));
  if (rule instanceof RegExp) return rule.test(text);
  if (typeof rule === "string") return text.startsWith(rule);
  return false;
}

function defaultFormatEntry({ part, cells, linkCellIndex, indexTitle }) {
  const firstCell = cells[0] || "";
  const hasLeadingNumber =
    linkCellIndex > 0 && /^[0-9A-Z]+(?:\.[0-9]+)?$/.test(firstCell);
  if (hasLeadingNumber) {
    return {
      kicker: `Chapter ${firstCell}`,
      badge: firstCell,
      title: indexTitle,
    };
  }
  const shortPart = part.title.replace(/^Part\s+[IVXLCDM0-9]+\s*[—:-]\s*/i, "").trim();
  return {
    kicker: shortPart ? `${shortPart} · ${indexTitle}` : indexTitle,
    badge: "",
    title: indexTitle,
  };
}

/**
 * Parses a Markdown book/manual index (e.g. `doc/language/index.md` or
 * `mk/doc/index.md`) into structured Parts, chapters, optional companion
 * appendices, optional supplemental folder group, sidebar groups, and
 * prev/next reading order.
 *
 * Shared by both Astro HTML layouts and the Typst PDF book builder.
 */
export function parseBookToc({
  docsDir,
  langDir,
  indexFile = "index.md",
  repoDocsPrefix = "doc",
  baseUrl = "/book",
  overviewGroupTitle = "Overview",
  overviewItemTitle,
  partHeadingDepths = [2, 3],
  subgroupHeadingDepth,
  partMatcher = /^Part(?:\s|\u2014|—)/i,
  formatEntry = defaultFormatEntry,
  appendices = [],
  supplementalGroup = null,
} = {}) {
  const rootDir = docsDir || langDir;
  if (!rootDir) {
    throw new Error("parseBookToc requires `docsDir`");
  }
  const normalizedPrefix = repoDocsPrefix.replace(/^\/+|\/+$/g, "");
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const allowedDepths = new Set(
    Array.isArray(partHeadingDepths) ? partHeadingDepths : [partHeadingDepths],
  );

  const indexPath = path.join(rootDir, indexFile);
  const raw = fs.readFileSync(indexPath, "utf8");
  const tree = mdParser.parse(raw);
  const resolvedOverviewTitle =
    overviewItemTitle || readFirstH1(indexPath, overviewGroupTitle);

  const parts = [];
  let currentPart = null;
  let currentPartDepth = null;
  let currentSubgroup = null;

  for (const node of tree.children) {
    if (node.type === "heading") {
      const text = toString(node).trim();
      if (allowedDepths.has(node.depth) && matchesRule(partMatcher, text, node.depth)) {
        currentPart = { title: text, entries: [] };
        currentPartDepth = node.depth;
        currentSubgroup = null;
        parts.push(currentPart);
      } else if (
        currentPart &&
        node.depth === (subgroupHeadingDepth ?? currentPartDepth + 1)
      ) {
        currentSubgroup = text;
      } else if (currentPart && node.depth <= currentPartDepth) {
        // Exited the parts section into a sibling/parent heading (e.g. "## Explicit Scope Boundaries")
        currentPart = null;
        currentPartDepth = null;
        currentSubgroup = null;
      }
    } else if (node.type === "table" && currentPart) {
      for (const row of node.children.slice(1)) {
        const cells = row.children.map((c) => toString(c).trim());
        let linkNode = null;
        let linkCellIndex = -1;
        for (let ci = 0; ci < Math.min(2, row.children.length); ci++) {
          visit(row.children[ci], "link", (l) => {
            if (!linkNode) {
              linkNode = l;
              linkCellIndex = ci;
            }
          });
        }
        if (!linkNode || !linkNode.url) continue;

        const rel = linkNode.url.split("#")[0];
        if (!rel.endsWith(".md") || /^https?:\/\//i.test(rel)) continue;
        const slug = rel.replace(/\.md$/i, "");
        const indexTitle = toString(linkNode).trim();
        const repoRel = normalizedPrefix
          ? path.posix.normalize(path.posix.join(normalizedPrefix, rel))
          : path.posix.normalize(rel);

        const formatted = formatEntry({
          part: currentPart,
          partIndex: parts.length - 1,
          cells,
          linkNode,
          linkCellIndex,
          rel,
          indexTitle,
          subgroup: currentSubgroup,
        });

        currentPart.entries.push({
          rel,
          repoRel,
          absPath: path.join(rootDir, rel),
          slug,
          href: `${normalizedBaseUrl}/${slug}/`,
          kicker: formatted.kicker ?? "",
          badge: formatted.badge ?? "",
          title: formatted.title ?? indexTitle,
          subgroup: currentSubgroup,
          summary: cells[cells.length - 1] || "",
        });
      }
    }
  }

  // Optional companion appendices (e.g. Titan Style Guide as Appendix E)
  const addedAppendices = [];
  for (const app of appendices || []) {
    if (!app?.absPath || !fs.existsSync(app.absPath)) continue;
    const fullTitle = app.fullTitle || readFirstH1(app.absPath, app.title || app.slug);
    const entry = {
      rel: app.rel || path.relative(rootDir, app.absPath).split(path.sep).join("/"),
      repoRel: app.repoRel,
      absPath: app.absPath,
      slug: app.slug,
      href: app.href || `${normalizedBaseUrl}/${app.slug}/`,
      kicker: app.kicker || "",
      badge: app.badge || "",
      title: app.title || fullTitle,
      fullTitle,
      subgroup: app.subgroup ?? null,
      summary: app.summary || "",
    };
    addedAppendices.push(entry);
    const targetPart = app.targetPartMatcher
      ? parts.find((p) => matchesRule(app.targetPartMatcher, p.title, 0))
      : null;
    if (targetPart) {
      targetPart.entries.push(entry);
    } else {
      parts.push({ title: app.fallbackPartTitle || "Companion", entries: [entry] });
    }
  }

  // Optional supplemental directory group (HTML sidebar only; linked online from PDF)
  let supplementalEntries = [];
  if (supplementalGroup?.dir) {
    const supDir = path.join(rootDir, supplementalGroup.dir);
    const rawFiles = walkMdFiles(supDir).map((abs) => ({
      abs,
      rel: path.relative(rootDir, abs).split(path.sep).join("/"),
    }));
    if (typeof supplementalGroup.sort === "function") {
      rawFiles.sort(supplementalGroup.sort);
    }
    supplementalEntries = rawFiles.map(({ abs, rel }) => {
      const slug = rel.replace(/\.md$/i, "");
      const repoRel = normalizedPrefix
        ? path.posix.normalize(path.posix.join(normalizedPrefix, rel))
        : path.posix.normalize(rel);
      const fallbackTitle = readFirstH1(abs, path.posix.basename(slug));
      const formatted =
        typeof supplementalGroup.formatEntry === "function"
          ? supplementalGroup.formatEntry({ abs, rel, slug, fallbackTitle })
          : { title: fallbackTitle, subgroup: undefined };
      return {
        rel,
        repoRel,
        absPath: abs,
        slug,
        href: `${normalizedBaseUrl}/${slug}/`,
        title: formatted.title ?? fallbackTitle,
        subgroup: formatted.subgroup,
      };
    });
  }

  const indexRepoRel = normalizedPrefix
    ? path.posix.normalize(path.posix.join(normalizedPrefix, indexFile))
    : path.posix.normalize(indexFile);
  const indexEntry = {
    rel: indexFile,
    repoRel: indexRepoRel,
    absPath: indexPath,
    slug: indexFile.replace(/\.md$/i, ""),
    href: `${normalizedBaseUrl}/`,
    title: resolvedOverviewTitle,
  };

  // Build Sidebar groups for HTML reader
  const sidebarGroups = [
    {
      title: overviewGroupTitle,
      collapsed: false,
      items: [{ title: resolvedOverviewTitle, href: `${normalizedBaseUrl}/` }],
    },
    ...parts.map((part) => ({
      title: part.title,
      collapsed: false,
      items: part.entries.map((e) => ({
        title: e.badge ? `${e.badge}. ${e.title}` : e.title,
        href: e.href,
        subgroup: e.subgroup || undefined,
      })),
    })),
  ];

  if (supplementalEntries.length > 0 && supplementalGroup) {
    sidebarGroups.push({
      title: supplementalGroup.title || "Reference",
      collapsed: supplementalGroup.collapsed ?? true,
      items: supplementalEntries.map((e) => ({
        title: e.title,
        href: e.href,
        subgroup: e.subgroup || undefined,
      })),
    });
  }

  // Flat prev/next reading order
  const readingOrder = [
    { title: resolvedOverviewTitle, href: `${normalizedBaseUrl}/` },
    ...parts.flatMap((p) =>
      p.entries.map((e) => ({
        title: e.badge ? `${e.badge}. ${e.title}` : e.title,
        href: e.href,
      })),
    ),
    ...supplementalEntries.map((e) => ({ title: e.title, href: e.href })),
  ];

  return {
    indexEntry,
    parts,
    appendices: addedAppendices,
    supplementalEntries,
    sidebarGroups,
    readingOrder,
  };
}

/**
 * Titan-specific preset wrapping `parseBookToc` for `doc/language/index.md`
 * (50 TOC chapters across Parts I–IV + Style Guide as Appendix E + `uv/` reference).
 */
export function parseTitanBookToc({
  langDir,
  docsDir,
  styleGuidePath,
  baseUrl = "/book",
} = {}) {
  const toc = parseBookToc({
    docsDir: docsDir || langDir,
    indexFile: "index.md",
    repoDocsPrefix: "doc/language",
    baseUrl,
    overviewGroupTitle: "Book Overview",
    overviewItemTitle: "The Titan Programming Language",
    partHeadingDepths: [3],
    partMatcher: /^Part\s/,
    formatEntry: ({ part, cells, indexTitle }) => {
      if (/^Part I(?:\s|\u2014|—)/.test(part.title)) {
        return { kicker: `Chapter ${cells[0]}`, badge: cells[0], title: indexTitle };
      }
      if (/^Part II(?:\s|\u2014|—)/.test(part.title)) {
        return { kicker: `Chapter ${cells[0]}`, badge: cells[0], title: indexTitle };
      }
      if (/^Part III(?:\s|\u2014|—)/.test(part.title)) {
        return { kicker: `Standard Library · ${cells[0]}`, badge: "", title: indexTitle };
      }
      if (/^Part IV(?:\s|\u2014|—)/.test(part.title)) {
        return { kicker: `Appendix ${cells[0]}`, badge: cells[0], title: indexTitle };
      }
      return { kicker: "", badge: "", title: indexTitle };
    },
    appendices: styleGuidePath
      ? [
          {
            rel: "../style-guide.md",
            repoRel: "doc/style-guide.md",
            absPath: styleGuidePath,
            slug: "style-guide",
            kicker: "Appendix E · Companion",
            badge: "E",
            title: "Style Guide",
            summary: "Idiomatic conventions for writing clear, predictable Titan code.",
            targetPartMatcher: /^Part IV(?:\s|\u2014|—)/,
          },
        ]
      : [],
    supplementalGroup: {
      dir: "uv",
      title: "Low-Level libuv Reference",
      collapsed: true,
      sort: (a, b) => {
        const rank = (r) => {
          if (!r.slice(3).includes("/")) return 0;
          if (r.startsWith("uv/examples/")) return 1;
          return 2;
        };
        const dr = rank(a.rel) - rank(b.rel);
        return dr !== 0 ? dr : a.rel.localeCompare(b.rel);
      },
      formatEntry: ({ rel, slug, fallbackTitle }) => ({
        title: rel.startsWith("uv/functions/")
          ? `uv.${path.posix.basename(slug)}`
          : rel === "uv/examples/README.md"
            ? "Examples Index"
            : fallbackTitle.replace(/^titan\.uv\s*[—:-]\s*/i, ""),
        subgroup: rel.startsWith("uv/functions/") ? "Functions" : "Overview & Policies",
      }),
    },
  });

  return {
    ...toc,
    styleGuideEntry: toc.appendices[0] || null,
    uvEntries: toc.supplementalEntries,
  };
}
