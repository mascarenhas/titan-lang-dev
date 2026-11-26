// The project editor: one CodeMirror view, one preserved EditorState per file.
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion as CmCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { lintKeymap, previousDiagnostic, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  EditorState,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  GutterMarker,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
  WidgetType,
} from "@codemirror/view";
import type { Completion, Diagnostic, Hover } from "../types";
import { el } from "./dom";
import { cassiniEditorTheme, cassiniHighlighting } from "./highlight";
import { renderHighlighted } from "./highlight-code";
import { titanLanguage } from "./titan-language";

export function isTitanPath(path: string): boolean {
  return path.endsWith(".titan");
}

export interface EditorHooks {
  onChange(path: string, text: string): void;
  onCursor(path: string, line: number, column: number): void;
  hover(path: string, offset: number): Promise<Hover | null>;
  complete(path: string, offset: number): Promise<Completion | null>;
  run(): void;
  share(): void;
  toggleDrawer(): void;
  cardKicker(severity: Diagnostic["severity"]): string;
  cardSource: string;
}

// ---------------------------------------------------------------------------
// Line marks: the runtime fault line (▲ + lens), C ↔ Titan links, flashes and
// diagnostic cards. Marks hold document offsets and follow edits; a runtime
// fault stays visible (and is labelled stale elsewhere) until the next run.

interface Card {
  pos: number;
  kicker: string;
  source: string;
  location: string;
  message: string;
}

interface Marks {
  runtime: { pos: number; text: string } | null;
  linked: readonly number[];
  flash: number | null;
  cards: readonly Card[];
}

const setRuntimeMark = StateEffect.define<Marks["runtime"]>();
const setLinked = StateEffect.define<readonly number[]>();
const setFlash = StateEffect.define<number | null>();
const setCards = StateEffect.define<readonly Card[]>();

class LensWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: LensWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    return el("span", { class: "pg-lens" }, `← ${this.text}`);
  }
}

class CardWidget extends WidgetType {
  constructor(readonly card: Card) {
    super();
  }
  eq(other: CardWidget): boolean {
    const a = this.card;
    const b = other.card;
    return a.kicker === b.kicker && a.source === b.source && a.location === b.location && a.message === b.message;
  }
  toDOM(): HTMLElement {
    const { kicker, source, location, message } = this.card;
    return el(
      "div",
      { class: "pg-diag", role: "alert" },
      el(
        "div",
        { class: "pg-diag-head" },
        el("span", { class: "pg-kicker" }, kicker),
        el("span", { class: "pg-diag-source" }, source),
        el("span", { class: "pg-diag-loc" }, location),
      ),
      el("div", { class: "pg-diag-msg" }, message),
    );
  }
}

const raisedLine = Decoration.line({ class: "pg-line-raised" });
const linkedLine = Decoration.line({ class: "pg-line-linked" });
const flashLine = Decoration.line({ class: "pg-line-flash" });

const marksField = StateField.define<Marks>({
  create: () => ({ runtime: null, linked: [], flash: null, cards: [] }),
  update(marks, tr) {
    let next = marks;
    if (tr.docChanged) {
      const map = (pos: number) => tr.changes.mapPos(pos);
      next = {
        runtime: next.runtime && { ...next.runtime, pos: map(next.runtime.pos) },
        linked: next.linked.map(map),
        flash: null,
        cards: next.cards.map((card) => ({ ...card, pos: map(card.pos) })),
      };
    }
    for (const effect of tr.effects) {
      if (effect.is(setRuntimeMark)) next = { ...next, runtime: effect.value };
      else if (effect.is(setLinked)) next = { ...next, linked: effect.value };
      else if (effect.is(setFlash)) next = { ...next, flash: effect.value };
      else if (effect.is(setCards)) next = { ...next, cards: effect.value };
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state): DecorationSet => {
      const marks = state.field(field);
      const { doc } = state;
      const ranges = marks.linked.map((pos) => linkedLine.range(doc.lineAt(pos).from));
      if (marks.runtime) {
        const line = doc.lineAt(marks.runtime.pos);
        ranges.push(raisedLine.range(line.from));
        ranges.push(Decoration.widget({ widget: new LensWidget(marks.runtime.text), side: 1 }).range(line.to));
      }
      if (marks.flash !== null) ranges.push(flashLine.range(doc.lineAt(marks.flash).from));
      for (const card of marks.cards) {
        ranges.push(Decoration.widget({ widget: new CardWidget(card), block: true, side: 1 }).range(doc.lineAt(card.pos).to));
      }
      return Decoration.set(ranges, true);
    }),
});

