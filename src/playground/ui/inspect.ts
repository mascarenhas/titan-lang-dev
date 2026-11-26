// Inspect: titanc's generated C, cross-linked to Titan lines through its
// `#line` regions, plus the linked image's real Wasm section sizes.
import { EditorState, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, lineNumbers } from "@codemirror/view";
import { copy } from "../content/copy";
import type { Build, Emit } from "../types";
import { cLanguage } from "./c-language";
import { el, part } from "./dom";
import { formatBytes, formatMiB } from "./format";
import { cassiniEditorTheme, cassiniHighlighting } from "./highlight";

/** The Titan source position a generated C line belongs to. */
interface SourceLine {
  path: string;
  line: number;
}

/**
 * Maps each C line to the Titan line of the `#line` region it sits in. titanc
 * opens a region per statement, so every row up to the next directive belongs
 * to that statement (rather than counting upward as a C compiler does). A
 * directive naming anything but a `.titan` file, such as
 * `#line 1 TITAN_GENERATED_C_FILE`, starts generated code with no source.
 */
function sourceRegions(c: string): (SourceLine | null)[] {
  const regions: (SourceLine | null)[] = [];
  let current: SourceLine | null = null;
  for (const text of c.split("\n")) {
    const directive = /^\s*#line\s+(\d+)(?:\s+("[^"]*"|\S+))?/.exec(text);
    if (directive) {
      const line = Number(directive[1]);
      const file = directive[2] === undefined ? undefined : /^"(?:\.\/)?([^"]+\.titan)"$/.exec(directive[2])?.[1];
      if (directive[2] === undefined) current = current && { path: current.path, line };
      else current = file ? { path: file, line } : null;
    }
    regions.push(current);
  }
  return regions;
}

const setLinked = StateEffect.define<readonly number[]>();
const linkedLine = Decoration.line({ class: "pg-line-linked" });

class LinkedGutter extends GutterMarker {
  elementClass = "pg-gutter-linked";
}
const linkedGutter = new LinkedGutter();

const linkedField = StateField.define<readonly number[]>({
  create: () => [],
  update: (lines, tr) => tr.effects.find((effect) => effect.is(setLinked))?.value ?? lines,
  provide: (field) => [
    EditorView.decorations.compute([field], (state) =>
      Decoration.set(state.field(field).map((line) => linkedLine.range(state.doc.line(line).from))),
    ),
    gutterLineClass.compute([field], (state) =>
      RangeSet.of(state.field(field).map((line) => linkedGutter.range(state.doc.line(line).from))),
    ),
  ],
});

const SECTION_COLORS = [
  "var(--pg-seg-compile)",
  "var(--pg-seg-check)",
  "var(--pg-seg-run)",
  "var(--pg-seg-link)",
  "var(--syntax-special)",
  "var(--accent-sage-dim)",
  "var(--ink-faint)",
];

export interface InspectHooks {
  revealSource(path: string, line: number): void;
  download(): void;
}

export interface InspectController {
  showEmit(emit: Emit | null): void;
  showBuild(build: Build | null): void;
  /** Highlights the C rows generated for a Titan line. */
  followSource(path: string, line: number): void;
  /** Labels the shown C and Wasm as coming from an earlier revision. */
  setStale(emit: boolean, build: boolean): void;
}

