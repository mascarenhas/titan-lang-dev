/**
 * Cassini Dark — Shiki/TextMate theme grounded in the converged Cassini Observatory
 * Monograph palette (6+1 clean voices, all foregrounds >= 5.79:1 on #0b0e0a).
 * Keywords semibold only; functions regular weight; unified amber literals;
 * distinct terracotta italic for `self` / language variables.
 */
export const cassiniDarkTheme = {
  name: "cassini-dark",
  type: "dark",
  colors: {
    "editor.background": "#0b0e0a",
    "editor.foreground": "#ddd7c6",
    "editorLineNumber.foreground": "#7b7764",
    "editor.selectionBackground": "#e2d89826",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8f8d7b", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword.control",
        "keyword.control.import",
        "keyword.operator.logical",
        "keyword.operator.type",
        "storage.modifier",
        "storage.type.declaration",
        "storage.type.function",
      ],
      settings: { foreground: "#e2d898", fontStyle: "bold" },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation.definition.typeparameters",
        "punctuation.accessor",
        "punctuation.separator",
      ],
      settings: { foreground: "#c6bc94" },
    },
    {
      scope: ["punctuation.section", "punctuation.definition.string"],
      settings: { foreground: "#a39e89" },
    },
    {
      scope: [
        "storage.type.primitive",
        "storage.type",
        "entity.name.type",
        "support.type",
        "entity.name.tag",
      ],
      settings: { foreground: "#a9d1be" },
    },
    {
      scope: [
        "entity.name.function",
        "entity.name.function.method",
        "support.function",
      ],
      settings: { foreground: "#f4edc4" },
    },
    {
      scope: ["string", "string.quoted", "string.quoted.other.long"],
      settings: { foreground: "#b5c994" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character.escape",
      ],
      settings: { foreground: "#e6b46e" },
    },
    {
      scope: [
        "variable.language.self",
        "variable.language.ffi",
        "variable.language.lua-state",
        "variable.language.module",
        "variable.language",
      ],
      settings: { foreground: "#df9476", fontStyle: "italic" },
    },
    {
      scope: [
        "variable.parameter",
        "variable.other.member",
        "support.type.property-name",
        "variable.other.readwrite",
        "variable",
      ],
      settings: { foreground: "#ddd7c6" },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#ee8270", fontStyle: "underline" },
    },
  ],
};
