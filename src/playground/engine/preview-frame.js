// Trusted bootstrap of the opaque preview frame (`sandbox="allow-scripts"`
// srcdoc), run as a classic script inside an IIFE after describe.js; never
// interpolated with project text. The parent hands over one private
// MessagePort; the project's `bindings.js`, the image module, the Wasm and
// trace bytes, and the verified Three graph arrive on it as data and are
// imported from this frame's own blob URLs. `error` messages are terminal
// (the parent then tears the run down); uncaught errors in the program's own
// JavaScript are forwarded as console errors and leave the preview running.
/* global describe */

const stage = document.getElementById('stage');
let port = null;
let run = 0;
let instance = null;
let controller = null;
const urls = [];

function send(message, transfer = []) {
  port?.postMessage({ run, ...message }, transfer);
}

function blob(data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  urls.push(url);
  return url;
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...values) => {
    original(...values);
    send({ type: 'console', level, text: describe(values) });
  };
}
addEventListener('error', event => send({ type: 'console', level: 'error',
  text: `Uncaught ${describe([event.error ?? event.message])}` }));
addEventListener('unhandledrejection', event =>
  send({ type: 'console', level: 'error', text: `Unhandled rejection: ${describe([event.reason])}` }));
addEventListener('keydown', event => {
  if (event.key === 'Escape') send({ type: 'stop-request' });
});
stage.addEventListener('pointerdown', () => stage.focus({ preventScroll: true }));

addEventListener('message', function accept(event) {
  const data = event.data;
  if (port || event.source !== parent || data?.type !== 'titan-playground:port' || !event.ports[0] ||
      !Number.isSafeInteger(data.run)) return;
  removeEventListener('message', accept);
  port = event.ports[0];
  run = data.run;
  port.onmessage = message => {
    if (message.data?.type === 'start') start(message.data);
    else if (message.data?.type === 'close') close();
  };
});
parent.postMessage({ type: 'titan-playground:ready' }, '*');

function titanFailure(error) {
  if (!(error instanceof Error) || !(error.bytes instanceof Uint8Array)) return null;
  return { type: 'result', kind: 'failed', status: typeof error.status === 'number' ? error.status : 1,
    bytes: error.bytes, trace: error.trace instanceof Uint8Array ? error.trace : new Uint8Array(0) };
}

async function start(message) {
  if (controller) return;
  controller = new AbortController();
  for (const [name, value] of Object.entries(message.style)) document.documentElement.style.setProperty(name, value);
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  if (message.mode === 'canvas2d' || message.mode === 'three') stage.append(canvas);
  const host = { root: stage, canvas, signal: controller.signal };

  // Bare `three` resolves to frame-local copies of the verified vendored pair;
  // the module's only relative specifier is the core module (the packer checks
  // this), so point it at the core's blob URL. A classic bootstrap may still
  // add the import map here, because no module has loaded in this frame yet.
  if (message.three) {
    const core = blob(message.three.core, 'text/javascript');
    const module = blob(message.three.module.replaceAll("'./three.core.js'", JSON.stringify(core)), 'text/javascript');
    const map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({ imports: { three: module } });
    document.head.append(map);
  }

  let bindings = {};
  if (typeof message.bindings === 'string') {
    let module;
    try {
      module = await import(blob(message.bindings, 'text/javascript'));
    } catch (error) {
      send({ type: 'error', message: `bindings.js: ${describe([error])}` });
      return;
    }
    if (typeof module.default !== 'function') {
      send({ type: 'error', message: 'bindings.js must export default function createBindings(host)' });
      return;
    }
    try {
      bindings = module.default(host);
    } catch (error) {
      send({ type: 'error', message: `createBindings(host) threw ${describe([error])}` });
      return;
    }
    if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings) || typeof bindings.then === 'function') {
      send({ type: 'error', message: 'createBindings(host) must return a plain object of bindings' });
      return;
    }
    send({ type: 'bindings', names: Object.keys(bindings) });
  }

  const wasm = blob(message.wasm, 'application/wasm');
  const trace = blob(message.trace, 'application/octet-stream');
  let stdin = message.stdin ?? null;
  try {
    const { default: create } = await import(blob(message.mjs, 'text/javascript'));
    instance = create({
      bindings,
      requireTrace: true,
      env: message.env,
      locateFile: name => name.endsWith('.wasm.trace') ? trace : wasm,
      stdout: bytes => send({ type: 'stream', channel: 'stdout', bytes }),
      stderr: bytes => send({ type: 'stream', channel: 'stderr', bytes }),
      ...(message.stdin ? { stdin: () => { const chunk = stdin; stdin = null; return chunk; } } : {}),
      onNotificationError: ({ kind, error }) => send({ type: 'console', level: 'error', text: `${kind}: ${describe([error])}` }),
      onEngineFailure: ({ kind, cause }) => send({ type: 'error', message: `engine ${kind}: ${describe([cause])}` }),
    });
    await instance.initialize();
    send({ type: 'ready' });
    const result = await instance.run([]);
    send({ type: 'result', kind: result.kind, status: result.status,
      bytes: result.bytes ?? new Uint8Array(0), trace: result.trace ?? new Uint8Array(0) });
  } catch (error) {
    send(titanFailure(error) ?? { type: 'error', message: describe([error]) });
  }
}

// Graceful close: JS teardown first (host.signal), then the instance's own
// disposal (finalizers, pinned callables, output flush), then the blob URLs.
async function close() {
  controller?.abort();
  try {
    await instance?.dispose();
  } catch (error) {
    send({ type: 'console', level: 'error', text: `dispose: ${describe([error])}` });
  }
  for (const url of urls) URL.revokeObjectURL(url);
  send({ type: 'closed' });
  port.close();
}