export function createInspect(root: HTMLElement, hooks: InspectHooks): InspectController {
  const chips = part(root, "inspect-chips");
  const hint = part(root, "inspect-hint");
  const code = part(root, "inspect-code");
  const empty = part(root, "inspect-empty");
  const wasm = part(root, "inspect-wasm");
  const staleEmit = part(root, "inspect-stale");
  let buildStale = false;

  let emit: Emit | null = null;
  let activeKey: string | null = null;
  let regions: (SourceLine | null)[] = [];
  let followed: SourceLine | null = null;
  const regionsByKey = new Map<string, (SourceLine | null)[]>();

  function regionsOf(key: string): (SourceLine | null)[] {
    let found = regionsByKey.get(key);
    if (!found) {
      found = sourceRegions(emit?.files[key] ?? "");
      regionsByKey.set(key, found);
    }
    return found;
  }

  /** The translation unit generated from a Titan file, if the emit has one. */
  function unitFor(path: string): string | undefined {
    return emit?.units.find((unit) => regionsOf(unit).some((region) => region?.path === path));
  }

  const view = new EditorView({
    parent: code,
    state: EditorState.create({ doc: "" }),
  });

  function cState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        cassiniEditorTheme,
        cassiniHighlighting,
        cLanguage,
        linkedField,
        EditorView.contentAttributes.of({ "aria-label": `${copy.inspect.generatedC}: ${activeKey ?? ""}` }),
        EditorView.domEventHandlers({
          click(event, clickView) {
            const pos = clickView.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const source = regions[clickView.state.doc.lineAt(pos).number - 1];
            if (!source) return false;
            hooks.revealSource(source.path, source.line);
            link(source);
            return false;
          },
        }),
      ],
    });
  }

  function link(source: SourceLine | null) {
    followed = source;
    const lines: number[] = [];
    if (source) {
      regions.forEach((region, index) => {
        if (region && region.path === source.path && region.line === source.line) lines.push(index + 1);
      });
    }
    view.dispatch({
      effects: [
        setLinked.of(lines),
        ...(lines.length > 0 ? [EditorView.scrollIntoView(view.state.doc.line(lines[0]).from, { y: "center" })] : []),
      ],
    });
    const total = view.state.doc.lines.toLocaleString("en-US");
    hint.replaceChildren(
      source && lines.length > 0 ? `${copy.inspect.linked(lines[0], source.path, source.line)} · ` : "",
      copy.inspect.lines(total),
    );
  }

  function select(key: string) {
    if (!emit) return;
    activeKey = key;
    regions = regionsOf(key);
    view.setState(cState(emit.files[key] ?? ""));
    for (const chip of chips.querySelectorAll<HTMLButtonElement>("button")) {
      chip.setAttribute("aria-selected", String(chip.dataset.key === key));
    }
    link(followed);
  }

  return {
    showEmit(next) {
      emit = next;
      regionsByKey.clear();
      root.toggleAttribute("data-empty", next === null);
      empty.hidden = next !== null;
      if (!next) {
        chips.replaceChildren();
        hint.replaceChildren();
        return;
      }
      const keys = [...next.units, next.entry];
      chips.replaceChildren(
        ...keys.map((key) =>
          el(
            "button",
            { type: "button", class: "pg-chip", role: "tab", "data-key": key, "aria-selected": "false" },
            key === next.entry ? `${key} · ${copy.inspect.entry}` : key,
          ),
        ),
      );
      for (const chip of chips.querySelectorAll<HTMLButtonElement>("button")) {
        chip.addEventListener("click", () => select(chip.dataset.key ?? ""));
      }
      const preferred = activeKey && keys.includes(activeKey) ? activeKey : followed && unitFor(followed.path);
      select(preferred || keys[0]);
    },
    showBuild(build) {
      if (!build) {
        wasm.replaceChildren(el("p", { class: "pg-muted" }, copy.inspect.wasmEmpty));
        return;
      }
      const total = build.sections.reduce((sum, section) => sum + section.bytes, 0);
      const sections = [...build.sections].sort((a, b) => b.bytes - a.bytes);
      const color = (index: number) => SECTION_COLORS[Math.min(index, SECTION_COLORS.length - 1)];
      const image = build.image;
      const files: [string, number][] = [
        ["app.mjs", new TextEncoder().encode(image.mjs).byteLength],
        ["app.wasm", image.wasm.byteLength],
        ["app.wasm.trace", image.trace.byteLength],
        ["app.wasm.map", new TextEncoder().encode(image.map).byteLength],
      ];
      const download = el("button", { type: "button", class: "pg-link-button" }, copy.inspect.downloadBundle);
      download.addEventListener("click", () => hooks.download());
      wasm.replaceChildren(
        el(
          "div",
          { class: "pg-wasm-head" },
          el("h3", {}, copy.inspect.wasmTitle),
          el("span", { class: "pg-wasm-total" }, copy.inspect.wasmTotal(formatMiB(image.wasm.byteLength, 2))),
          el("span", { class: "pg-stale", "data-pg": "wasm-stale", hidden: !buildStale }, copy.inspect.stale),
        ),
        el(
          "div",
          { class: "pg-sizebar", role: "img", "aria-label": copy.inspect.wasmTitle },
          ...sections.map((section, index) =>
            el("span", { style: `flex:${section.bytes};background:${color(index)}`, title: section.name }),
          ),
        ),
        el(
          "table",
          { class: "pg-sizetable" },
          el(
            "tbody",
            {},
            ...sections.map((section, index) =>
              el(
                "tr",
                {},
                el("td", {}, el("i", { style: `background:${color(index)}` })),
                el("td", {}, el("code", {}, section.name)),
                el("td", { class: "pg-num" }, formatBytes(section.bytes)),
                el("td", { class: "pg-pct" }, `${((100 * section.bytes) / Math.max(total, 1)).toFixed(1)}%`),
              ),
            ),
          ),
        ),
        el(
          "div",
          { class: "pg-files-row" },
          ...files.map(([name, bytes]) => el("span", {}, `${name} `, el("b", {}, formatBytes(bytes)))),
          el("span", { class: "pg-spacer" }),
          download,
        ),
      );
    },
    followSource(path, line) {
      followed = { path, line };
      if (!emit) return;
      if (!regions.some((region) => region?.path === path)) {
        const unit = unitFor(path);
        if (unit) {
          select(unit);
          return;
        }
      }
      link(followed);
    },
    setStale(emitStale, nextBuildStale) {
      staleEmit.hidden = !emitStale || emit === null;
      buildStale = nextBuildStale;
      const badge = wasm.querySelector<HTMLElement>("[data-pg=wasm-stale]");
      if (badge) badge.hidden = !buildStale;
    },
  };
}