class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}
const raisedGutter = new LineClassMarker("pg-gutter-raised");
const linkedGutter = new LineClassMarker("pg-gutter-linked");

const marksGutter = gutterLineClass.compute([marksField], (state) => {
  const marks = state.field(marksField);
  const ranges = marks.linked.map((pos) => linkedGutter.range(state.doc.lineAt(pos).from));
  if (marks.runtime) ranges.push(raisedGutter.range(state.doc.lineAt(marks.runtime.pos).from));
  return RangeSet.of(ranges, true);
});

// ---------------------------------------------------------------------------

/** Titan completion kinds mapped to CodeMirror's icon classes. */
const COMPLETION_TYPES: Record<string, string> = {
  function: "function",
  method: "method",
  field: "property",
  record: "class",
  union: "enum",
  interface: "interface",
  type: "type",
  module: "namespace",
  variable: "variable",
  constant: "constant",
  keyword: "keyword",
};

export interface EditorController {
  readonly view: EditorView;
  open(path: string, text: string, readOnly?: boolean): void;
  forget(path: string): void;
  current(): string | null;
  setDiagnostics(byPath: ReadonlyMap<string, readonly Diagnostic[]>): void;
  setRuntimeMark(path: string | null, line: number, text: string): void;
  setLinkedLines(path: string, lines: readonly number[]): void;
  reveal(path: string, line: number): void;
  focus(): void;
}

