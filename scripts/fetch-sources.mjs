#!/usr/bin/env node
/**
 * Fetches pinned upstream documentation & grammar assets declared in sources.json
 * into gitignored `.generated/sources/` and syncs `public/assets/titan-logo.svg`.
 *
 * Modes:
 *   Default (CI & fresh clone): immutable GitHub commit-SHA tarballs cached in `.generated/cache/`
 *   Local override (dev/preview):
 *     --titan-dir <path>  / TITAN_LOCAL_DIR
 *     --titan-ref <ref>   / TITAN_LOCAL_REF  (optional; uses `git archive <ref>` when set)
 *     --vscode-dir <path> / VSCODE_TITAN_LOCAL_DIR
 *     --vscode-ref <ref>  / VSCODE_TITAN_LOCAL_REF (defaults to `origin/main`; always reads via `git archive` so working branch is untouched!)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { escapeTableInlineCodePipes } from "@titan-lang/cassini/markdown";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_JSON_PATH = path.join(ROOT, "sources.json");
const GENERATED_DIR = path.join(ROOT, ".generated");
const CACHE_DIR = path.join(GENERATED_DIR, "cache");
const SOURCES_DIR = path.join(GENERATED_DIR, "sources");
const STAMP_PATH = path.join(SOURCES_DIR, ".stamp.json");

function expandHome(p) {
  if (!p) return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const opts = {
    titanDir: expandHome(process.env.TITAN_LOCAL_DIR || ""),
    titanRef: process.env.TITAN_LOCAL_REF || "",
    vscodeDir: expandHome(process.env.VSCODE_TITAN_LOCAL_DIR || ""),
    vscodeRef: process.env.VSCODE_TITAN_LOCAL_REF || "",
    force: process.env.FETCH_SOURCES_FORCE === "1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--titan-dir" && argv[i + 1]) opts.titanDir = expandHome(argv[++i]);
    else if (a === "--titan-ref" && argv[i + 1]) opts.titanRef = argv[++i];
    else if (a === "--vscode-dir" && argv[i + 1]) opts.vscodeDir = expandHome(argv[++i]);
    else if (a === "--vscode-ref" && argv[i + 1]) opts.vscodeRef = argv[++i];
    else if (a === "--force") opts.force = true;
  }
  return opts;
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function extractViaGitArchive(repoDir, ref, relPaths, destDir) {
  const absRepo = path.resolve(repoDir);
  if (!fs.existsSync(absRepo)) {
    throw new Error(`Local repository directory does not exist: ${absRepo}`);
  }
  resetDir(destDir);
  const gitArchive = spawnSync(
    "git",
    ["-C", absRepo, "archive", "--format=tar", ref, "--", ...relPaths],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  if (gitArchive.status !== 0) {
    throw new Error(
      `git -C ${absRepo} archive ${ref} failed (${gitArchive.status}): ${gitArchive.stderr?.toString("utf8") || ""}`,
    );
  }
  const tarExtract = spawnSync("tar", ["-xf", "-", "-C", destDir], {
    input: gitArchive.stdout,
  });
  if (tarExtract.status !== 0) {
    throw new Error(
      `tar extract into ${destDir} failed (${tarExtract.status}): ${tarExtract.stderr?.toString("utf8") || ""}`,
    );
  }
  const resolvedSha = execFileSync("git", ["-C", absRepo, "rev-parse", `${ref}^{commit}`], {
    encoding: "utf8",
  }).trim();
  return { mode: "git-archive", repoDir: absRepo, ref, sha: resolvedSha };
}

function copyFromLocalWorkingTree(repoDir, relPaths, destDir) {
  const absRepo = path.resolve(repoDir);
  if (!fs.existsSync(absRepo)) {
    throw new Error(`Local directory does not exist: ${absRepo}`);
  }
  resetDir(destDir);
  for (const rel of relPaths) {
    const src = path.join(absRepo, rel);
    const dst = path.join(destDir, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`Expected path missing in local checkout: ${src}`);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  let headSha = "local";
  try {
    headSha = execFileSync("git", ["-C", absRepo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Non-git directory is fine
  }
  return { mode: "local-copy", repoDir: absRepo, sha: headSha };
}

async function downloadTarball(url, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.tmp-${process.pid}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "titan-lang-dev-fetch-sources/1.0" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, destFile);
}

async function extractFromGithubTarball(key, spec, destDir) {
  const tarPath = path.join(CACHE_DIR, `${key}-${spec.sha}.tar.gz`);
  if (!fs.existsSync(tarPath) || fs.statSync(tarPath).size === 0) {
    const url = `https://github.com/${spec.repo}/archive/${spec.sha}.tar.gz`;
    console.log(`[fetch-sources] Downloading ${spec.repo}@${spec.sha.slice(0, 10)}...`);
    await downloadTarball(url, tarPath);
  }
  // Discover top-level archive prefix (e.g. "titan-704d4814...")
  const listing = execFileSync("tar", ["-tzf", tarPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const firstEntry = listing.split("\n").find((l) => l.trim().length > 0);
  if (!firstEntry) throw new Error(`Empty tarball: ${tarPath}`);
  const prefix = firstEntry.split("/")[0];

  resetDir(destDir);
  const tarEntries = spec.paths.map((p) => `${prefix}/${p.replace(/^\/+/, "")}`);
  execFileSync("tar", ["-xzf", tarPath, "--strip-components=1", "-C", destDir, ...tarEntries], {
    stdio: "inherit",
  });
  return { mode: "github-tarball", repo: spec.repo, sha: spec.sha, ref: spec.ref };
}

function syncPublicLogo() {
  const srcLogo = path.join(SOURCES_DIR, "titan/doc/images/titan-logo.svg");
  const dstLogo = path.join(ROOT, "public/assets/titan-logo.svg");
  if (!fs.existsSync(srcLogo)) {
    throw new Error(`Missing fetched Titan logo at ${srcLogo}`);
  }
  fs.mkdirSync(path.dirname(dstLogo), { recursive: true });
  fs.copyFileSync(srcLogo, dstLogo);
}

function syncPublicWebFonts() {
  const srcFontsDir = path.join(ROOT, "packages/cassini/src/fonts/web");
  const dstFontsDir = path.join(ROOT, "public/fonts");
  if (!fs.existsSync(srcFontsDir)) {
    throw new Error(`Missing vendored web fonts directory at ${srcFontsDir}`);
  }
  const woff2Files = fs
    .readdirSync(srcFontsDir)
    .filter((name) => name.endsWith(".woff2"))
    .sort();
  if (woff2Files.length === 0) {
    throw new Error(`No .woff2 files found in ${srcFontsDir}`);
  }
  fs.rmSync(dstFontsDir, { recursive: true, force: true });
  fs.mkdirSync(dstFontsDir, { recursive: true });
  for (const name of woff2Files) {
    fs.copyFileSync(path.join(srcFontsDir, name), path.join(dstFontsDir, name));
  }
  const srcLicense = path.join(ROOT, "packages/cassini/src/fonts/LICENSES.txt");
  if (!fs.existsSync(srcLicense)) {
    throw new Error(`Missing vendored font license file at ${srcLicense}`);
  }
  fs.copyFileSync(srcLicense, path.join(dstFontsDir, "LICENSES.txt"));
}

function normalizeStagedMarkdownTables(dir) {
  if (!fs.existsSync(dir)) return 0;
  let fixedFiles = 0;
  const walk = (cur) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const raw = fs.readFileSync(full, "utf8");
        const normalized = escapeTableInlineCodePipes(raw);
        if (normalized !== raw) {
          fs.writeFileSync(full, normalized, "utf8");
          fixedFiles++;
        }
      }
    }
  };
  walk(dir);
  return fixedFiles;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawSources = fs.readFileSync(SOURCES_JSON_PATH, "utf8");
  const sources = JSON.parse(rawSources);
  const sourcesHash = crypto.createHash("sha256").update(rawSources).digest("hex");

  const isLocalMode = Boolean(opts.titanDir || opts.vscodeDir);
  const titanDest = path.join(SOURCES_DIR, "titan");
  const vscodeDest = path.join(SOURCES_DIR, "vscode-titan");

  // Always keep public/fonts/*.woff2 synced from vendored @titan-lang/cassini web fonts
  syncPublicWebFonts();

  // Fast no-op when already fetched for matching sources.json in default GitHub mode
  if (!isLocalMode && !opts.force && fs.existsSync(STAMP_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(STAMP_PATH, "utf8"));
      const sentinelsOk =
        fs.existsSync(path.join(titanDest, "doc/language/index.md")) &&
        fs.existsSync(path.join(titanDest, "doc/style-guide.md")) &&
        fs.existsSync(path.join(vscodeDest, "syntaxes/titan.tmLanguage.json")) &&
        fs.existsSync(path.join(ROOT, "public/assets/titan-logo.svg")) &&
        fs.existsSync(path.join(ROOT, "public/fonts/IBMPlexSans-Regular.woff2")) &&
        fs.existsSync(path.join(ROOT, "public/fonts/LICENSES.txt"));
      if (prev.sourcesHash === sourcesHash && prev.mode === "github" && sentinelsOk) {
        normalizeStagedMarkdownTables(SOURCES_DIR);
        console.log(`[fetch-sources] Up to date (${sources.titan.ref}, vscode@${sources.vscodeTitan.sha.slice(0, 7)})`);
        return;
      }
    } catch {
      // Re-fetch cleanly if stamp is unreadable
    }
  }

  fs.mkdirSync(SOURCES_DIR, { recursive: true });

  // 1. Titan docs + logo
  let titanMeta;
  if (opts.titanDir) {
    if (opts.titanRef) {
      titanMeta = extractViaGitArchive(opts.titanDir, opts.titanRef, sources.titan.paths, titanDest);
      console.log(`[fetch-sources] titan <- git archive ${opts.titanDir} (${opts.titanRef} @ ${titanMeta.sha.slice(0, 7)})`);
    } else {
      titanMeta = copyFromLocalWorkingTree(opts.titanDir, sources.titan.paths, titanDest);
      console.log(`[fetch-sources] titan <- local copy ${opts.titanDir} (${titanMeta.sha.slice(0, 7)})`);
    }
  } else {
    titanMeta = await extractFromGithubTarball("titan", sources.titan, titanDest);
    console.log(`[fetch-sources] titan <- GitHub ${sources.titan.repo}@${sources.titan.sha.slice(0, 7)}`);
  }

  // 2. vscode-titan docs + TextMate grammar
  // Always read local vscode-titan via `git archive` (defaulting to origin/main)
  // so a maintainer's checked-out working branch is never silently copied.
  let vscodeMeta;
  if (opts.vscodeDir) {
    const vscodeRef = opts.vscodeRef || "origin/main";
    vscodeMeta = extractViaGitArchive(opts.vscodeDir, vscodeRef, sources.vscodeTitan.paths, vscodeDest);
    console.log(`[fetch-sources] vscode-titan <- git archive ${opts.vscodeDir} (${vscodeRef} @ ${vscodeMeta.sha.slice(0, 7)})`);
  } else {
    vscodeMeta = await extractFromGithubTarball("vscode-titan", sources.vscodeTitan, vscodeDest);
    console.log(`[fetch-sources] vscode-titan <- GitHub ${sources.vscodeTitan.repo}@${sources.vscodeTitan.sha.slice(0, 7)}`);
  }

  syncPublicLogo();
  const normalizedCount = normalizeStagedMarkdownTables(SOURCES_DIR);
  if (normalizedCount > 0) {
    console.log(`[fetch-sources] Escaped unescaped table backtick pipes in ${normalizedCount} staged Markdown file(s)`);
  }

  fs.writeFileSync(
    STAMP_PATH,
    JSON.stringify(
      {
        mode: isLocalMode ? "local" : "github",
        sourcesHash,
        fetchedAt: new Date().toISOString(),
        titan: titanMeta,
        vscodeTitan: vscodeMeta,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

main().catch((err) => {
  console.error("[fetch-sources] ERROR:", err.message || err);
  process.exit(1);
});
