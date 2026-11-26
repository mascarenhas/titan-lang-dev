// Highlights a standalone Titan snippet (hover signatures) with the editor's
// own tokenizer and Cassini highlight classes.
import { highlightingFor } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { cassiniHighlighting } from "./highlight";
import { titanLanguage } from "./titan-language";

const snippetState = EditorState.create({ extensions: [titanLanguage, cassiniHighlighting] });

export function renderHighlighted(target: HTMLElement, code: string): void {
  const tree = titanLanguage.parser.parse(code);
  let pos = 0;
  highlightTree(
    tree,
    { style: (tags) => highlightingFor(snippetState, tags) },
    (from, to, classes) => {
      if (from > pos) target.append(code.slice(pos, from));
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = code.slice(from, to);
      target.append(span);
      pos = to;
    },
  );
  if (pos < code.length) target.append(code.slice(pos));
}
