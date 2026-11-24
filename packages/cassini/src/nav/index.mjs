export { parseBookToc, parseTitanBookToc } from "./book-toc.mjs";

export function normalizePathname(href) {
  if (!href) return "/";
  const clean = href.split("#")[0].split("?")[0];
  if (clean === "/") return "/";
  return clean.endsWith("/") ? clean : `${clean}/`;
}

export function flattenSidebar(groups) {
  const flat = [];
  for (const group of groups || []) {
    for (const item of group.items || []) {
      flat.push({ title: item.title, href: item.href });
    }
  }
  return flat;
}

export function findPrevNext(orderedItems, currentHref) {
  const target = normalizePathname(currentHref);
  const idx = orderedItems.findIndex((item) => normalizePathname(item.href) === target);
  if (idx === -1) return { prev: null, next: null };
  return {
    prev: idx > 0 ? orderedItems[idx - 1] : null,
    next: idx + 1 < orderedItems.length ? orderedItems[idx + 1] : null,
  };
}
