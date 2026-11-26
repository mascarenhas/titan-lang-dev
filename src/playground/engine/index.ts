// The playground engine: the single import path for the UI. It alone creates
// the compiler Worker, the console runner Workers and the preview frames.

import type {
  Engine, EngineRequestError, Image, Op, Operations, PlaygroundManifest, Progress, Project, Reply, Request, RunEvent,
  RunOptions,
} from '../types.ts';
import { AssetManager } from './assets.ts';
import { buildBundle } from './bundle.ts';
import { startPreview, type ThreeSources } from './preview.ts';
import type { RunnerEvent, RunnerStart } from './runner-worker.ts';
import { decodeShare, encodeShare, SHARE_WARN_BYTES } from './share.ts';

export { decodeShare, encodeShare, SHARE_WARN_BYTES };
export { pathProblem, projectProblem } from './paths.ts';
/** The assets each tier loads eagerly, for progress denominators (byte totals come from the manifest). */
export { TIER1_PATHS, TIER2_PATHS } from './toolchain.ts';

export const MANIFEST_URL = '/play/playground-assets.json';
const PRODUCTION_BASE = 'https://cdn.titan-lang.dev/playground/';

/**
 * The effective asset base: `PUBLIC_PLAYGROUND_CDN_BASE` (an absolute HTTP(S)
 * directory, or an origin-relative one resolved against this page) replaces
 * the production CDN directory. Exactly one trailing slash.
 */
export function assetBase(configured: string | undefined = import.meta.env.PUBLIC_PLAYGROUND_CDN_BASE): string {
  const url = new URL(configured || PRODUCTION_BASE, location.href);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the playground CDN base must be HTTP(S)');
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}

let manifestPromise: Promise<PlaygroundManifest> | null = null;

function loadManifest(): Promise<PlaygroundManifest> {
  manifestPromise ??= fetch(new URL(MANIFEST_URL, location.href), { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error(`the playground asset manifest is unavailable (${response.status})`);
    return await response.json() as PlaygroundManifest;
  });
  manifestPromise.catch(() => { manifestPromise = null; });
  return manifestPromise;
}

// The page's own verified, cached view of the assets it hands to previews and
// downloads (Three and the image notices); the compiler Worker owns the rest.
let pageAssetsPromise: Promise<AssetManager> | null = null;

function pageAssets(onProgress: (event: Progress) => void = () => {}): Promise<AssetManager> {
  pageAssetsPromise ??= loadManifest().then(manifest => new AssetManager(manifest, assetBase(), onProgress));
  pageAssetsPromise.catch(() => { pageAssetsPromise = null; });
  return pageAssetsPromise;
}

const text = new TextDecoder();

async function threeSources(): Promise<ThreeSources> {
  const assets = await pageAssets();
  const [module, core] = await Promise.all([assets.bytes('vendor/three.module.js'), assets.bytes('vendor/three.core.js')]);
  return { module: text.decode(module), core: text.decode(core) };
}

