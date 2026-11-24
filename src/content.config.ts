import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const bookId = ({ entry }: { entry: string }) => {
  const norm = entry.replace(/\\/g, "/");
  if (norm === "style-guide.md") return "style-guide";
  return norm.replace(/^language\//, "").replace(/\.md$/, "");
};

const vscodeId = ({ entry }: { entry: string }) => {
  const norm = entry.replace(/\\/g, "/").replace(/\.md$/, "");
  return norm === "index" ? "architecture" : norm;
};

const book = defineCollection({
  loader: glob({
    pattern: ["language/**/*.md", "style-guide.md"],
    base: "./.generated/sources/titan/doc",
    generateId: bookId,
  }),
});

const vscode = defineCollection({
  loader: glob({
    pattern: "*.md",
    base: "./.generated/sources/vscode-titan/docs",
    generateId: vscodeId,
  }),
});

const site = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/site",
  }),
});

export const collections = { book, vscode, site };
