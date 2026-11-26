#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitanBookPdf } from "@titan-lang/cassini/pdf";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, "sources.json"), "utf8"));

const outPdfPath = path.join(ROOT, ".generated/pdf/titan-programming-language.pdf");
const publicPdfPath = path.join(ROOT, "public/titan-programming-language.pdf");
const distDir = path.join(ROOT, "dist");
const copyToPaths = [publicPdfPath];
if (fs.existsSync(distDir)) {
  copyToPaths.push(path.join(distDir, "titan-programming-language.pdf"));
}

const result = await buildTitanBookPdf({
  projectRoot: ROOT,
  docsDir: path.join(ROOT, ".generated/sources/titan/doc/language"),
  styleGuidePath: path.join(ROOT, ".generated/sources/titan/doc/style-guide.md"),
  logoPath: path.join(ROOT, ".generated/sources/titan/doc/images/titan-logo.svg"),
  grammarPath: path.join(ROOT, ".generated/sources/vscode-titan/syntaxes/titan.tmLanguage.json"),
  outTypPath: path.join(ROOT, ".generated/pdf/titan-programming-language.typ"),
  outPdfPath,
  metaOutPath: path.join(ROOT, ".generated/pdf-meta.json"),
  copyToPaths,
  siteBase: "https://titan-lang.dev",
  repoUrl: `https://github.com/${sources.titan.repo}`,
  repoSha: sources.titan.sha,
  version: sources.titan.version,
  title: "The Titan Programming Language",
  coverTitle: ["The Titan", "Programming Language"],
  subtitle: "Tutorial, Language Reference, Standard Library, and Toolchain",
  coverSubtitle: ["Tutorial, Language Reference,", "Standard Library, and Toolchain"],
  author: "Fabio Mascarenhas and the Titan Contributors",
  copyrightNotice: "Copyright (c) 2017 The Titan Project Developers",
  keywords: ["Titan", "Lua", "Programming Language", "Manual"],
  edition: `Version ${sources.titan.version}`,
  sourceNote: "Generated from doc/language/ and doc/style-guide.md.",
  prefaceTitle: "About Titan",
  prefaceKicker: "Preface",
});

console.log("[build-pdf] Built PDF monograph:\n" + JSON.stringify(result, null, 2));
