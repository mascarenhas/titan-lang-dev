// The terminal: streamed program output, results with clickable trace frames,
// and the run receipt. Everything the program prints is inserted as text.
import { copy } from "../content/copy";
import type { Build, Level } from "../types";
import { el } from "./dom";

/** Characters kept per terminal; older output scrolls away. */
const OUTPUT_LIMIT = 512 * 1024;

/** A source position a trace frame resolved to; `line` is null when the host printed none. */
export interface Frame {
  path: string;
  line: number | null;
}

export interface TraceHooks {
  open(frame: Frame): void;
  /** Every Titan source path a frame may name: project files and the read-only library. */
  sources(): readonly string[];
}

/**
 * One traceback row. Hosts print the file's basename, e.g.
 * `async.titan:3620: in anonymous function at ./titan/async/async.titan:3619`,
 * `coroutine.titan:402: in titan.coroutine.coro_entry`, or (Safari) no line.
 */
const FRAME = /^\s*([^\s:]+\.titan)(?::(\d+))?:\s*in\s+(.*)$/;
const DEFINED_AT = /\bat \.?\/?((?:[^\s:\]]+\/)*[^\s:\]]+\.titan):\d+/;
const LOCATION = /^((?:\.\/)?[^\s:]+\.titan):(\d+):/;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function isLibraryPath(path: string): boolean {
  return path.startsWith("titan/");
}

/**
 * The source a frame names, or null when the trace does not identify exactly
 * one file. Hosts print basenames, so a definition path (`at ./titan/...`) or
 * the module part of the function name breaks ties; nothing is guessed.
 */
