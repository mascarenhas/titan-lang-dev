// File tabs (strip and mobile scroller) and the drawer: project files with
// create/rename/delete, and the read-only `titan/` standard library tree.
import { copy } from "../content/copy";
import { pathProblem } from "../engine";
import type { Files } from "../types";
import { el, part } from "./dom";
import { BINDINGS, ENTRY } from "./project";

export interface FilesHooks {
  open(path: string): void;
  create(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  addBindings(): void;
  closeLibrary(path: string): void;
  loadLibrary(): Promise<Files>;
  openDrawer(): void;
}

export interface FilesView {
  paths: readonly string[];
  active: string | null;
  library: readonly string[];
  errors: ReadonlySet<string>;
  dirty: ReadonlySet<string>;
  lines(path: string): number;
}

export interface FilesController {
  render(view: FilesView): void;
  startCreate(): void;
}

export function createFiles(root: HTMLElement, hooks: FilesHooks): FilesController {
  const stripTabs = part(root, "file-tabs");
  const mobileTabs = part(root, "mobile-file-tabs");
  const projectTree = part(root, "project-tree");
  const libraryToggle = part<HTMLButtonElement>(root, "stdlib-toggle");
  const libraryTree = part(root, "stdlib-tree");
  let last: FilesView | null = null;
  let editing: { mode: "create" } | { mode: "rename"; path: string } | null = null;
  let library: Files | null = null;

  part(root, "new-file").addEventListener("click", () => startCreate());

  libraryToggle.addEventListener("click", async () => {
    const open = libraryToggle.getAttribute("aria-expanded") !== "true";
    libraryToggle.setAttribute("aria-expanded", String(open));
    libraryTree.hidden = !open;
    if (open && !library) {
      library = await hooks.loadLibrary();
      renderLibrary();
    }
  });

  function renderLibrary() {
    if (!library) return;
    libraryTree.replaceChildren(
      ...Object.keys(library)
        .sort()
        .map((path) => {
          const row = el(
            "li",
            { role: "treeitem", tabindex: "0", "aria-selected": String(last?.active === path) },
            el("span", { class: "pg-tree-icon", "aria-hidden": "true" }, "◇"),
            path.replace(/^titan\//, ""),
          );
          row.addEventListener("click", () => hooks.open(path));
          row.addEventListener("keydown", (event) => event.key === "Enter" && hooks.open(path));
          return row;
        }),
    );
  }

  function tab(path: string, view: FilesView, readOnly: boolean): HTMLElement {
    const classes = ["pg-file-tab"];
    if (view.errors.has(path)) classes.push("has-error");
    if (view.dirty.has(path)) classes.push("is-dirty");
    if (readOnly) classes.push("is-library");
    const button = el(
      "button",
      { type: "button", role: "tab", class: classes.join(" "), "aria-selected": String(view.active === path), title: path },
      el("span", { class: "pg-dot", "aria-hidden": "true" }),
      readOnly ? path.slice(path.lastIndexOf("/") + 1) : path,
    );
    button.addEventListener("click", () => hooks.open(path));
    if (!readOnly) return button;
    const close = el("button", { type: "button", class: "pg-tab-close", "aria-label": `Close ${path}` }, "×");
    close.addEventListener("click", () => hooks.closeLibrary(path));
    return el("span", { class: "pg-file-tab-wrap" }, button, close);
  }

  /** The live name input; re-renders keep this element so typing and focus survive. */
  let editRow: HTMLElement | null = null;

  function inputRow(initial: string, commit: (path: string) => void): HTMLElement {
    if (editRow) return editRow;
    const input = el("input", { class: "pg-tree-input", value: initial, spellcheck: "false", "aria-label": copy.toolbar.newFile });
    const problem = el("span", { class: "pg-tree-problem", role: "alert" });
    const row = el("li", { class: "pg-tree-edit" }, input, problem);
    editRow = row;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      const path = input.value.trim();
      if (save && path !== initial) {
        const others = (last?.paths ?? []).filter((existing) => existing !== initial);
        const reason = pathProblem(path, others);
        if (reason) {
          problem.textContent = copy.files.invalidPath(reason);
          input.focus();
          return;
        }
        done = true;
        editing = null;
        editRow = null;
        commit(path);
        return;
      }
      done = true;
      editing = null;
      editRow = null;
      if (last) render(last);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
    queueMicrotask(() => {
      input.focus();
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    });
    return row;
  }

  function projectRow(path: string, view: FilesView): HTMLElement {
    if (editing?.mode === "rename" && editing.path === path) {
      return inputRow(path, (to) => hooks.rename(path, to));
    }
    const actions: HTMLElement[] = [];
    if (path !== ENTRY) {
      const rename = el("button", { type: "button", class: "pg-tree-action", title: copy.files.rename, "aria-label": `${copy.files.rename} ${path}` }, "✎");
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        editing = { mode: "rename", path };
        render(view);
      });
      const remove = el("button", { type: "button", class: "pg-tree-action", title: copy.files.remove, "aria-label": `${copy.files.remove} ${path}` }, "×");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        if (window.confirm(copy.files.removeConfirm(path))) hooks.remove(path);
      });
      actions.push(rename, remove);
    }
    const row = el(
      "li",
      {
        role: "treeitem",
        tabindex: "0",
        "aria-selected": String(view.active === path),
        class: view.errors.has(path) ? "has-error" : undefined,
      },
      el("span", { class: "pg-tree-icon", "aria-hidden": "true" }, path.endsWith(".titan") ? "◇" : "◆"),
      el("span", { class: "pg-tree-name" }, path),
      el("span", { class: "pg-tree-meta" }, copy.files.lines(view.lines(path))),
      ...actions,
    );
    row.addEventListener("click", () => hooks.open(path));
    row.addEventListener("keydown", (event) => event.key === "Enter" && event.target === row && hooks.open(path));
    return row;
  }

  function render(view: FilesView) {
    last = view;
    const tabs = (target: HTMLElement, withActions: boolean) => {
      target.replaceChildren(
        ...view.paths.map((path) => tab(path, view, false)),
        ...view.library.map((path) => tab(path, view, true)),
      );
      if (!withActions) return;
      const add = el("button", { type: "button", class: "pg-file-tab pg-file-add", title: copy.toolbar.newFile, "aria-label": copy.toolbar.newFile }, "+");
      add.addEventListener("click", () => startCreate());
      target.append(add);
      if (!view.paths.includes(BINDINGS)) {
        const bindings = el("button", { type: "button", class: "pg-file-tab pg-file-add", title: copy.toolbar.addBindingsHint }, copy.toolbar.addBindings);
        bindings.addEventListener("click", () => hooks.addBindings());
        target.append(bindings);
      }
    };
    tabs(stripTabs, true);
    tabs(mobileTabs, false);
    const rows = view.paths.map((path) => projectRow(path, view));
    if (editing?.mode === "create") rows.push(inputRow("", (path) => hooks.create(path)));
    projectTree.replaceChildren(...rows);
    renderLibrary();
  }

  function startCreate() {
    hooks.openDrawer();
    editing = { mode: "create" };
    if (last) render(last);
  }

  return { render, startCreate };
}