export function createEditor(parent: HTMLElement, hooks: EditorHooks): EditorController {
  const states = new Map<string, EditorState>();
  /** Where each parked file was scrolled; one view serves every file, so its scroller must be restored. */
  const scrolls = new Map<string, StateEffect<unknown>>();
  let currentPath: string | null = null;
  let diagnostics: ReadonlyMap<string, readonly Diagnostic[]> = new Map();
  let flashTimer = 0;
  /** The last run's fault, applied to files opened after it was raised as well. */
  let runtime: { path: string; line: number; text: string } | null = null;

  const shortcuts = Prec.highest(
    keymap.of([
      { key: "Mod-Enter", run: () => (hooks.run(), true) },
      { key: "Mod-s", run: () => (hooks.share(), true), preventDefault: true },
      { key: "Mod-b", run: () => (hooks.toggleDrawer(), true) },
      { key: "Shift-F8", run: previousDiagnostic },
    ]),
  );

  function intelligence(path: string): Extension[] {
    return [
      hoverTooltip(async (_view, pos) => {
        const hover = await hooks.hover(path, pos);
        if (!hover || hover.at.path !== path) return null;
        return { pos: hover.at.from, end: hover.at.to, create: () => ({ dom: hoverCard(hover) }) };
      }),
      autocompletion({
        override: [
          async (context) => {
            const result = await hooks.complete(path, context.pos);
            if (!result || result.replace.path !== path || result.items.length === 0) return null;
            return {
              from: result.replace.from,
              to: result.replace.to,
              options: result.items.map(
                (item): CmCompletion => ({
                  label: item.label,
                  type: COMPLETION_TYPES[item.kind] ?? item.kind,
                  detail: item.detail,
                  info: item.summary,
                }),
              ),
              validFor: /^[A-Za-z_][A-Za-z0-9_]*$/,
            };
          },
        ],
      }),
    ];
  }

  function extensions(path: string, readOnly: boolean): Extension[] {
    const language = isTitanPath(path) ? [titanLanguage] : /\.m?js$/.test(path) ? [javascript()] : [];
    return [
      shortcuts,
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.tabSize.of(4),
      indentUnit.of("    "),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),
      cassiniEditorTheme,
      cassiniHighlighting,
      marksField,
      marksGutter,
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ "aria-label": path }),
      EditorView.updateListener.of((update) => {
        if (currentPath !== path) return;
        if (update.docChanged) hooks.onChange(path, update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          hooks.onCursor(path, line.number, head - line.from + 1);
        }
      }),
      ...language,
      ...(isTitanPath(path) && !readOnly ? intelligence(path) : []),
    ];
  }

  const view = new EditorView({ parent });

  function diagnosticSpecs(path: string, state: EditorState): TransactionSpec[] {
    const lint: CmDiagnostic[] = [];
    const cards: Card[] = [];
    for (const diagnostic of diagnostics.get(path) ?? []) {
      if (!diagnostic.at) continue;
      const from = Math.min(diagnostic.at.from, state.doc.length);
      // The compiler reports a start position; extend a point to the end of its token.
      const to = diagnostic.at.to > from ? Math.min(diagnostic.at.to, state.doc.length) : tokenEnd(state, from);
      lint.push({ from, to, severity: diagnostic.severity, message: diagnostic.message });
      const line = state.doc.lineAt(from);
      cards.push({
        pos: from,
        kicker: hooks.cardKicker(diagnostic.severity),
        source: hooks.cardSource,
        location: `${path}:${line.number}:${from - line.from + 1}`,
        message: diagnostic.message,
      });
    }
    return [setDiagnostics(state, lint), { effects: setCards.of(cards) }];
  }

  /** Applies effects to a file whether it is on screen or parked. */
  function update(path: string, specs: (state: EditorState) => TransactionSpec[]) {
    if (path === currentPath) {
      view.dispatch(...specs(view.state));
      return;
    }
    const state = states.get(path);
    if (state) states.set(path, state.update(...specs(state)).state);
  }

  function lineStart(path: string, line: number): number | null {
    const state = path === currentPath ? view.state : states.get(path);
    return state && line >= 1 && line <= state.doc.lines ? state.doc.line(line).from : null;
  }

  return {
    view,
    open(path, text, readOnly = false) {
      if (currentPath === path) return;
      if (currentPath !== null) {
        states.set(currentPath, view.state);
        scrolls.set(currentPath, view.scrollSnapshot());
      }
      let state = states.get(path);
      if (!state) {
        state = EditorState.create({ doc: text, extensions: extensions(path, readOnly) });
        state = state.update(...diagnosticSpecs(path, state)).state;
        if (runtime?.path === path && runtime.line <= state.doc.lines) {
          const mark = { pos: state.doc.line(runtime.line).from, text: runtime.text };
          state = state.update({ effects: setRuntimeMark.of(mark) }).state;
        }
      }
      states.delete(path);
      currentPath = path;
      view.setState(state);
      // A file opened for the first time starts at its top, not at the previous file's offset.
      const snapshot = scrolls.get(path);
      if (snapshot) view.dispatch({ effects: snapshot });
      else view.scrollDOM.scrollTop = 0;
      scrolls.delete(path);
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      hooks.onCursor(path, line.number, head - line.from + 1);
    },
    forget(path) {
      states.delete(path);
      scrolls.delete(path);
      if (currentPath === path) currentPath = null;
    },
    current: () => currentPath,
    setDiagnostics(byPath) {
      diagnostics = byPath;
      for (const path of [...states.keys(), ...(currentPath === null ? [] : [currentPath])]) {
        update(path, (state) => diagnosticSpecs(path, state));
      }
    },
    setRuntimeMark(path, line, text) {
      runtime = path === null ? null : { path, line, text };
      for (const p of [...states.keys(), ...(currentPath === null ? [] : [currentPath])]) {
        const pos = p === path ? lineStart(p, line) : null;
        update(p, () => [{ effects: setRuntimeMark.of(pos === null ? null : { pos, text }) }]);
      }
    },
    setLinkedLines(path, lines) {
      const positions = lines.map((line) => lineStart(path, line)).filter((pos): pos is number => pos !== null);
      update(path, () => [{ effects: setLinked.of(positions) }]);
    },
    reveal(path, line) {
      const from = lineStart(path, line);
      if (path !== currentPath || from === null) return;
      window.clearTimeout(flashTimer);
      view.dispatch({
        selection: { anchor: from },
        effects: [EditorView.scrollIntoView(from, { y: "center" }), setFlash.of(from)],
      });
      flashTimer = window.setTimeout(() => {
        if (currentPath === path) view.dispatch({ effects: setFlash.of(null) });
      }, 1200);
    },
    focus: () => view.focus(),
  };
}

function tokenEnd(state: EditorState, from: number): number {
  const line = state.doc.lineAt(from);
  const rest = line.text.slice(from - line.from);
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d[\w.]*|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\S)/.exec(rest);
  return from + (match ? match[0].length : 0);
}

function hoverCard(hover: Hover): HTMLElement {
  const signature = el("pre", { class: "pg-hover-signature" });
  renderHighlighted(signature, hover.signature);
  return el(
    "div",
    { class: "pg-hover" },
    signature,
    hover.summary ? el("p", { class: "pg-hover-summary" }, hover.summary) : null,
    hover.declaration ? el("p", { class: "pg-hover-declaration" }, el("code", {}, hover.declaration.path)) : null,
  );
}
