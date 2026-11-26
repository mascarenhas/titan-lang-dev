/**
 * Authoritative UI copy for the Titan Browser Playground (`/play/`) and landing section.
 *
 * Follows `ui-spec.md` §5 status copy rules and `CONTRACTS.md` §4:
 * - Name the real pipeline stage, never generic "Loading".
 * - Report measured sizes in MiB with one decimal and ETA only after rate sampling.
 * - Mark stale runtime output/problems explicitly after an edit.
 * - Never rewrite compiler diagnostics; surface `titanc`'s verbatim text.
 */
export const copy = {
  gallery: {
    kicker: "Example",
    label: "Example gallery",
    footnote: "Every example compiles with the same titanc as your terminal.",
    openBook: "Read in the Book",
    replaceConfirm: (title: string) => `Replace your edited project with “${title}”?`,
    sharedProject: "Shared project",
    ownProject: "Your project",
  },
  toolbar: {
    label: "Playground controls",
    files: "Files",
    filesHint: "Files (Ctrl/⌘+B)",
    run: "Run",
    runHint: "Run (Ctrl/⌘+Enter)",
    runWarming: (percent: number) => `Run · ${percent}%`,
    runDeferred: (mib: string) => `Run · fetch ${mib} MiB`,
    stop: "Stop",
    stopHint: "Stop (Esc)",
    share: "Share",
    shareHint: "Copy share link (Ctrl/⌘+S)",
    download: "Download",
    downloadHint: "Download a runnable bundle (.zip)",
    newFile: "New file",
    addBindings: "+ bindings.js",
    addBindingsHint: "Add editable JavaScript bindings for the preview",
    more: "More",
    menu: "Menu",
    segmentsLabel: "View",
    segments: {
      code: "Code",
      output: "Output",
      preview: "Preview",
    },
    tabs: {
      output: "Output",
      preview: "Preview",
      problems: "Problems",
      inspect: "Inspect",
    },
  },
  pipeline: {
    label: "Toolchain status",
    stages: {
      check: "Check",
      compile: "Compile",
      link: "Link",
    },
    live: "live",
    cached: "cached",
    errors: (n: number) => (n === 1 ? "1 error" : `${n} errors`),
    warmingKicker: "First visit · one-time setup",
    warmingTitle: "Fetching the toolchain into your browser",
    warmingBody:
      "Type checking, hovers, completion, and generated C are already live. Once the C compiler, linker, optimizer, and browser SDK finish caching, Run compiles and executes entirely in this tab.",
    tier1: "Instant · type checking, hovers, completion, generated C",
    tier2: "Compile & link · C99 compiler, linker, optimizer, and browser SDK",
    tierProgress: (loaded: string, total: string) => `${loaded} of ${total} MiB`,
    eta: (leftMiB: string, seconds: number, rateMiB: string) =>
      `${leftMiB} MiB left · ~${seconds} s at ${rateMiB} MiB/s`,
    checkingLive: "You can edit, inspect types, and read generated C while this finishes.",
    clearCache: "Clear cache",
    panelTitle: "Toolchain",
    panelHint: "Inspect cached assets or clear storage",
    tierReady: "cached in this browser",
    tierPending: "not downloaded yet",
    cacheCleared: "Cache cleared; the toolchain will fetch again on your next visit.",
    sessionOnly: "Session-only cache (persistent storage unavailable in this browser)",
    toolchainFailed: (message: string) => `Toolchain setup failed: ${message}`,
  },
  output: {
    empty: "Press Run (Ctrl/⌘+Enter) to compile to WebAssembly and execute in this tab.",
    header: (entry: string) => `▸ run ${entry} · browser · validation`,
    stale: (ago: string) => `${ago}, before your last edit`,
    returned: (status: number) => `(returned, status ${status})`,
    failed: (status: number) => `(failed, status ${status})`,
    exited: (status: number) => `(exited, status ${status})`,
    stopped: (seconds: string) =>
      `■ stopped by you after ${seconds} s — execution stopped, toolchain kept warm`,
    stoppedStatus: "(stopped, no exit status)",
    stdinHint: "stdin: not connected",
    stdinTitle: "Program input",
    stdinConnect: "Connect as stdin",
    stdinPlaceholder: "Text read by os.stdin (empty sends EOF)",
    stdinConnected: (bytes: number) =>
      bytes === 1 ? "stdin: 1 byte connected" : `stdin: ${bytes} bytes connected`,
    folded: (n: number) =>
      n === 1 ? "1 standard-library frame" : `${n} standard-library frames`,
    receiptKicker: "Last run",
    receiptTotal: (ms: number) => `${ms} ms total`,
    receiptNote: "compiled in this tab · warm toolchain",
    receiptNoteCold: "compiled in this tab",
    segments: {
      check: "check",
      compile: "compile C",
      link: "link + optimize",
      run: "run",
    },
    reused: (names: string) => `${names} reused`,
    chipReady: "ready",
    chipRunning: (clock: string) => `running ${clock}`,
    chipRanIn: (ms: number) => `ran in ${ms} ms`,
    chipFailed: "failed",
    chipStage: (stage: string) => `${stage}…`,
    chipStopped: "stopped",
  },
  preview: {
    kicker: "Live preview",
    sandbox: "sandboxed iframe",
    bindings: "bindings",
    console: "Console",
    consoleChannels: "stdout · stderr",
    empty:
      "Open a browser example or add bindings.js, then press Run to launch an isolated preview.",
    frameTitle: (entry: string) => `Sandboxed Titan preview for ${entry}`,
    noOutput: "No output yet.",
  },
  problems: {
    none: (ms: number) => `No problems · checked in ${ms} ms`,
    errorKicker: "Error",
    warningKicker: "Warning",
    cardSource: "titanc check · as you type",
    compileSource: "titanc check · current source",
    runtimeSource: "runtime · last run",
    stale: "stale after edit",
  },
  inspect: {
    generatedC: "Generated C",
    entry: "entry",
    lines: (n: string) => `${n} lines`,
    linked: (cLine: number, file: string, line: number) => `C:${cLine} ↔ ${file}:${line}`,
    empty: "Resolve syntax or type errors to inspect the C99 generated by titanc.",
    wasmTitle: "Wasm image",
    wasmTotal: (mib: string) => `${mib} MiB · validation`,
    wasmEmpty:
      "Run the project once to inspect its linked WebAssembly sections and download a deployable bundle.",
    downloadBundle: "Download bundle ↓",
    stale: "from before your last edit",
  },
  files: {
    project: "Project",
    stdlib: "Standard library",
    readOnly: "read-only",
    privacy: "Nothing is uploaded; Share encodes files locally in the URL.",
    persistence: "Edits persist locally in this browser.",
    rename: "Rename",
    remove: "Delete",
    removeConfirm: (path: string) => `Delete “${path}” from this project?`,
    invalidPath: (reason: string) => `Invalid file path: ${reason}`,
    lines: (n: number) => `${n} ln`,
  },
  share: {
    copied: "Link copied",
    tooLarge: (kib: string) =>
      `Share link is ${kib} KiB compressed (over 16 KiB). Download the project instead.`,
    failed: (message: string) => `Could not copy share link: ${message}`,
    loadFailed: (message: string) => `Could not open share link: ${message}`,
  },
  download: {
    building: "Building bundle…",
    done: "Bundle downloaded",
    failed: (message: string) => `Bundle export failed: ${message}`,
  },
  shortcuts: {
    run: "⌘↵",
    stop: "Esc",
  },
  landing: {
    kicker: "Browser Playground · Zero Server",
    title: "Compile and run Titan in your browser",
    body: "Edit multi-module Titan and inspectable JavaScript bindings in one tab. Live type checking, hovers, completion, and C99 generation run in WebAssembly; Run links a standalone browser binary with clickable source-mapped stack traces.",
    cta: "Open the Playground",
  },
} as const;

export type PlaygroundCopy = typeof copy;