function resolve(file: string, what: string, sources: readonly string[]): string | null {
  const name = file.startsWith("./") ? file.slice(2) : file;
  if (sources.includes(name) && name.includes("/")) return name;
  const candidates = sources.filter((path) => basename(path) === basename(name));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const defined = DEFINED_AT.exec(what)?.[1];
  if (defined && candidates.includes(defined)) return defined;
  // `titan.http.client.request` names module `titan.http.client`, file titan/http/client(.browser).titan.
  const segments = /^[A-Za-z_][\w.]*/.exec(what)?.[0].split(".") ?? [];
  for (let length = segments.length - 1; length > 0; length--) {
    const prefix = segments.slice(0, length).join("/");
    const matches = candidates.filter((path) => path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}.`));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) break;
  }
  return null;
}

interface Row {
  text: string;
  frame: Frame | null;
  library: boolean;
}

function parseTrace(trace: string, sources: readonly string[]): Row[] {
  const rows: Row[] = [];
  for (const raw of trace.split("\n")) {
    const text = raw.trim();
    if (text === "") continue;
    const match = FRAME.exec(text);
    if (!match) {
      rows.push({ text, frame: null, library: text.startsWith("[C]") });
      continue;
    }
    const [, file, line, what] = match;
    const path = resolve(file, what, sources);
    const defined = DEFINED_AT.exec(what)?.[1];
    const library = path ? isLibraryPath(path) : isLibraryPath(defined ?? "") || what.startsWith("titan.");
    rows.push({ text, frame: path ? { path, line: line ? Number(line) : null } : null, library });
  }
  return rows;
}

/** The first author frame of a traceback, or the location prefix of the error message. */
export function faultLocation(message: string, trace: string, sources: readonly string[]): Frame | null {
  const row = parseTrace(trace, sources).find((candidate) => candidate.frame && !candidate.library);
  if (row?.frame) return row.frame;
  const match = LOCATION.exec(message);
  if (!match) return null;
  const path = resolve(match[1], "", sources);
  return path ? { path, line: Number(match[2]) } : null;
}

/** Class of stderr stream chunks, the only nodes an uncaught traceback can be read back from. */
const STDERR_CHUNK = "pg-stderr-chunk";

export class Terminal {
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  /** Characters in the terminal's children, kept equal to their text through every append and removal. */
  private length = 0;

  constructor(
    readonly element: HTMLElement,
    private readonly hooks: TraceHooks,
    /** Characters kept; older output scrolls away. A parameter only so tests can use a small cap. */
    private readonly limit = OUTPUT_LIMIT,
  ) {}

  clear(): void {
    this.element.replaceChildren();
    this.decoders.stdout = new TextDecoder();
    this.decoders.stderr = new TextDecoder();
    this.length = 0;
  }

  private append(node: Node): void {
    this.element.append(node);
    this.length += node.textContent?.length ?? 0;
    while (this.length > this.limit && this.element.firstChild) {
      this.remove(this.element.firstChild);
    }
    this.element.scrollTop = this.element.scrollHeight;
  }

  private remove(node: ChildNode): void {
    this.length -= node.textContent?.length ?? 0;
    node.remove();
  }

  line(text: string, className = "pg-meta"): HTMLElement {
    const node = el("span", { class: `pg-term-line ${className}` }, text);
    this.append(node);
    return node;
  }

  stream(channel: "stdout" | "stderr", bytes: Uint8Array): void {
    const text = this.decoders[channel].decode(bytes, { stream: true });
    if (text.length === 0) return;
    this.append(channel === "stdout" ? document.createTextNode(text) : el("span", { class: `pg-stderr ${STDERR_CHUNK}` }, text));
  }

  console(level: Level, text: string): void {
    this.line(text, level === "error" || level === "warn" ? "pg-stderr" : "pg-console-line");
  }

  /** The stderr chunks at the end of the terminal, after any other output; only nodes still shown. */
  private trailingStderr(): HTMLElement[] {
    const chunks: HTMLElement[] = [];
    let node = this.element.lastChild;
    while (node instanceof HTMLElement && node.classList.contains(STDERR_CHUNK)) {
      chunks.unshift(node);
      node = node.previousSibling;
    }
    return chunks;
  }

  /**
   * Error text and traceback with author frames as links and library runs folded.
   * The SDK has usually just printed the same traceback to stderr; while that copy
   * is still on screen, the chunks holding it are replaced in place rather than
   * shown twice. Earlier program stderr stays as printed.
   */
  failure(message: string, trace: string): void {
    this.flush();
    const rows = parseTrace(trace, this.hooks.sources());
    const block = el("span", { class: "pg-term-block" });
    const chunks = this.trailingStderr();
    const printed = chunks.map((chunk) => chunk.textContent ?? "").join("");
    const traceText = trace.trim();
    const at = traceText === "" ? -1 : printed.lastIndexOf(traceText);
    if (at >= 0) {
      // Find the chunk where the traceback copy starts; it and everything after it are replaced.
      let first = 0;
      let start = 0;
      while (start + (chunks[first].textContent?.length ?? 0) <= at) start += chunks[first++].textContent?.length ?? 0;
      for (const chunk of chunks.slice(first)) this.remove(chunk);
      const before = printed.slice(start, at).replace(/\n$/, "");
      if (before) block.append(this.withLocation(before));
      this.appendRows(block, rows);
      const after = printed.slice(at + traceText.length).replace(/^\n/, "");
      if (after) block.append(el("span", { class: "pg-stderr" }, after));
    } else {
      block.append(this.withLocation(message));
      this.appendRows(block, rows);
    }
    this.append(block);
  }

  private appendRows(block: HTMLElement, rows: Row[]): void {
    let folded: HTMLElement[] = [];
    const flushFolded = () => {
      if (folded.length > 0) block.append(this.fold(folded));
      folded = [];
    };
    for (const row of rows) {
      const node = el("span", { class: "pg-frame pg-stderr" });
      const match = row.frame ? FRAME.exec(row.text) : null;
      if (row.frame && match) {
        const label = match[2] ? `${match[1]}:${match[2]}` : match[1];
        node.append(this.link(row.frame, label), row.text.slice(label.length));
      } else {
        node.append(row.text);
      }
      if (row.library) folded.push(node);
      else {
        flushFolded();
        block.append(node);
      }
    }
    flushFolded();
  }

  private flush(): void {
    for (const channel of ["stdout", "stderr"] as const) {
      const rest = this.decoders[channel].decode();
      if (rest.length > 0) {
        this.append(channel === "stdout" ? document.createTextNode(rest) : el("span", { class: `pg-stderr ${STDERR_CHUNK}` }, rest));
      }
    }
  }

  /** The message as stderr text, with a leading `file.titan:line:` turned into a link. */
  private withLocation(message: string): HTMLElement {
    const line = el("span", { class: "pg-term-line pg-stderr" });
    const match = LOCATION.exec(message);
    const path = match ? resolve(match[1], "", this.hooks.sources()) : null;
    if (!match || !path) {
      line.append(message);
      return line;
    }
    const label = `${match[1]}:${match[2]}`;
    line.append(this.link({ path, line: Number(match[2]) }, label), message.slice(label.length));
    return line;
  }

  private link(frame: Frame, label: string): HTMLElement {
    const link = el("button", { type: "button", class: "pg-trace-link" }, label);
    link.addEventListener("click", () => this.hooks.open(frame));
    return link;
  }

  private fold(rows: HTMLElement[]): HTMLElement {
    const group = el("span", { class: "pg-fold-group", hidden: true }, ...rows);
    const label = copy.output.folded(rows.length);
    const toggle = el("button", { type: "button", class: "pg-fold", "aria-expanded": "false" }, `▸ ${label}`);
    toggle.addEventListener("click", () => {
      const open = group.hidden;
      group.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = `${open ? "▾" : "▸"} ${label}`;
    });
    return el("span", { class: "pg-fold-wrap" }, toggle, group);
  }

  exit(text: string, ok: boolean): void {
    this.flush();
    this.append(el("span", { class: "pg-term-rule" }));
    this.line(text, ok ? "pg-exit-ok" : "pg-meta");
  }
}

/** Run receipt: measured stage timings and reused objects; `cold` marks the session's first build. */
export function renderReceipt(target: HTMLElement, build: Build, runMs: number, cold: boolean): void {
  const segments = [
    ["check", build.ms.check, "var(--pg-seg-check)"],
    ["compile", build.ms.compile, "var(--pg-seg-compile)"],
    ["link", build.ms.link, "var(--pg-seg-link)"],
    ["run", runMs, "var(--pg-seg-run)"],
  ] as const;
  const total = Math.round(segments.reduce((sum, [, ms]) => sum + ms, 0));
  target.hidden = false;
  target.replaceChildren(
    el(
      "div",
      { class: "pg-receipt-head" },
      el("span", { class: "pg-kicker" }, copy.output.receiptKicker),
      el("span", { class: "pg-receipt-total" }, copy.output.receiptTotal(total)),
      el("span", { class: "pg-receipt-note" }, cold ? copy.output.receiptNoteCold : copy.output.receiptNote),
    ),
    el(
      "div",
      { class: "pg-segbar", role: "img", "aria-label": copy.output.receiptTotal(total) },
      ...segments.map(([, ms, color]) => el("span", { style: `flex:${Math.max(ms, 1)};background:${color}` })),
    ),
    el(
      "div",
      { class: "pg-seglegend" },
      ...segments.map(([name, ms, color]) =>
        el("span", {}, el("i", { style: `background:${color}` }), `${copy.output.segments[name]} ${Math.round(ms)} ms`),
      ),
      build.reused.length > 0 ? el("span", { class: "pg-cached" }, copy.output.reused(build.reused.join(", "))) : null,
    ),
  );
}
