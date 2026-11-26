// Titan tokenizer for CodeMirror 6, mirroring titan-compiler/lexer.lua and the
// scopes of vscode-titan's TextMate grammar (which the Shiki voices colour).
import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

// Sets rather than records: lookups take arbitrary identifiers such as
// `constructor`, which a plain object would match through its prototype.
const KEYWORDS = new Set([
  "and", "as", "break", "case", "catch", "const", "defer", "do", "else", "elseif", "end",
  "for", "foreign", "function", "goto", "if", "import", "in", "interface", "is", "local",
  "not", "or", "owned", "raise", "record", "repeat", "return", "then", "type", "union",
  "until", "when", "while",
]);
const PRIMITIVE_TYPES = new Set(["boolean", "float", "integer", "string", "value"]);
const LANGUAGE_VARIABLES = new Set(["self", "ffi", "M", "L"]);

// Block structure for indentation: openers add a level, closers remove one,
// so `else`/`elseif`/`when`/`catch` lines sit at their opener's level.
const OPENERS = new Set(["function", "do", "then", "repeat", "record", "union", "interface", "case", "else", "catch"]);
const CLOSERS = new Set(["end", "until", "elseif", "else", "when", "catch"]);
const DEDENT_LINE = /^\s*(?:end|else|elseif|until|when|catch)\b|^\s*[)}\]]/;

const NUMBER =
  /^(?:0[xX](?:[0-9A-Fa-f]+(?:\.[0-9A-Fa-f]*)?|\.[0-9A-Fa-f]+)(?:[pP][+-]?[0-9]+)?|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(?![A-Za-z0-9_])/;
const ESCAPE = /^(?:z\s*|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|[0-9]{1,3}|[abfnrtv\\'"])/;
const OPERATOR = /^(?:\.\.\.|\.\.|\/\/|<<|>>|==|~=|<=|>=|<\||\|>|[+\-*/%^#&~|<>=?])/;

interface TitanState {
  /** Open `[[`/`--[[` bracket and its `=` level, carried across lines. */
  long: { comment: boolean; level: number } | null;
  /** Quote of a short string continued with a trailing `\`. */
  quote: string | null;
  depth: number;
  lastSignificant: string;
}

function matchRegExp(stream: StringStream, pattern: RegExp): RegExpMatchArray | null {
  const match = stream.match(pattern);
  return typeof match === "object" ? match : null;
}

function closeLongBracket(stream: StringStream, state: TitanState, level: number): void {
  const close = `]${"=".repeat(level)}]`;
  while (!stream.eol()) {
    if (stream.match(close)) {
      state.long = null;
      return;
    }
    stream.next();
  }
}

function shortString(stream: StringStream, state: TitanState, quote: string): string {
  while (!stream.eol()) {
    if (stream.peek() === "\\") {
      if (stream.pos > stream.start) return "string";
      stream.next();
      if (stream.eol() || stream.match(ESCAPE)) return "escape";
      stream.next();
      return "invalid";
    }
    if (stream.next() === quote) {
      state.quote = null;
      return "string";
    }
  }
  // A trailing `\` continues the string; anything else ends it at the line break.
  state.quote = null;
  return "invalid";
}

function name(stream: StringStream, state: TitanState, text: string): string {
  if (KEYWORDS.has(text)) {
    if (CLOSERS.has(text)) state.depth = Math.max(0, state.depth - 1);
    // `function` after `:` is a type annotation, not a block.
    if (OPENERS.has(text) && !(text === "function" && state.lastSignificant === ":")) state.depth++;
    return "keyword";
  }
  if (text === "true" || text === "false") return "bool";
  if (text === "nil") return "null";
  if (LANGUAGE_VARIABLES.has(text)) return "self";
  const rest = stream.string.slice(stream.pos);
  // `string.format` and `local string = import "string"` name a module, not the type.
  if (PRIMITIVE_TYPES.has(text)) return /^\s*(?:\.|=(?!=))/.test(rest) ? "variableName" : "typeName.standard";
  if (/^[A-Z]/.test(text)) return "typeName";
  if (/^\s*(?:\(|<\|)/.test(rest)) return "variableName.function";
  if (state.lastSignificant === ".") return "propertyName";
  return "variableName";
}

function tokenize(stream: StringStream, state: TitanState): string {
  if (stream.match("--")) {
    const long = matchRegExp(stream, /^\[(=*)\[/);
    if (!long) {
      stream.skipToEnd();
      return "lineComment";
    }
    state.long = { comment: true, level: long[1].length };
    closeLongBracket(stream, state, state.long.level);
    return "blockComment";
  }
  const longString = matchRegExp(stream, /^\[(=*)\[/);
  if (longString) {
    state.long = { comment: false, level: longString[1].length };
    closeLongBracket(stream, state, state.long.level);
    return "string";
  }
  const ch = stream.peek();
  if (ch === '"' || ch === "'") {
    stream.next();
    state.quote = ch;
    return shortString(stream, state, ch);
  }
  if (stream.match(NUMBER)) return "number";
  const identifier = matchRegExp(stream, /^[A-Za-z_][A-Za-z0-9_]*/);
  if (identifier) return name(stream, state, identifier[0]);
  if (stream.match("->")) return "invalid";
  if (stream.match(OPERATOR)) return "operator";
  if (stream.match(/^[({[]/)) {
    state.depth++;
    return "bracket";
  }
  if (stream.match(/^[)}\]]/)) {
    state.depth = Math.max(0, state.depth - 1);
    return "bracket";
  }
  if (stream.match(/^[.,;:]/)) return "separator";
  stream.next();
  return "invalid";
}

const titanParser: StreamParser<TitanState> = {
  name: "titan",
  startState: () => ({ long: null, quote: null, depth: 0, lastSignificant: "" }),
  copyState: (state) => ({ ...state, long: state.long && { ...state.long } }),

  token(stream, state) {
    if (state.long) {
      const comment = state.long.comment;
      closeLongBracket(stream, state, state.long.level);
      return comment ? "blockComment" : "string";
    }
    if (state.quote) return shortString(stream, state, state.quote);
    if (stream.eatSpace()) return null;
    const style = tokenize(stream, state);
    if (style !== "lineComment" && style !== "blockComment") state.lastSignificant = stream.current();
    return style;
  },

  indent(state, textAfter, context) {
    const depth = DEDENT_LINE.test(textAfter) ? state.depth - 1 : state.depth;
    return Math.max(0, depth) * context.unit;
  },

  languageData: {
    commentTokens: { line: "--", block: { open: "--[[", close: "]]" } },
    indentOnInput: /^\s*(?:end|else|elseif|until|when|catch|[)}\]])$/,
  },
};

export const titanLanguage = StreamLanguage.define(titanParser);
