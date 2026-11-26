// The /play/ controller: project, editor, toolchain lamps, runs, and panes.
import { copy } from "../content/copy";
import {
  createEngine,
  decodeShare,
  encodeShare,
  exportBundle,
  MANIFEST_URL,
  SHARE_WARN_BYTES,
  TIER1_PATHS,
  TIER2_PATHS,
} from "../engine";
import { examples } from "../examples";
import type {
  Build,
  Diagnostic,
  Engine,
  EngineRequestError,
  ExampleDefinition,
  Files,
  Project,
  Progress,
  RunEvent,
  Stage,
} from "../types";
import { el, part } from "./dom";
import { createEditor, isTitanPath } from "./editor";
import { createFiles } from "./files";
import { formatAgo, formatClock, formatMiB } from "./format";
import { createGallery } from "./gallery";
import { createInspect } from "./inspect";
import { faultLocation, renderReceipt, Terminal, type Frame } from "./output";
import { createToolchainPanel, type TierView } from "./panel";
import { bindPopover } from "./popover";
import { BINDINGS, BINDINGS_TEMPLATE, ENTRY, ProjectStore } from "./project";
import { renderWarming, tierPercent, type AssetProgress } from "./warming";

type Tab = "output" | "preview" | "problems" | "inspect";
/** Narrow layouts show one pane at a time: the editor or one output tab. */
type Segment = "code" | Tab;
type LampState = "queued" | "warming" | "active" | "ready" | "error";
type TierState = "loading" | "deferred" | "ready" | "failed";

const TABS: Tab[] = ["output", "preview", "problems", "inspect"];
const STAGES: Stage[] = ["check", "compile", "link"];
const CHECK_DEBOUNCE_MS = 150;
const SPLIT_KEY = "titan-playground-split";

