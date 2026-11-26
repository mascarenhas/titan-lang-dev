// The example gallery: a popover from the serif example title, one column per
// category, each entry naming what it teaches and linking its Book chapter.
import { copy } from "../content/copy";
import type { ExampleDefinition } from "../types";
import { el } from "./dom";
import { bindPopover } from "./popover";

const CATEGORIES: ExampleDefinition["category"][] = ["Language", "Runtime", "Browser"];

export interface GalleryController {
  select(slug: string | null): void;
}

export function createGallery(
  popover: HTMLElement,
  trigger: HTMLButtonElement,
  examples: readonly ExampleDefinition[],
  choose: (example: ExampleDefinition) => void,
): GalleryController {
  const items = new Map<string, HTMLElement>();
  const disclosure = bindPopover(popover, trigger, () =>
    popover.querySelector<HTMLElement>("li[aria-current] .pg-gallery-pick, .pg-gallery-pick")?.focus(),
  );
  const columns = CATEGORIES.map((category) => {
    const list = el("ul", {});
    for (const example of examples.filter((candidate) => candidate.category === category)) {
      const pick = el(
        "button",
        { type: "button", class: "pg-gallery-pick" },
        el("b", {}, example.title),
        el("span", {}, example.summary),
      );
      pick.addEventListener("click", () => {
        disclosure.close();
        choose(example);
      });
      const item = el(
        "li",
        {},
        pick,
        el("a", { class: "pg-gallery-book", href: example.bookLink }, `${copy.gallery.openBook} ↗`),
      );
      items.set(example.slug, item);
      list.append(item);
    }
    return el("div", {}, el("h4", { class: "pg-kicker" }, category), list);
  });
  popover.replaceChildren(
    el("div", { class: "pg-gallery-grid" }, ...columns),
    el("div", { class: "pg-gallery-foot" }, copy.gallery.footnote),
  );

  return {
    select(slug) {
      for (const [key, item] of items) item.toggleAttribute("aria-current", key === slug);
    },
  };
}
