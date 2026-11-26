// A small C99 tokenizer for the read-only Inspect view of titanc's output.
import { StreamLanguage, type StringStream } from "@codemirror/language";

const KEYWORDS = new Set([
  "break", "case", "continue", "default", "do", "else", "enum", "extern", "for", "goto", "if",
  "inline", "register", "restrict", "return", "sizeof", "static", "struct", "switch", "typedef",
  "union", "volatile", "while", "const",
]);
const TYPES = new Set([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "_Bool", "bool",
  "size_t", "lua_State", "lua_Integer", "lua_Number", "lua_Unsigned", "TValue", "StkId", "Udata",
  "CClosure", "LClosure", "TString", "Table", "GCObject", "Proto", "UpVal",
]);

interface CState {
  blockComment: boolean;
}

function skipBlockComment(stream: StringStream, state: CState): string {
  state.blockComment = !stream.skipTo("*/");
  if (state.blockComment) stream.skipToEnd();
  else stream.pos += 2;
  return "blockComment";
}

export const cLanguage = StreamLanguage.define<CState>({
  name: "c",
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) return skipBlockComment(stream, state);
    if (stream.sol() && stream.match(/^\s*#/)) {
      stream.skipToEnd();
      return "processingInstruction";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }
    if (stream.match("/*")) return skipBlockComment(stream, state);
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
    if (stream.match(/^(?:0[xX][0-9A-Fa-f]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)[uUlLfF]*/)) return "number";
    // titanc spells Titan's method separators as universal character names (`\u2133`).
    const word = stream.match(/^(?:[A-Za-z_]|\\u[0-9A-Fa-f]{4})(?:[A-Za-z0-9_]|\\u[0-9A-Fa-f]{4})*/);
    if (typeof word === "object" && word) {
      const text = word[0];
      if (KEYWORDS.has(text)) return "keyword";
      if (TYPES.has(text) || /_t$/.test(text) || /^_titan_nominal_/.test(text)) return "typeName";
      if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "variableName.function";
      return "variableName";
    }
    if (stream.match(/^(?:->|\+\+|--|<<=?|>>=?|[-+*/%=<>!&|^~?:]=?)/)) return "operator";
    if (stream.match(/^[()[\]{}]/)) return "bracket";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
});