function isRequestError(error: unknown): error is EngineRequestError {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether to hold the compile & link download until the first Run (Save-Data or cellular). */
function prefersDeferredDownload(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  return connection?.saveData === true || connection?.type === "cellular";
}

function readSplit(): number {
  try {
    return Number(localStorage.getItem(SPLIT_KEY)) || 0.52;
  } catch {
    return 0.52;
  }
}

/** A built image together with the exact project snapshot it was built from. */
interface Built {
  revision: number;
  project: Project;
  build: Build;
}

export function startPlayground(app: HTMLElement): void {
  const version = app.dataset.version ?? "";

  // -------------------------------------------------------------------------
  // Project selection: share fragment, then ?example=, then saved edits, then the default.

  const bySlug = new Map(examples.map((example) => [example.slug, example]));
  const requestedSlug = new URLSearchParams(location.search).get("example");
  let project =
    (requestedSlug && bySlug.has(requestedSlug)
      ? ProjectStore.fromExample(bySlug.get(requestedSlug) as ExampleDefinition)
      : null) ??
    ProjectStore.restore() ??
    ProjectStore.fromExample(examples[0]);

  // -------------------------------------------------------------------------
  // State

  let engine: Engine | null = null;
  let tier1: TierState = "loading";
  let tier2: TierState = "loading";
  let toolchainError: string | null = null;
  let sessionOnly = false;
  /** Eager toolchain assets, sized from the manifest so progress has a fixed denominator. */
  const assets = new Map<string, AssetProgress>();
  let deferredMiB: string | null = null;
  /** A Run pressed while the deferred toolchain was still downloading. */
  let pendingRun = false;

  let syncedRevision = 0;
  let checkTimer = 0;
  let checkMs: number | null = null;
  let diagnostics: Diagnostic[] = [];
  let emitRevision = 0;

  let tab: Tab = "output";
  const library: string[] = [];
  let libraryFiles: Files | null = null;
  let stdin: string | undefined;

  let runEpoch = 0;
  let running: { stop(): void } | null = null;
  let building = false;
  let runStarted = 0;
  let clockTimer = 0;
  let runTerminals: Terminal[] = [];
  let lastBuilt: Built | null = null;
  /** Whether a build has already run on this page's loaded toolchain. */
  let toolchainWarm = false;
  let lastRun: { revision: number; at: number; headers: HTMLElement[] } | null = null;
  let runtimeFault: { message: string; frame: Frame | null; revision: number } | null = null;
  const lamps: Record<Stage, { state: LampState; note: string }> = {
    check: { state: "warming", note: "" },
    compile: { state: "queued", note: "" },
    link: { state: "queued", note: "" },
  };

  // -------------------------------------------------------------------------
  // Elements

  const runButtons = [part<HTMLButtonElement>(app, "run"), part<HTMLButtonElement>(app, "mobile-run")];
  const pipeline = part(app, "pipeline");
  const pipelineStatus = part(app, "pipeline-status");
  const statusChip = part(app, "status-chip");
  const sheet = part(app, "sheet");
  const problemCount = part(app, "problem-count");
  const problemList = part(app, "problems");
  const receipt = part(app, "receipt");
  const warming = part(app, "warming");
  const editorStatus = part(app, "editor-status");
  const previewHost = part(app, "preview-host");
  const previewEmpty = part(app, "preview-empty");
  const bindingsRow = part(app, "bindings-row");
  const bindingsList = part(app, "bindings-list");
  const previewClock = part(app, "preview-clock");
  const toast = part(app, "toast");
  const exampleTitle = part(app, "example-title");

  const traceHooks = {
    open: (frame: Frame) => void openFrame(frame),
    sources: () => [...Object.keys(project.files).filter(isTitanPath), ...Object.keys(libraryFiles ?? {})],
  };
  const terminal = new Terminal(part(app, "terminal"), traceHooks);
  const previewConsole = new Terminal(part(app, "preview-console"), traceHooks);

  // -------------------------------------------------------------------------
  // Editor and file views

  let cursorLine = 1;
  let cursorColumn = 1;

  const editor = createEditor(part(app, "editor"), {
    onChange(path, text) {
      if (!Object.hasOwn(project.files, path)) return;
      project.edit(path, text);
      afterEdit();
      scheduleFiles();
    },
    onCursor(path, line, column) {
      cursorLine = line;
      cursorColumn = column;
      renderEditorStatus();
      if (tab === "inspect" && isTitanPath(path)) inspect.followSource(path, line);
    },
    hover: async (path, offset) => {
      if (!engine || tier1 !== "ready") return null;
      return quietly(async (revision) => engine?.request("hover", { path, offset }, revision) ?? null);
    },
    complete: async (path, offset) => {
      if (!engine || tier1 !== "ready") return null;
      return quietly(async (revision) => engine?.request("complete", { path, offset }, revision) ?? null);
    },
    run: () => void run(),
    share: () => void share(),
    toggleDrawer: () => toggleDrawer(),
    cardKicker: (severity) => (severity === "error" ? copy.problems.errorKicker : copy.problems.warningKicker),
    cardSource: copy.problems.cardSource,
  });

  const files = createFiles(app, {
    open: (path) => openFile(path),
    create(path) {
      project.add(path, "");
      afterStructureChange();
      openFile(path);
    },
    rename(from, to) {
      project.rename(from, to);
      editor.forget(from);
      afterStructureChange();
      openFile(to);
    },
    remove(path) {
      const wasCurrent = editor.current() === path;
      project.remove(path);
      editor.forget(path);
      afterStructureChange();
      if (wasCurrent) openFile(ENTRY);
    },
    addBindings() {
      project.add(BINDINGS, BINDINGS_TEMPLATE);
      afterStructureChange();
      openFile(BINDINGS);
    },
    closeLibrary(path) {
      library.splice(library.indexOf(path), 1);
      if (editor.current() === path) openFile(ENTRY);
      renderFiles();
    },
    loadLibrary: () => loadLibrary(),
    openDrawer: () => setDrawer(true),
  });

  const inspect = createInspect(part(app, "inspect"), {
    revealSource(path, line) {
      if (!Object.hasOwn(project.files, path)) return;
      openFile(path);
      editor.reveal(path, line);
    },
    download: () => void download(),
  });

  const gallery = createGallery(part(app, "gallery"), part<HTMLButtonElement>(app, "example-btn"), examples, (example) => {
    if (project.changed && !window.confirm(copy.gallery.replaceConfirm(example.title))) return;
    history.replaceState(null, "", `${location.pathname}?example=${encodeURIComponent(example.slug)}`);
    loadProject(ProjectStore.fromExample(example));
  });

  const panel = createToolchainPanel(part(app, "toolchain"), pipeline, {
    clearCache: () => void clearCache(),
    stdin(value) {
      stdin = value;
    },
  });

  const more = bindPopover(part(app, "more-menu"), part(app, "more"));
  for (const item of app.querySelectorAll<HTMLElement>("[data-more]")) {
    item.addEventListener("click", () => {
      more.close();
      const action = item.dataset.more;
      if (action === "problems" || action === "inspect") setSegment(action);
      else if (action === "download") void download();
      else if (action === "toolchain") panel.open();
    });
  }

  let filesFrame = 0;
  function scheduleFiles() {
    if (filesFrame) return;
    filesFrame = requestAnimationFrame(() => {
      filesFrame = 0;
      renderFiles();
    });
  }

  function renderFiles() {
    const errors = new Set<string>();
    for (const diagnostic of diagnostics) if (diagnostic.at) errors.add(diagnostic.at.path);
    files.render({
      paths: project.paths(),
      active: editor.current(),
      library,
      errors,
      dirty: project.dirty,
      lines: (path) => (project.files[path] ?? "").split("\n").length,
    });
  }

  function openFile(path: string) {
    if (Object.hasOwn(project.files, path)) {
      editor.open(path, project.files[path]);
    } else if (libraryFiles && Object.hasOwn(libraryFiles, path)) {
      if (!library.includes(path)) library.push(path);
      editor.open(path, libraryFiles[path], true);
    } else {
      return;
    }
    renderFiles();
    if (app.dataset.compact === "true") {
      setDrawer(false);
      if (app.dataset.mseg !== "code") setSegment("code");
    }
  }

  async function loadLibrary(): Promise<Files> {
    if (libraryFiles) return libraryFiles;
    if (!engine) return {};
    libraryFiles = await engine.request("stdlib", null, 0);
    return libraryFiles;
  }

  async function openFrame(frame: Frame) {
    if (!Object.hasOwn(project.files, frame.path)) await loadLibrary();
    openFile(frame.path);
    // Hosts that print no line numbers name only the file; open it without inventing a line.
    if (frame.line !== null) editor.reveal(frame.path, frame.line);
  }

  function afterEdit() {
    forgetLink();
    markStale();
    scheduleCheck();
  }

  function afterStructureChange() {
    afterEdit();
    renderFiles();
    renderPreviewEmpty();
  }

  /** Edits are saved locally, so a reload should restore them rather than reopen the link. */
  function forgetLink() {
    if (location.search || location.hash) history.replaceState(null, "", location.pathname);
  }

  function loadProject(next: ProjectStore) {
    if (running) stop();
    // An in-flight build belongs to the project being replaced; its result is dropped.
    runEpoch++;
    building = false;
    pendingRun = false;
    for (const path of [...Object.keys(project.files), ...library]) editor.forget(path);
    library.length = 0;
    project = next;
    diagnostics = [];
    runtimeFault = null;
    lastBuilt = null;
    lastRun = null;
    emitRevision = 0;
    editor.setDiagnostics(new Map());
    editor.setRuntimeMark(null, 0, "");
    inspect.showEmit(null);
    inspect.showBuild(null);
    inspect.setStale(false, false);
    terminal.clear();
    previewConsole.clear();
    receipt.hidden = true;
    const example = project.origin.kind === "example" ? bySlug.get(project.origin.slug) : undefined;
    exampleTitle.textContent =
      example?.title ?? (project.origin.kind === "share" ? copy.gallery.sharedProject : copy.gallery.ownProject);
    gallery.select(example?.slug ?? null);
    openFile(ENTRY);
    for (const stage of STAGES) if (lamps[stage].state === "active") setLamp(stage, "ready", "");
    renderRunButtons();
    renderProblems();
    renderPreviewEmpty();
    renderOutputIdle();
    renderStatus();
    scheduleCheck(0);
  }

  // -------------------------------------------------------------------------
  // Checking

  function scheduleCheck(delay = CHECK_DEBOUNCE_MS) {
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => void check(), delay);
  }

  /** Sends the current snapshot if the compiler has an older one, returning its revision. */
  async function ensureSynced(): Promise<number> {
    const revision = project.revision;
    if (engine && syncedRevision < revision) {
      await engine.request("sync", { revision, files: project.titanFiles() }, revision);
      syncedRevision = Math.max(syncedRevision, revision);
    }
    return revision;
  }

  /** Runs a request against the current snapshot, dropping stale or failed answers. */
  async function quietly<T>(request: (revision: number) => Promise<T | null>): Promise<T | null> {
    try {
      const revision = await ensureSynced();
      const value = await request(revision);
      return revision === project.revision ? value : null;
    } catch {
      return null;
    }
  }

  async function check() {
    if (!engine || tier1 !== "ready") return;
    const revision = project.revision;
    try {
      await ensureSynced();
      setLamp("check", "active", lamps.check.note);
      const started = performance.now();
      const result = await engine.request("check", null, revision);
      if (revision !== project.revision) return;
      checkMs = Math.round(performance.now() - started);
      applyDiagnostics(result);
      if (tab === "inspect") void refreshEmit();
    } catch (error) {
      if (isRequestError(error) && error.code === "stale") return;
      if (revision !== project.revision) return;
      setLamp("check", "error", "");
      showToolchainFailure(errorMessage(error));
    }
  }

  function applyDiagnostics(list: Diagnostic[]) {
    diagnostics = list;
    const byPath = new Map<string, Diagnostic[]>();
    for (const diagnostic of list) {
      if (!diagnostic.at) continue;
      byPath.set(diagnostic.at.path, [...(byPath.get(diagnostic.at.path) ?? []), diagnostic]);
    }
    editor.setDiagnostics(byPath);
    const errors = list.filter((diagnostic) => diagnostic.severity === "error").length;
    if (errors > 0) setLamp("check", "error", copy.pipeline.errors(errors));
    else setLamp("check", "ready", checkMs === null ? copy.pipeline.live : `${checkMs} ms`);
    renderProblems();
    renderFiles();
    renderEditorStatus();
  }

  async function refreshEmit() {
    if (!engine || tier1 !== "ready") return;
    const revision = project.revision;
    if (emitRevision === revision) return;
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      inspect.showEmit(null);
      return;
    }
    const emit = await quietly(async (synced) => engine?.request("emit_c", null, synced) ?? null);
    if (!emit || revision !== project.revision) return;
    emitRevision = revision;
    inspect.showEmit(emit);
    renderInspectStale();
    const current = editor.current();
    if (current && isTitanPath(current)) inspect.followSource(current, cursorLine);
  }

  function renderInspectStale() {
    inspect.setStale(emitRevision !== project.revision, lastBuilt !== null && lastBuilt.revision !== project.revision);
  }

  // -------------------------------------------------------------------------
  // Toolchain lamps, warming and the toolchain panel

  function setLamp(stage: Stage, state: LampState, note: string, percent?: number) {
    lamps[stage] = { state, note };
    const lamp = pipeline.querySelector<HTMLElement>(`[data-stage="${stage}"]`);
    if (lamp) {
      lamp.dataset.state = state;
      lamp.style.setProperty("--p", `${percent ?? 0}%`);
      const small = lamp.querySelector("small");
      if (small) small.textContent = note;
    }
    // Lamps carry colour; the live region carries the same facts as text.
    pipelineStatus.textContent = STAGES.map((name) =>
      [copy.pipeline.stages[name], lamps[name].note].filter(Boolean).join(" "),
    ).join(" · ");
  }

  function tierView(state: TierState, tier: 1 | 2): TierView {
    const percent = tierPercent([...assets.values()], tier);
    if (state === "ready") return { state: "ready", percent: 100 };
    if (state === "deferred") return { state: "pending", percent };
    if (state === "failed") return { state: "failed", percent };
    return { state: "loading", percent };
  }

  let warmingFrame = 0;
  function onProgress(progress: Progress) {
    if (progress.event === "storage") {
      sessionOnly = !progress.persistent;
      renderToolchain();
      return;
    }
    if (progress.event === "asset") {
      // Only eager assets count toward the tiers; Three, notices and lazy sources load on demand.
      const known = assets.get(progress.path);
      if (!known) return;
      assets.set(progress.path, {
        ...known,
        loaded: progress.loaded,
        total: progress.total || known.total,
        cached: progress.cached,
        started: known.started ?? performance.now(),
      });
      if (!warmingFrame) {
        warmingFrame = requestAnimationFrame(() => {
          warmingFrame = 0;
          renderToolchain();
        });
      }
      return;
    }
    if (progress.revision !== project.revision) return;
    if (progress.state === "start") {
      setLamp(progress.stage, "active", "");
      renderStatus(copy.output.chipStage(copy.pipeline.stages[progress.stage].toLowerCase()), "run");
    } else {
      setLamp(progress.stage, "ready", progress.ms === undefined ? "" : `${Math.round(progress.ms)} ms`);
    }
  }

  function renderToolchain() {
    const percent1 = tierPercent([...assets.values()], 1);
    const percent2 = tierPercent([...assets.values()], 2);
    if (tier1 === "loading") setLamp("check", "warming", percent1 === null ? "" : `${percent1}%`, percent1 ?? 0);
    if (tier2 === "loading") {
      setLamp("compile", "warming", percent2 === null ? "" : `${percent2}%`, percent2 ?? 0);
      setLamp("link", "queued", "");
    }
    panel.render({ tier1: tierView(tier1, 1), tier2: tierView(tier2, 2), sessionOnly });
    renderRunButtons();
    renderOutputIdle();
  }

  function renderOutputIdle() {
    const showWarming = (tier1 === "loading" || tier2 === "loading") && !lastRun && !building && !running;
    warming.hidden = !showWarming;
    terminal.element.hidden = showWarming;
    if (showWarming) {
      renderWarming(warming, [...assets.values()], { checkingLive: tier1 === "ready", sessionOnly });
    } else if (!lastRun && !building && !running && terminal.element.childElementCount === 0) {
      terminal.line(
        toolchainError ? copy.pipeline.toolchainFailed(toolchainError) : copy.output.empty,
        toolchainError ? "pg-stderr" : "pg-meta",
      );
    }
  }

  function showToolchainFailure(message: string) {
    toolchainError = message;
    renderStatus(copy.output.chipFailed, "err");
    if (!lastRun && !running) {
      terminal.clear();
      renderOutputIdle();
    }
  }

  async function warmTier2() {
    if (!engine) return;
    tier2 = "loading";
    renderToolchain();
    try {
      await engine.request("warm", { tier: 2 }, 0);
      tier2 = "ready";
      setLamp("compile", "ready", copy.pipeline.cached);
      setLamp("link", "ready", "");
    } catch (error) {
      tier2 = "failed";
      pendingRun = false;
      setLamp("compile", "error", "");
      setLamp("link", "error", "");
      showToolchainFailure(errorMessage(error));
    }
    renderToolchain();
    if (tier2 === "ready" && pendingRun) {
      pendingRun = false;
      void run();
    }
  }

  /** Sizes every eager asset from the manifest, so tiers have a stable denominator. */
  async function loadManifestSizes() {
    try {
      const manifest: unknown = await (await fetch(MANIFEST_URL)).json();
      if (typeof manifest !== "object" || manifest === null || !("assets" in manifest) || !Array.isArray(manifest.assets)) return;
      const bytes = new Map<string, number>();
      for (const asset of manifest.assets) {
        if (typeof asset?.path === "string" && typeof asset.bytes === "number") bytes.set(asset.path, asset.bytes);
      }
      for (const [tier, paths] of [[1, TIER1_PATHS], [2, TIER2_PATHS]] as const) {
        for (const path of paths) {
          if (!assets.has(path)) assets.set(path, { tier, path, loaded: 0, total: bytes.get(path) ?? 0, cached: false, started: null });
        }
      }
      let tier2Bytes = 0;
      for (const path of TIER2_PATHS) tier2Bytes += bytes.get(path) ?? 0;
      deferredMiB = tier2Bytes > 0 ? formatMiB(tier2Bytes, 0) : null;
      renderToolchain();
    } catch {
      // Without the pointer, progress stays indeterminate; the engine reports the real failure.
    }
  }

  async function clearCache() {
    if (!engine) return;
    try {
      await engine.request("clearCache", null, 0);
      showToast(copy.pipeline.cacheCleared);
    } catch (error) {
      showToast(copy.pipeline.toolchainFailed(errorMessage(error)));
    }
  }

  async function boot() {
    const sizes = loadManifestSizes();
    try {
      engine = await createEngine(onProgress);
    } catch (error) {
      tier1 = "failed";
      tier2 = "failed";
      for (const stage of STAGES) setLamp(stage, "error", "");
      showToolchainFailure(errorMessage(error));
      renderToolchain();
      return;
    }
    tier1 = "ready";
    setLamp("check", "ready", copy.pipeline.live);
    scheduleCheck(0);
    await sizes;
    if (prefersDeferredDownload()) {
      tier2 = "deferred";
      setLamp("compile", "queued", "");
      setLamp("link", "queued", "");
      renderToolchain();
      return;
    }
    await warmTier2();
  }

  // -------------------------------------------------------------------------
  // Running

  function renderRunButtons() {
    const percent = tierPercent([...assets.values()], 2);
    for (const button of runButtons) {
      const compact = button.dataset.pg === "mobile-run";
      const label: (string | Node)[] = [];
      let disabled = false;
      if (running) {
        label.push(el("span", { class: "pg-stop-square", "aria-hidden": "true" }), copy.toolbar.stop);
        if (!compact) label.push(el("kbd", {}, copy.shortcuts.stop));
      } else if (tier2 === "deferred") {
        label.push(playIcon(), deferredMiB ? copy.toolbar.runDeferred(deferredMiB) : copy.toolbar.run);
      } else if (tier2 === "loading") {
        label.push(playIcon(), percent === null ? copy.toolbar.run : copy.toolbar.runWarming(percent));
        disabled = !pendingRun;
      } else {
        label.push(playIcon(), copy.toolbar.run);
        if (!compact) label.push(el("kbd", {}, copy.shortcuts.run));
      }
      button.replaceChildren(...label);
      button.classList.toggle("pg-btn-stop", running !== null);
      button.classList.toggle("pg-btn-run", running === null);
      button.title = running ? copy.toolbar.stopHint : copy.toolbar.runHint;
      button.setAttribute("aria-disabled", String(disabled || tier1 === "failed"));
      button.setAttribute("aria-busy", String(building || pendingRun));
    }
  }

  /** Labels output, Problems and Inspect from an earlier revision as stale. */
  function markStale() {
    renderInspectStale();
    if (!lastRun || lastRun.revision === project.revision) return;
    const stale = `${copy.output.header("main")} · ${copy.output.stale(formatAgo(performance.now() - lastRun.at))}`;
    for (const header of lastRun.headers) header.textContent = stale;
    renderProblems();
  }
  window.setInterval(markStale, 15_000);

  async function run() {
    if (running) {
      stop();
      return;
    }
    if (building || pendingRun || !engine || tier1 !== "ready") return;
    if (tier2 === "deferred" || tier2 === "failed") {
      // An explicit Run starts the download and runs once the toolchain is staged.
      pendingRun = true;
      void warmTier2();
      return;
    }
    if (tier2 !== "ready") return;

    building = true;
    const epoch = ++runEpoch;
    // Everything the run needs comes from one snapshot, whatever is edited meanwhile.
    const snapshot = project.project();
    const frame = project.usesFrame();
    const terms = frame ? [terminal, previewConsole] : [terminal];
    runTerminals = terms;
    runtimeFault = null;
    editor.setRuntimeMark(null, 0, "");
    terminal.clear();
    previewConsole.clear();
    receipt.hidden = true;
    bindingsList.replaceChildren();
    bindingsRow.hidden = true;
    const headers = terms.map((term) => term.line(copy.output.header("main")));
    lastRun = null;
    selectTab(frame ? "preview" : "output");
    // On phones a console run peeks from the sheet; a preview needs its own segment.
    if (frame && app.dataset.compact === "true") setSegment("preview");
    renderRunButtons();
    renderOutputIdle();
    renderStatus(copy.output.chipStage(copy.pipeline.stages.check.toLowerCase()), "run");

    let build: Build;
    let revision = project.revision;
    try {
      revision = await ensureSynced();
      build = await engine.request("build", null, revision);
    } catch (error) {
      if (epoch !== runEpoch) return;
      building = false;
      const stale = isRequestError(error) && error.code === "stale";
      // A stage that was running when the build ended did not finish.
      for (const stage of STAGES) if (lamps[stage].state === "active") setLamp(stage, stale ? "ready" : "error", "");
      renderRunButtons();
      if (isRequestError(error) && error.code === "diagnostics") {
        if (revision === project.revision) applyDiagnostics(error.diagnostics ?? diagnostics);
        for (const term of terms) term.exit(copy.output.chipFailed, false);
        renderStatus(copy.output.chipFailed, "err");
        selectTab("problems");
      } else if (!stale) {
        for (const term of terms) term.line(errorMessage(error), "pg-stderr");
        renderStatus(copy.output.chipFailed, "err");
      } else {
        renderStatus();
      }
      return;
    }
    if (epoch !== runEpoch) return;
    building = false;
    lastBuilt = { revision, project: snapshot, build };
    const cold = !toolchainWarm;
    toolchainWarm = true;
    inspect.showBuild(build);
    renderInspectStale();
    setLamp("compile", "ready", `${Math.round(build.ms.compile)} ms`);
    setLamp("link", "ready", `${Math.round(build.ms.link)} ms`);

    runStarted = performance.now();
    lastRun = { revision, at: runStarted, headers };
    previewHost.replaceChildren();
    previewEmpty.hidden = frame;
    running = engine.run({
      build,
      project: snapshot,
      revision,
      preview: previewHost,
      stdin,
      onEvent: (event) => {
        if (epoch === runEpoch) onRunEvent(event, build, revision, cold);
      },
    });
    markStale();
    renderRunButtons();
    clockTimer = window.setInterval(() => {
      const clock = formatClock(performance.now() - runStarted);
      previewClock.textContent = clock;
      if (running) renderStatus(copy.output.chipRunning(clock), "run");
    }, 100);
  }

  function finishRun() {
    running = null;
    window.clearInterval(clockTimer);
    renderRunButtons();
    renderPreviewEmpty();
  }

  function onRunEvent(event: RunEvent, build: Build, revision: number, cold: boolean) {
    switch (event.type) {
      case "stream":
        for (const term of runTerminals) term.stream(event.channel, event.bytes);
        return;
      case "console":
        for (const term of runTerminals) term.console(event.level, event.text);
        return;
      case "bindings":
        bindingsList.replaceChildren(...event.names.map((name) => el("code", {}, name)));
        bindingsRow.hidden = event.names.length === 0;
        return;
      case "ready":
        return;
      case "stop-request":
        stop();
        return;
      case "stopped":
        // After a failed or exited result the engine has already torn the run down.
        finishRun();
        return;
      case "error":
        for (const term of runTerminals) term.line(event.message, "pg-stderr");
        renderStatus(copy.output.chipFailed, "err");
        return;
      case "result":
        void showResult(event, build, revision, cold);
        return;
    }
  }

  async function showResult(event: Extract<RunEvent, { type: "result" }>, build: Build, revision: number, cold: boolean) {
    const epoch = runEpoch;
    const runMs = performance.now() - runStarted;
    const frame = runTerminals.includes(previewConsole);
    // A preview stays live after main returns while it can still receive events.
    if (!frame || event.kind !== "returned") finishRun();
    const decoder = new TextDecoder();
    const message = decoder.decode(event.bytes);
    const trace = decoder.decode(event.trace);
    // Trace frames may name library files; resolve them against the real sources.
    if (event.kind === "failed") await loadLibrary().catch(() => null);
    if (epoch !== runEpoch) return;
    for (const term of runTerminals) {
      if (event.kind === "failed") term.failure(message, trace);
      const exit =
        event.kind === "returned"
          ? copy.output.returned(event.status)
          : event.kind === "exited"
            ? copy.output.exited(event.status)
            : copy.output.failed(event.status);
      term.exit(exit, event.kind !== "failed" && event.status === 0);
      if (!frame) term.line(stdin === undefined ? copy.output.stdinHint : copy.output.stdinConnected(new TextEncoder().encode(stdin).byteLength), "pg-stdin-hint");
    }
    if (lastRun) lastRun.at = performance.now();
    renderReceipt(receipt, build, runMs, cold);
    if (event.kind === "failed") {
      const location = faultLocation(message, trace, traceHooks.sources());
      runtimeFault = { message, frame: location, revision };
      if (location?.line != null) editor.setRuntimeMark(location.path, location.line, message);
      renderStatus(copy.output.chipFailed, "err");
    } else {
      renderStatus(copy.output.chipRanIn(Math.round(build.ms.check + build.ms.compile + build.ms.link + runMs)));
    }
    renderProblems();
    markStale();
  }

  function stop(byUser = true) {
    if (!running) return;
    running.stop();
    runEpoch++;
    if (byUser) {
      const seconds = ((performance.now() - runStarted) / 1000).toFixed(1);
      for (const term of runTerminals) {
        term.line(copy.output.stopped(seconds));
        term.line(copy.output.stoppedStatus);
      }
      renderStatus(copy.output.chipStopped);
    }
    finishRun();
  }

  // -------------------------------------------------------------------------
  // Status, problems and panes

  function renderStatus(text: string = copy.output.chipReady, kind: "" | "err" | "run" | "warming" = "") {
    for (const target of [statusChip, sheet]) {
      target.dataset.kind = kind;
      const label = target.querySelector("[data-pg-text]");
      if (label) label.textContent = text;
    }
  }

  function renderEditorStatus() {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const current = editor.current();
    const lines = current ? (project.files[current] ?? libraryFiles?.[current] ?? "").split("\n").length : 0;
    const check =
      tier1 !== "ready"
        ? el("span", {}, `● ${copy.pipeline.stages.check} ${lamps.check.note}`)
        : errors > 0
          ? el("span", { class: "pg-err" }, `● ${copy.pipeline.errors(errors)}`)
          : el("span", { class: "pg-ok" }, `● ${checkMs === null ? copy.pipeline.live : copy.problems.none(checkMs)}`);
    editorStatus.replaceChildren(
      check,
      el("span", { class: "pg-spacer" }),
      el("span", { class: "pg-mono" }, `Ln ${cursorLine}, Col ${cursorColumn}`),
      el("span", { class: "pg-mono" }, copy.files.lines(lines)),
      el("span", {}, `Titan ${version}`),
    );
  }

  function renderProblems() {
    const rows: HTMLElement[] = [];
    for (const diagnostic of diagnostics) {
      const at = diagnostic.at;
      const position = at ? locate(at.path, at.from) : null;
      const row = el(
        "li",
        { class: `pg-problem pg-problem-${diagnostic.severity}`, tabindex: "0" },
        el("span", { class: "pg-problem-icon", "aria-hidden": "true" }, "●"),
        el("span", { class: "pg-problem-msg" }, diagnostic.message),
        el("span", { class: "pg-problem-loc" }, position ? `${position.path}:${position.line}:${position.column}` : ""),
        el("span", { class: "pg-problem-src" }, copy.problems.compileSource),
      );
      if (position) {
        const go = () => {
          openFile(position.path);
          editor.reveal(position.path, position.line);
        };
        row.addEventListener("click", go);
        row.addEventListener("keydown", (event) => event.key === "Enter" && go());
      }
      rows.push(row);
    }
    if (runtimeFault) {
      const fault = runtimeFault;
      const stale = fault.revision !== project.revision;
      const where = fault.frame ? (fault.frame.line === null ? fault.frame.path : `${fault.frame.path}:${fault.frame.line}`) : "";
      const row = el(
        "li",
        { class: "pg-problem pg-problem-runtime", tabindex: "0" },
        el("span", { class: "pg-problem-icon", "aria-hidden": "true" }, "▲"),
        el("span", { class: "pg-problem-msg" }, fault.message),
        el("span", { class: "pg-problem-loc" }, where),
        el("span", { class: "pg-problem-src" }, stale ? `${copy.problems.runtimeSource} · ${copy.problems.stale}` : copy.problems.runtimeSource),
      );
      if (fault.frame) {
        const target = fault.frame;
        row.addEventListener("click", () => void openFrame(target));
        row.addEventListener("keydown", (event) => event.key === "Enter" && void openFrame(target));
      }
      rows.push(row);
    }
    problemList.replaceChildren(
      ...(rows.length > 0
        ? rows
        : [el("li", { class: "pg-problem-none" }, checkMs === null ? copy.pipeline.live : copy.problems.none(checkMs))]),
    );
    problemCount.hidden = rows.length === 0;
    problemCount.textContent = String(rows.length);
  }

  function locate(path: string, offset: number): { path: string; line: number; column: number } {
    const before = (project.files[path] ?? "").slice(0, offset);
    return { path, line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
  }

  function renderPreviewEmpty() {
    previewEmpty.hidden = previewHost.childElementCount > 0;
  }

  function selectTab(next: Tab) {
    tab = next;
    for (const button of app.querySelectorAll<HTMLElement>("[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === next));
    }
    for (const panelElement of app.querySelectorAll<HTMLElement>("[data-panel]")) {
      panelElement.hidden = panelElement.dataset.panel !== next;
    }
    if (next === "inspect") void refreshEmit();
    if (app.dataset.compact === "true" && app.dataset.mseg !== "code") setSegment(next);
  }

  function setSegment(segment: Segment) {
    app.dataset.mseg = segment;
    for (const button of app.querySelectorAll<HTMLElement>("[data-segment]")) {
      button.setAttribute("aria-selected", String(button.dataset.segment === segment));
    }
    if (segment === "code") requestAnimationFrame(() => editor.view.requestMeasure());
    else if (tab !== segment) selectTab(segment);
  }

  function setDrawer(open: boolean) {
    app.dataset.drawer = open ? "open" : "closed";
    for (const button of app.querySelectorAll<HTMLElement>("[data-pg=drawer-toggle], [data-pg=mobile-files]")) {
      button.setAttribute("aria-pressed", String(open));
    }
  }

  function toggleDrawer() {
    setDrawer(app.dataset.drawer !== "open");
  }

  let toastTimer = 0;
  function showToast(...children: (string | Node)[]) {
    window.clearTimeout(toastTimer);
    toast.replaceChildren(...children);
    toast.hidden = false;
    toastTimer = window.setTimeout(() => (toast.hidden = true), 3200);
  }

  async function share() {
    try {
      const fragment = await encodeShare(project.project());
      const compressed = Math.floor(((fragment.length - "#v1=".length) * 3) / 4);
      if (compressed > SHARE_WARN_BYTES) {
        const button = el("button", { type: "button", class: "pg-link-button" }, copy.toolbar.download);
        button.addEventListener("click", () => void download());
        showToast(el("span", {}, copy.share.tooLarge((compressed / 1024).toFixed(1))), button);
        return;
      }
      const url = `${location.origin}${location.pathname}${fragment}`;
      await navigator.clipboard.writeText(url);
      showToast(el("span", {}, copy.share.copied), el("code", {}, `${location.host}${location.pathname}#v1=…`));
    } catch (error) {
      showToast(copy.share.failed(errorMessage(error)));
    }
  }

  async function download() {
    if (!engine) return;
    try {
      // The zip pairs an image with the exact sources it was built from.
      let built = lastBuilt?.revision === project.revision ? lastBuilt : null;
      if (!built) {
        if (tier2 === "deferred" || tier2 === "failed") void warmTier2();
        if (tier2 !== "ready") return;
        showToast(copy.download.building);
        const snapshot = project.project();
        const revision = await ensureSynced();
        built = { revision, project: snapshot, build: await engine.request("build", null, revision) };
        toolchainWarm = true;
        if (revision === project.revision) {
          lastBuilt = built;
          inspect.showBuild(built.build);
          renderInspectStale();
        }
      }
      const blob = await exportBundle(built.project, built.build.image);
      const url = URL.createObjectURL(blob);
      el("a", { href: url, download: "titan-playground.zip" }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      showToast(copy.download.done);
    } catch (error) {
      showToast(copy.download.failed(errorMessage(error)));
    }
  }

  // -------------------------------------------------------------------------
  // Wiring

  for (const button of app.querySelectorAll<HTMLElement>("[data-tab]")) {
    button.addEventListener("click", () => selectTab(button.dataset.tab as Tab));
  }
  for (const button of app.querySelectorAll<HTMLElement>("[data-segment]")) {
    button.addEventListener("click", () => setSegment(button.dataset.segment as Segment));
  }
  for (const button of runButtons) button.addEventListener("click", () => void run());
  for (const button of app.querySelectorAll<HTMLElement>("[data-pg=share], [data-pg=mobile-share]")) {
    button.addEventListener("click", () => void share());
  }
  part(app, "download").addEventListener("click", () => void download());
  part(app, "drawer-toggle").addEventListener("click", () => toggleDrawer());
  part(app, "mobile-files").addEventListener("click", () => toggleDrawer());
  sheet.addEventListener("click", () => setSegment("output"));

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      void run();
    } else if (event.key === "Escape" && running) {
      stop();
    } else if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void share();
    } else if (mod && event.key.toLowerCase() === "b") {
      event.preventDefault();
      toggleDrawer();
    } else if (event.altKey && /^Digit[1-4]$/.test(event.code)) {
      event.preventDefault();
      selectTab(TABS[Number(event.code.slice(5)) - 1]);
    }
  });

  // Splitter: drag or arrow keys move the editor/output split in 5% steps.
  const splitter = part(app, "splitter");
  const workspace = part(app, "workspace");
  let split = readSplit();
  const applySplit = (value: number) => {
    split = Math.min(0.8, Math.max(0.2, value));
    workspace.style.setProperty("--pg-left", `${split}fr`);
    workspace.style.setProperty("--pg-right", `${1 - split}fr`);
    splitter.setAttribute("aria-valuenow", String(Math.round(split * 100)));
    try {
      localStorage.setItem(SPLIT_KEY, String(split));
    } catch {
      // Not persisted; the split still applies.
    }
  };
  applySplit(split);
  splitter.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") applySplit(split - 0.05);
    else if (event.key === "ArrowRight") applySplit(split + 0.05);
  });
  splitter.addEventListener("pointerdown", (event) => {
    splitter.setPointerCapture(event.pointerId);
    const editorRect = part(app, "editor-pane").getBoundingClientRect();
    const paneRect = part(app, "output-pane").getBoundingClientRect();
    const move = (moveEvent: PointerEvent) =>
      applySplit((moveEvent.clientX - editorRect.left) / (paneRect.right - editorRect.left));
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });

  // The narrow layout is a container query; mirror it for behaviour (segments vs tabs).
  new ResizeObserver(([entry]) => {
    const compact = entry.contentRect.width <= 760;
    if (String(compact) === app.dataset.compact) return;
    app.dataset.compact = String(compact);
    setSegment(compact ? "code" : tab);
  }).observe(app);

  window.addEventListener("hashchange", () => void loadShare());

  async function loadShare(): Promise<boolean> {
    if (!location.hash.startsWith("#v1=")) return false;
    try {
      loadProject(ProjectStore.fromShare(await decodeShare(location.hash)));
      return true;
    } catch (error) {
      showToast(copy.share.loadFailed(errorMessage(error)));
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Start

  setDrawer(false);
  selectTab("output");
  panel.render({ tier1: tierView(tier1, 1), tier2: tierView(tier2, 2), sessionOnly });
  loadProject(project);
  void loadShare().then(() => boot());
}

function playIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4.5 3.1v9.8a.6.6 0 00.9.5l7.9-4.9a.6.6 0 000-1L5.4 2.6a.6.6 0 00-.9.5z");
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
