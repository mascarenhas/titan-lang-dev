// Shared playground contract: project model, compiler Worker protocol, and the
// engine surface the UI consumes. Plain structured-clone records only; byte
// payloads are Uint8Arrays. Every position is a 0-based UTF-16 offset into the
// exact current text, and every range is half-open (CodeMirror offsets).

/** Project files keyed by relative POSIX path (see `engine/paths.ts`). */
export type Files = Record<string, string>;

export type PreviewMode = 'console' | 'canvas2d' | 'dom' | 'three';

export interface ExampleDefinition {
  slug: string;
  title: string;
  category: 'Language' | 'Runtime' | 'Browser';
  summary: string;
  bookLink: string;
  previewMode: PreviewMode;
  files: Files;
}

export interface Project {
  v: 1;
  files: Files;
  previewMode: PreviewMode;
}

export interface Snapshot {
  revision: number;
  files: Files;
}

export interface Span {
  path: string;
  from: number;
  to: number;
}

export interface Diagnostic {
  message: string;
  severity: 'error' | 'warning';
  at?: Span;
}

export interface Hover {
  at: Span;
  signature: string;
  summary?: string;
  declaration?: Span;
}

export interface Candidate {
  label: string;
  kind: string;
  detail?: string;
  summary?: string;
}

export interface Completion {
  replace: Span;
  items: Candidate[];
}

/** Generated C and headers keyed by logical path; `units` excludes `entry`. */
export interface Emit {
  files: Files;
  units: string[];
  entry: string;
  diagnostics: Diagnostic[];
}

/** A deployable image: `app.mjs`, `app.wasm`, `app.wasm.trace`, `app.wasm.map`. */
export interface Image {
  mjs: string;
  wasm: Uint8Array;
  trace: Uint8Array;
  map: string;
}

export interface Section {
  name: string;
  bytes: number;
}

export interface Build {
  image: Image;
  sections: Section[];
  /** Module object names whose cached `.o` this build reused. */
  reused: string[];
  /** `link` covers wasm-ld, wasm-opt, and the trace table. */
  ms: { check: number; compile: number; link: number };
}

export interface Cursor {
  path: string;
  offset: number;
}

export type Level = 'log' | 'info' | 'warn' | 'error';
export type Stage = 'check' | 'compile' | 'link';

export interface PlaygroundAsset {
  path: string;
  tier: 1 | 2;
  bytes: number;
  sha256: string;
  mime: string;
}

export interface PlaygroundManifest {
  schema: 1;
  hash: string;
  titanRevision: string;
  profile: 'validation';
  assets: PlaygroundAsset[];
}

/** Request argument and reply value of each compiler Worker operation. */
export interface Operations {
  init: [{ manifest: PlaygroundManifest; base: string }, null];
  sync: [Snapshot, null];
  warm: [{ tier: 1 | 2 }, null];
  check: [null, Diagnostic[]];
  hover: [Cursor, Hover | null];
  complete: [Cursor, Completion | null];
  emit_c: [null, Emit];
  build: [null, Build];
  stdlib: [null, Files];
  clearCache: [null, null];
}

export type Op = keyof Operations;

export type Request = {
  [K in Op]: { id: number; revision: number; op: K; args: Operations[K][0] };
}[Op];

export type ReplyFailureCode = 'stale' | 'diagnostics' | 'toolchain';

export type Reply =
  | { [K in Op]: { id: number; revision: number; op: K; ok: true; value: Operations[K][1] } }[Op]
  | {
      id: number;
      revision: number;
      op: Op;
      ok: false;
      code: ReplyFailureCode;
      message: string;
      diagnostics?: Diagnostic[];
    };
export type Progress =
  | { event: 'asset'; tier: 1 | 2; path: string; loaded: number; total: number; cached: boolean }
  | { event: 'stage'; id: number; revision: number; stage: Stage; state: 'start' | 'end'; ms?: number }
  /** Whether assets persist in Cache Storage; `false` means they last for this session only. */
  | { event: 'storage'; persistent: boolean };

export type RunEvent =
  | { type: 'stream'; channel: 'stdout' | 'stderr'; bytes: Uint8Array }
  | { type: 'console'; level: Level; text: string }
  | { type: 'bindings'; names: string[] }
  | { type: 'ready' }
  | { type: 'stop-request' }
  | { type: 'stopped' }
  | { type: 'result'; kind: 'returned' | 'exited' | 'failed'; status: number; bytes: Uint8Array; trace: Uint8Array }
  | { type: 'error'; message: string };

export interface RunOptions {
  build: Build;
  project: Project;
  revision: number;
  preview: HTMLElement;
  stdin?: string;
  onEvent: (event: RunEvent) => void;
}

export interface Engine {
  request<K extends Op>(op: K, args: Operations[K][0], revision: number): Promise<Operations[K][1]>;
  run(options: RunOptions): { stop(): void };
  dispose(): void;
}

/** A failed compiler request: the Worker's failure code and any diagnostics. */
export interface EngineRequestError extends Error {
  code: ReplyFailureCode;
  diagnostics?: Diagnostic[];
}
