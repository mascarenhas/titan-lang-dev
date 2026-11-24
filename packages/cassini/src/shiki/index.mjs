import fs from "node:fs";
import { createHighlighter } from "shiki";
import { cassiniDarkTheme } from "./cassini-dark.mjs";
import { cassiniPrintTheme } from "./cassini-print.mjs";

export { cassiniDarkTheme, cassiniPrintTheme };

/**
 * Normalizes fenced code block language tags to canonical Shiki 4 language IDs.
 * Note: Shiki 4 treats `make` as canonical already (never alias `make -> makefile`).
 */
export const SHIKI_LANG_MAP = {
  titan: "titan",
  lua: "lua",
  sh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  html: "html",
  javascript: "javascript",
  js: "javascript",
  typescript: "typescript",
  ts: "typescript",
  cmd: "bat",
  bat: "bat",
  c: "c",
  cpp: "cpp",
  json: "json",
  jsonc: "jsonc",
  make: "make",
  makefile: "make",
  powershell: "powershell",
  ps1: "powershell",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  markdown: "markdown",
  md: "markdown",
  sql: "sql",
  diff: "diff",
  text: "text",
  txt: "text",
  plain: "text",
  ebnf: "text",
};

/**
 * Loads `syntaxes/titan.tmLanguage.json` for Shiki 4.6 safely.
 * Omits `aliases` so Shiki 4 does not raise `Circular alias 'titan -> titan'`.
 */
export function loadTitanLanguage(grammarPath) {
  const raw = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
  const { aliases: _ignored, ...rest } = raw;
  return {
    ...rest,
    name: "titan",
  };
}

export function normalizeShikiLang(lang) {
  const key = (lang || "text").trim().toLowerCase();
  return SHIKI_LANG_MAP[key] || "text";
}

export const DEFAULT_SHIKI_LANGS = [
  ...new Set(Object.values(SHIKI_LANG_MAP)),
].filter((lang) => lang !== "titan" && lang !== "text");

export async function createCassiniHighlighter({
  grammarPath,
  themes = [cassiniDarkTheme, cassiniPrintTheme],
  langs = DEFAULT_SHIKI_LANGS,
} = {}) {
  const loadedLangs = grammarPath ? [loadTitanLanguage(grammarPath), ...langs] : [...langs];
  return createHighlighter({
    themes,
    langs: loadedLangs,
  });
}