/** The deployable zip of `image`, the exact build of `project`. */
export async function exportBundle(project: Project, image: Image): Promise<Blob> {
  const assets = await pageAssets();
  return buildBundle(project, image, {
    three: async () => {
      const [module, core, license] = await Promise.all(['vendor/three.module.js', 'vendor/three.core.js',
        'vendor/three.LICENSE.txt'].map(path => assets.bytes(path)));
      return { module, core, license };
    },
    notices: () => assets.bytes('licenses/image-NOTICES.txt'),
    fixture: async name => {
      const response = await fetch(new URL(`/play/data/${encodeURIComponent(name)}`, location.origin));
      if (!response.ok) throw new Error(`/play/data/${name}: request failed (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
}

function requestError(reply: Extract<Reply, { ok: false }>): EngineRequestError {
  const error = new Error(reply.message) as EngineRequestError;
  error.code = reply.code;
  if (reply.diagnostics) error.diagnostics = reply.diagnostics;
  return error;
}

function spawnRunner(): Worker {
  return new Worker(new URL('./runner-worker.ts', import.meta.url), { type: 'module', name: 'titan-runner' });
}

/**
 * Creates the engine; resolves once Tier 1 (checking, hover, completion, C)
 * is ready. On failure nothing stays running, so the caller can retry.
 */
export async function createEngine(onProgress: (event: Progress) => void): Promise<Engine> {
  const manifest = await loadManifest();
  pageAssets(onProgress);
  const compiler = new Worker(new URL('./compiler-worker.ts', import.meta.url), { type: 'module', name: 'titan-compiler' });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let disposed = false;
  let broken: Error | null = null;
  let spare: Worker | null = null;
  const live = new Set<{ stop(): void }>();

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  compiler.onmessage = (event: MessageEvent<Reply | Progress>) => {
    const message = event.data;
    if ('event' in message) {
      onProgress(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(requestError(message));
  };
  // A dead Worker answers nothing: fail what is pending and everything after.
  compiler.onerror = event => {
    broken = new Error(`the compiler Worker failed: ${event.message}`);
    failAll(broken);
  };

  function request<K extends Op>(op: K, args: Operations[K][0], revision: number): Promise<Operations[K][1]> {
    if (disposed) return Promise.reject(new Error('the playground engine is disposed'));
    if (broken) return Promise.reject(broken);
    const id = ++nextId;
    const { promise, resolve, reject } = Promise.withResolvers<Operations[K][1]>();
    // The Worker replies to `id` with the value of this `op`.
    pending.set(id, { resolve: value => resolve(value as Operations[K][1]), reject });
    compiler.postMessage({ id, revision, op, args } as Request);
    return promise;
  }

  function runConsole(options: RunOptions, env: Record<string, string>, stdin: Uint8Array | undefined): { stop(): void } {
    const worker = spare ?? spawnRunner();
    spare = disposed ? null : spawnRunner();
    let finished = false;
    // Stop, a finished run and a failed Worker all end here: one terminate.
    const handle = {
      stop() {
        if (finished) return;
        finished = true;
        worker.terminate();
        options.onEvent({ type: 'stopped' });
      },
    };
    worker.onmessage = (event: MessageEvent<RunnerEvent>) => {
      if (finished) return;
      const message = event.data;
      if (message.type === 'done') handle.stop();
      else options.onEvent(message);
    };
    worker.onerror = event => {
      if (finished) return;
      options.onEvent({ type: 'error', message: event.message || 'the runner Worker failed' });
      handle.stop();
    };
    const start: RunnerStart = { type: 'run', mjs: options.build.image.mjs, wasm: options.build.image.wasm,
      trace: options.build.image.trace, env, ...(stdin ? { stdin } : {}) };
    // Structured clone copies the image: the build keeps its own bytes.
    worker.postMessage(start);
    return handle;
  }

  /** A preview frame; with bindings.js it first loads the verified Three graph. */
  function runPreview(options: RunOptions, env: Record<string, string>, stdin: Uint8Array | undefined): { stop(): void } {
    const bindings = options.project.files['bindings.js'] ?? null;
    let inner: { stop(): void } | null = null;
    let stopped = false;
    const handle = {
      stop() {
        if (stopped) return;
        stopped = true;
        if (inner) inner.stop();
        else options.onEvent({ type: 'stopped' });
      },
    };
    (bindings === null ? Promise.resolve(null) : threeSources()).then(three => {
      if (stopped) return;
      inner = startPreview({
        mount: options.preview, image: options.build.image, bindings, three, mode: options.project.previewMode, env, stdin,
        onEvent: event => {
          if (event.type === 'stopped') stopped = true;
          options.onEvent(event);
        },
      });
    }, error => {
      if (stopped) return;
      options.onEvent({ type: 'error', message: `the preview could not load Three.js: ${error instanceof Error ? error.message : String(error)}` });
      handle.stop();
    });
    return handle;
  }

  const engine: Engine = {
    request,
    run(options) {
      const stdin = options.stdin === undefined ? undefined : new TextEncoder().encode(options.stdin);
      const env = { PLAYGROUND_ORIGIN: location.origin };
      let handle: { stop(): void } | null = null;
      const onEvent = (event: RunEvent) => {
        if (event.type === 'stopped' && handle) live.delete(handle);
        if (!disposed) options.onEvent(event);
      };
      // A project with bindings.js always runs in the opaque frame.
      handle = 'bindings.js' in options.project.files || options.project.previewMode !== 'console' ?
        runPreview({ ...options, onEvent }, env, stdin) : runConsole({ ...options, onEvent }, env, stdin);
      live.add(handle);
      return handle;
    },
    dispose() {
      if (disposed) return;
      for (const handle of [...live]) handle.stop();
      disposed = true;
      compiler.terminate();
      spare?.terminate();
      spare = null;
      failAll(new Error('the playground engine is disposed'));
    },
  };

  try {
    await request('init', { manifest, base: assetBase() }, 0);
    await request('warm', { tier: 1 }, 0);
  } catch (error) {
    engine.dispose();
    throw error;
  }
  spare = spawnRunner();
  return engine;
}
