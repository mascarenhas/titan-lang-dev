// Cassini voices for CodeMirror. Every colour is a Cassini custom property, so
// the site's Paper/Obsidian toggle restyles editors without remounting them.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const cassiniHighlightStyle = HighlightStyle.define([
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--syntax-comment)", fontStyle: "italic" },
  {
    tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier],
    color: "var(--syntax-keyword)",
    fontWeight: "600",
  },
  { tag: [t.typeName, t.standard(t.typeName), t.className, t.namespace], color: "var(--syntax-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syntax-function)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.escape], color: "var(--syntax-number)" },
  { tag: [t.self, t.special(t.variableName)], color: "var(--syntax-special)", fontStyle: "italic" },
  { tag: [t.operator, t.separator, t.derefOperator, t.logicOperator], color: "var(--syntax-operator)" },
  { tag: [t.bracket, t.punctuation], color: "var(--syntax-punctuation)" },
  { tag: [t.variableName, t.propertyName, t.definition(t.variableName)], color: "var(--syntax-fg)" },
  { tag: t.processingInstruction, color: "var(--syntax-comment)" },
  { tag: t.invalid, color: "var(--syntax-invalid)", textDecoration: "underline" },
]);

export const cassiniHighlighting = syntaxHighlighting(cassiniHighlightStyle);

export const cassiniEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--syntax-fg)",
    backgroundColor: "var(--syntax-bg)",
    fontSize: "var(--pg-editor-font)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "var(--pg-editor-leading)",
    fontFeatureSettings: '"liga" 0, "calt" 0',
  },
  ".cm-content": { padding: "0.9rem 0 3rem", caretColor: "var(--accent-gold)" },
  ".cm-line": { padding: "0 1.5rem 0 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "1.5px solid var(--accent-gold)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--fill-mark)",
  },
  ".cm-activeLine": { backgroundColor: "var(--pg-line-active)" },
  ".cm-gutters": {
    backgroundColor: "var(--syntax-bg)",
    color: "var(--pg-gutter-ink)",
    border: "none",
    fontSize: "0.78rem",
  },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.25rem", padding: "0 1.15rem 0 0.4rem" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--pg-gutter-ink-active)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--fill-accent-hover)",
    outline: "1px solid var(--rule-default)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--fill-mark)", outline: "1px solid var(--rule-strong)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--fill-accent-hover)" },
  ".cm-tooltip": {
    border: "1px solid var(--rule-default)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--surface-raised)",
    color: "var(--ink-primary)",
    boxShadow: "var(--shadow-card)",
    fontFamily: "var(--font-sans)",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "0.78rem", maxHeight: "16rem" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "0.2rem 0.75rem 0.2rem 0.5rem", lineHeight: "1.5" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--fill-accent-hover)",
    color: "var(--ink-display)",
  },
  ".cm-completionDetail": { marginLeft: "1.25rem", fontStyle: "normal", color: "var(--syntax-type)" },
  ".cm-completionInfo": { padding: "0.5rem 0.75rem", maxWidth: "26rem", color: "var(--ink-secondary)" },
  ".cm-completionMatchedText": { textDecoration: "none", color: "var(--accent-gold)" },
  ".cm-panels": { backgroundColor: "var(--surface-elevated)", color: "var(--ink-primary)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--rule-subtle)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "var(--font-sans)", fontSize: "0.78rem" },
  ".cm-textfield": {
    backgroundColor: "var(--surface-canvas)",
    border: "1px solid var(--rule-default)",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-primary)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface-raised)",
    border: "1px solid var(--rule-default)",
    borderRadius: "var(--radius-sm)",
    color: "var(--ink-strong)",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--pg-error)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "4px",
    textDecorationSkipInk: "none",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--pg-warn)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "4px",
  },
  ".cm-lintPoint:after": { borderBottomColor: "var(--pg-error)" },
});
