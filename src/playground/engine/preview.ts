// Parent side of the opaque preview frame: one `<iframe sandbox="allow-scripts"
// srcdoc>` per run, a private MessagePort handed over once the frame says it
// is ready, and teardown that never waits on the frame to cooperate. A run
// that fails, exits, or cannot start is torn down right after its result or
// error is delivered; a run whose `main` returns stays live until Stop.

import type { Image, PreviewMode, RunEvent } from '../types.ts';
import describeSource from './describe.js?raw';
import frameSource from './preview-frame.js?raw';

/** The verified vendored Three graph: `three.module.js` and its `three.core.js`. */
export interface ThreeSources {
  module: string;
  core: string;
}

export interface PreviewOptions {
  mount: HTMLElement;
  image: Image;
  bindings: string | null;
  /** Supplied whenever the project has `bindings.js`, so bare `three` always resolves. */
  three: ThreeSources | null;
  mode: PreviewMode;
  env: Record<string, string>;
  stdin?: Uint8Array;
  onEvent: (event: RunEvent) => void;
}

const TEXT_LIMIT = 64 * 1024;
const CLOSE_GRACE_MS = 400;
// Inherited presentation of the preview element, applied inside the frame.
const INHERITED_STYLE = ['color', 'background-color', 'font-family', 'color-scheme'];

// The bootstrap is a classic script, so it can install the frame's import map
// (with frame-local blob URLs for Three) before the first module loads.
const FRAME_DOCUMENT = (() => {
  const bootstrap = `(() => {\n${describeSource.replace(/^export function describe/m, 'function describe')}\n${frameSource}\n})();`;
  if (bootstrap.includes('</script')) throw new Error('preview bootstrap cannot contain </script');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Program preview</title>
<style>
html, body { margin: 0; min-height: 100%; }
body { font: 15px/1.5 var(--font-family, system-ui, sans-serif); }
#stage { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem; outline: none; }
#stage:focus-visible { box-shadow: inset 0 0 0 2px currentColor; }
#stage > canvas { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; touch-action: none; }
</style></head><body><main id="stage" tabindex="0" aria-label="Program preview"></main>
<script>${bootstrap}</script></body></html>`;
})();

function inheritedStyle(mount: HTMLElement): Record<string, string> {
  const computed = getComputedStyle(mount);
  const style: Record<string, string> = {};
  for (const name of INHERITED_STYLE) {
    const value = computed.getPropertyValue(name);
    if (value) style[name === 'font-family' ? '--font-family' : name] = value;
  }
  return style;
}

const bounded = (value: unknown): value is string => typeof value === 'string' && value.length <= TEXT_LIMIT;
const bytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

/** Validates one frame message into a RunEvent, or null for anything else. */
function frameEvent(data: Record<string, unknown>): RunEvent | null {
  switch (data.type) {
    case 'stream':
      return (data.channel === 'stdout' || data.channel === 'stderr') && bytes(data.bytes) ?
        { type: 'stream', channel: data.channel, bytes: data.bytes } : null;
    case 'console':
      return (data.level === 'log' || data.level === 'info' || data.level === 'warn' || data.level === 'error') &&
        bounded(data.text) ? { type: 'console', level: data.level, text: data.text } : null;
    case 'bindings':
      return Array.isArray(data.names) && data.names.length <= 1024 && data.names.every(bounded) ?
        { type: 'bindings', names: data.names } : null;
    case 'ready':
    case 'stop-request':
      return { type: data.type };
    case 'result':
      return (data.kind === 'returned' || data.kind === 'exited' || data.kind === 'failed') &&
        Number.isInteger(data.status) && bytes(data.bytes) && bytes(data.trace) ?
        { type: 'result', kind: data.kind, status: data.status as number, bytes: data.bytes, trace: data.trace } : null;
    case 'error':
      return bounded(data.message) ? { type: 'error', message: data.message } : null;
    default:
      return null;
  }
}

let runs = 0;

export function startPreview(options: PreviewOptions): { stop(): void } {
  const run = ++runs;
  let port: MessagePort | null = null;
  let finished = false;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.title = 'Program preview';
  iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;';
  // A live run keeps following the page's theme (an explicit `data-theme` or
  // the system color scheme) without restarting.
  const restyle = () => port?.postMessage({ type: 'style', style: inheritedStyle(options.mount) });
  const themeObserver = new MutationObserver(restyle);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const colorScheme = matchMedia('(prefers-color-scheme: dark)');
  colorScheme.addEventListener('change', restyle);

  // Retires the run once, whether the user stopped it or it ended on its own:
  // the frame gets a grace period to dispose its instance, then goes away.
  const finish = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener('message', onReady);
    themeObserver.disconnect();
    colorScheme.removeEventListener('change', restyle);
    iframe.style.display = 'none';
    const remove = () => {
      port?.close();
      iframe.remove();
    };
    if (port) {
      const timer = setTimeout(remove, CLOSE_GRACE_MS);
      port.onmessage = message => {
        if (message.data?.type === 'closed') {
          clearTimeout(timer);
          remove();
        }
      };
      port.postMessage({ type: 'close' });
    } else {
      remove();
    }
    options.onEvent({ type: 'stopped' });
  };

  const onReady = (event: MessageEvent) => {
    if (finished || port || event.source !== iframe.contentWindow || event.origin !== 'null' ||
        event.data?.type !== 'titan-playground:ready') return;
    window.removeEventListener('message', onReady);
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = message => {
      const data: unknown = message.data;
      if (finished || !data || typeof data !== 'object' || !('run' in data) || data.run !== run) return;
      const runEvent = frameEvent(data as Record<string, unknown>);
      if (!runEvent) return;
      options.onEvent(runEvent);
      if (runEvent.type === 'error' || runEvent.type === 'result' && runEvent.kind !== 'returned') finish();
    };
    // An opaque frame's origin can only be targeted as '*'; the port is private.
    iframe.contentWindow?.postMessage({ type: 'titan-playground:port', run }, '*', [channel.port2]);
    port.postMessage({
      type: 'start', mode: options.mode, bindings: options.bindings, three: options.three, env: options.env,
      style: inheritedStyle(options.mount),
      mjs: options.image.mjs, wasm: options.image.wasm, trace: options.image.trace, stdin: options.stdin,
    });
  };
  window.addEventListener('message', onReady);
  iframe.srcdoc = FRAME_DOCUMENT;
  options.mount.append(iframe);
  return { stop: finish };
}
