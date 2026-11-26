// A disposable runner for console programs. The engine keeps one prewarmed;
// each runs exactly one image and is then terminated, so Stop is a hard
// `terminate()` that never touches the compiler Worker.

import { describe } from './describe.js';

// The dedicated Worker scope; the site type-checks against the DOM library only.
declare const self: {
  postMessage(message: RunnerEvent, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<RunnerStart>) => void) | null;
};

export interface RunnerStart {
  type: 'run';
  mjs: string;
  wasm: Uint8Array;
  trace: Uint8Array;
  env: Record<string, string>;
  stdin?: Uint8Array;
}

export type RunnerEvent =
  | { type: 'stream'; channel: 'stdout' | 'stderr'; bytes: Uint8Array }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { type: 'ready' }
  | { type: 'result'; kind: 'returned' | 'exited' | 'failed'; status: number; bytes: Uint8Array; trace: Uint8Array }
  | { type: 'error'; message: string }
  | { type: 'done' };

interface LoaderInstance {
  initialize(): Promise<void>;
  run(args: string[]): Promise<{ kind: 'returned' | 'exited' | 'failed'; status: number; bytes?: Uint8Array; trace?: Uint8Array }>;
  dispose(): Promise<void>;
}

type CreateImage = (options: Record<string, unknown>) => LoaderInstance;

function post(event: RunnerEvent): void {
  const transfer = event.type === 'stream' && event.bytes.byteOffset === 0 &&
    event.bytes.byteLength === event.bytes.buffer.byteLength ? [event.bytes.buffer as ArrayBuffer] : [];
  self.postMessage(event, transfer);
}

// The loader reports trace-table and notification problems on the console.
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...values: unknown[]) => post({ type: 'console', level, text: describe(values) });
}

/** A Titan error thrown by initialization carries the same bytes as a failed run. */
function titanFailure(error: unknown): RunnerEvent | null {
  if (!(error instanceof Error) || !('bytes' in error) || !(error.bytes instanceof Uint8Array)) return null;
  const trace = 'trace' in error && error.trace instanceof Uint8Array ? error.trace : new Uint8Array(0);
  const status = 'status' in error && typeof error.status === 'number' ? error.status : 1;
  return { type: 'result', kind: 'failed', status, bytes: error.bytes, trace };
}

let started = false;

self.onmessage = async (event: MessageEvent<RunnerStart>) => {
  const start = event.data;
  if (started || start?.type !== 'run') return;
  started = true;
  const blob = (bytes: BlobPart, type: string) => URL.createObjectURL(new Blob([bytes], { type }));
  const wasm = blob(start.wasm as Uint8Array<ArrayBuffer>, 'application/wasm');
  const trace = blob(start.trace as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  const mjs = blob(start.mjs, 'text/javascript');
  let stdin = start.stdin ?? null;
  try {
    // The image module exists only as this run's blob URL.
    const create = (await import(/* @vite-ignore */ mjs)).default as CreateImage;
    const instance = create({
      requireTrace: true,
      env: start.env,
      locateFile: (name: string) => name.endsWith('.wasm.trace') ? trace : wasm,
      stdout: (bytes: Uint8Array) => post({ type: 'stream', channel: 'stdout', bytes }),
      stderr: (bytes: Uint8Array) => post({ type: 'stream', channel: 'stderr', bytes }),
      ...(start.stdin ? { stdin: () => { const chunk = stdin; stdin = null; return chunk; } } : {}),
      onNotificationError: ({ kind, error }: { kind: string; error: unknown }) =>
        post({ type: 'console', level: 'error', text: `${kind}: ${describe([error])}` }),
      onEngineFailure: ({ kind, cause }: { kind: string; cause: unknown }) =>
        post({ type: 'error', message: `engine ${kind}: ${describe([cause])}` }),
    });
    try {
      await instance.initialize();
      post({ type: 'ready' });
      const result = await instance.run([]);
      post({ type: 'result', kind: result.kind, status: result.status,
        bytes: result.bytes ?? new Uint8Array(0), trace: result.trace ?? new Uint8Array(0) });
    } catch (error) {
      post(titanFailure(error) ?? { type: 'error', message: describe([error]) });
    } finally {
      await instance.dispose();
    }
  } catch (error) {
    post({ type: 'error', message: describe([error]) });
  } finally {
    for (const url of [wasm, trace, mjs]) URL.revokeObjectURL(url);
    post({ type: 'done' });
  }
};
