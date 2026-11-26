/**
 * Cassini Print — 6-voice archival Shiki/TextMate theme shared by the Typst PDF
 * monograph (#f7f5ee) and Archival Paper web light mode (#efeadd).
 * All foregrounds >= 5.82:1 on Paper / >= 6.41:1 on PDF.
 *
 * Voices:
 *   1. Ink (#1b1d18): identifiers, functions, operators, punctuation
 *   2. Antique brass semibold (#73540a): keywords ONLY
 *   3. Observatory teal (#18585e): types & variant tags
 *   4. Botanical sage-green (#2a5c30): string literals
 *   5. Burnt sienna (#8c3b1a): numbers, constants, escapes, `self`/`ffi` (italic)
 *   6. Archival slate italic (#585a51): comments
 */
export const cassiniPrintTheme = {
  name: "cassini-print",
  type: "light",
  colors: {
    "editor.background": "#f7f5ee",
    "editor.foreground": "#1b1d18",
    "editorLineNumber.foreground": "#6a6557",
    "editor.selectionBackground": "#9a7d3426",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#585a51", fontStyle: "italic" },
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
      settings: { foreground: "#73540a", fontStyle: "bold" },
    },
    {
      scope: [
        "keyword.operator",
        "punctuation.definition.typeparameters",
        "punctuation.accessor",
        "punctuation.separator",
        "punctuation.section",
        "punctuation.definition.string",
      ],
      settings: { foreground: "#1b1d18" },
    },
    {
      scope: [
        "storage.type.primitive",
        "storage.type",
        "entity.name.type",
        "support.type",
        "entity.name.tag",
      ],
      settings: { foreground: "#18585e" },
    },
    {
      scope: [
        "entity.name.function",
        "entity.name.function.method",
        "support.function",
      ],
      settings: { foreground: "#1b1d18" },
    },
    {
      scope: ["string", "string.quoted", "string.quoted.other.long"],
      settings: { foreground: "#2a5c30" },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character.escape",
      ],
      settings: { foreground: "#8c3b1a" },
    },
    {
      scope: [
        "variable.language.self",
        "variable.language.ffi",
        "variable.language.lua-state",
        "variable.language.module",
        "variable.language",
      ],
      settings: { foreground: "#8c3b1a", fontStyle: "italic" },
    },
    {
      scope: [
        "variable.parameter",
        "variable.other.member",
        "support.type.property-name",
        "variable.other.readwrite",
        "variable",
      ],
      settings: { foreground: "#1b1d18" },
    },
    {
      scope: ["invalid", "invalid.illegal"],
      settings: { foreground: "#a32e24", fontStyle: "underline" },
    },
  ],
};
