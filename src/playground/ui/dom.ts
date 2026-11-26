// Element construction for the playground UI. Children are text or nodes, so
// program output, file names and compiler messages are never parsed as markup.

export type Child = Node | string | null | undefined | false;
export type Attributes = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  element.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  return element;
}

/** Looks up a server-rendered playground element by its `data-pg` name. */
export function part<T extends HTMLElement = HTMLElement>(root: ParentNode, name: string): T {
  const element = root.querySelector<T>(`[data-pg="${name}"]`);
  if (!element) throw new Error(`playground markup is missing [data-pg="${name}"]`);
  return element;
}
