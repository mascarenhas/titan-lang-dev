// The persistent compiler Worker. It owns titanc.wasm, the YoWASP toolchain,
// Binaryen and the object cache; it never runs a program, so Stop never
// touches it. Compiler jobs run one at a time in arrival order while asset
// downloads proceed beside them, and a job for an older snapshot revision
// fails as `stale` instead of checking other text. Replies copy their
// payloads: the Builder keeps the last image for reuse.

import type { Files, Op, Operations, Progress, Reply, Request, Snapshot } from '../types.ts';
import { AssetManager, manifestHash } from './assets.ts';
import { Builder, DiagnosticsError, openCompiler, Toolchain, titanSources, type Compiler } from './toolchain.ts';

// The dedicated Worker scope; the site type-checks against the DOM library only.
declare const self: {
  postMessage(message: Reply | Progress): void;
  onmessage: ((event: MessageEvent<Request>) => void) | null;
};

interface Tier1 {
  compiler: Compiler;
  builder: Builder;
}

let assets: AssetManager | null = null;
let tier1: Promise<Tier1> | null = null;
let toolchain: Promise<Toolchain> | null = null;
let snapshot: Snapshot = { revision: 0, files: {} };

const PROJECT_OPS: ReadonlySet<Op> = new Set<Op>(['check', 'hover', 'complete', 'emit_c', 'build']);

class StaleError extends Error {}

function progress(event: Progress): void {
  self.postMessage(event);
}

function requireAssets(): AssetManager {
  if (!assets) throw new Error('the compiler Worker has not been initialized');
  return assets;
}

/** Tier 1: titanc.wasm and its catalog. A failed load is retried next time. */
function loadTier1(): Promise<Tier1> {
  if (!tier1) {
    const source = requireAssets();
    tier1 = openCompiler(source).then(compiler => ({ compiler, builder: new Builder(compiler, source.manifestHash) }));
    tier1.catch(() => { tier1 = null; });
  }
  return tier1;
}

/** Tier 2: YoWASP Clang/LLD, Binaryen, the SDK archives and headers. */
function loadToolchain(): Promise<Toolchain> {
  if (!toolchain) {
    toolchain = Toolchain.open(requireAssets());
    toolchain.catch(() => { toolchain = null; });
  }
  return toolchain;
}

async function init({ manifest, base }: Operations['init'][0]): Promise<null> {
  if (manifest.schema !== 1 || manifest.profile !== 'validation' || await manifestHash(manifest) !== manifest.hash) {
    throw new Error('the playground asset manifest is invalid');
  }
  if (assets && assets.manifestHash !== manifest.hash) throw new Error('the compiler Worker serves another version');
  assets ??= new AssetManager(manifest, base, progress);
  return null;
}

async function perform(request: Request): Promise<unknown> {
  if (PROJECT_OPS.has(request.op) && request.revision !== snapshot.revision) throw new StaleError();
  const files: Files = titanSources(snapshot.files);
  switch (request.op) {
    case 'init':
      return init(request.args);
    case 'sync':
      if (request.args.revision < snapshot.revision) throw new StaleError();
      snapshot = { revision: request.args.revision, files: { ...request.args.files } };
      return null;
    case 'warm':
      await loadTier1();
      if (request.args.tier === 2) await loadToolchain();
      return null;
    case 'check':
      return (await loadTier1()).compiler.check(files);
    case 'hover':
      return (await loadTier1()).compiler.hover(files, request.args);
    case 'complete':
      return (await loadTier1()).compiler.complete(files, request.args);
    case 'emit_c':
      return (await loadTier1()).builder.emit(files);
    case 'build': {
      const { builder } = await loadTier1();
      const tools = await loadToolchain();
      const { id, revision } = request;
      return builder.build(files, tools, (stage, state, ms) => progress({ event: 'stage', id, revision, stage, state, ms }));
    }
    case 'stdlib': {
      const bytes = await requireAssets().bytes('stdlib-sources.json');
      return JSON.parse(new TextDecoder().decode(bytes)) as Files;
    }
    case 'clearCache':
      await requireAssets().clear();
      (await tier1)?.builder.clearObjects();
      return null;
  }
}

// The compiler lane: one titanc/toolchain job at a time, in arrival order.
let lane: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = lane.then(work);
  lane = result.catch(() => {});
  return result;
}

function respond(request: Request, outcome: Promise<unknown>): void {
  const { id, revision, op } = request;
  outcome.then(value => {
    // The value matches `op` by construction of `perform`'s cases.
    self.postMessage({ id, revision, op, ok: true, value } as Reply);
  }, error => {
    if (error instanceof StaleError) {
      self.postMessage({ id, revision, op, ok: false, code: 'stale', message: `revision ${revision} is no longer current` });
    } else if (error instanceof DiagnosticsError) {
      self.postMessage({ id, revision, op, ok: false, code: 'diagnostics', message: error.message, diagnostics: error.diagnostics });
    } else {
      self.postMessage({ id, revision, op, ok: false, code: 'toolchain', message: error instanceof Error ? error.message : String(error) });
    }
  });
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  // Everything waits for the jobs that arrived before it (so `init` comes
  // first), but downloads never hold the lane: checking, hover and completion
  // stay live while Tier 2 streams in, and a build waits for its toolchain
  // outside the lane before compiling in order.
  const arrived = lane;
  if (request.op === 'warm' || request.op === 'stdlib') {
    respond(request, arrived.then(() => perform(request)));
  } else if (request.op === 'build') {
    respond(request, arrived.then(loadToolchain).then(() => serialized(() => perform(request))));
  } else {
    respond(request, serialized(() => perform(request)));
  }
};
