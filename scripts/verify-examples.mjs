#!/usr/bin/env node
// Compiles, links and runs every curated playground example through the real
// playground pipeline (CONTRACTS.md §2):
//
//   node scripts/verify-examples.mjs --assets <staged-dir> [--chrome <path>]
//     [--shots <dir>] [--only <slug>]...
//
// Node 26+: titanc.mjs/titanc.wasm, YoWASP Clang/LLD, Binaryen wasm-opt and
// the trace/embed step build each project exactly as the compiler Worker does
// (engine/toolchain.ts); console images run with requireTrace. Headless JSPI
// Chromium then drives the real engine (compiler Worker, runner Worker and
// opaque preview frame) on a local site origin: every example builds and
// runs, interactive previews respond to input, Stop → edited bindings → Run
// reuses the build, `#v1=` round-trips, and each downloaded zip runs from a
// fresh origin. Exits nonzero on any failure.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { unzipSync } from 'fflate';
import { chromium } from 'playwright-core';
import { build as viteBuild } from 'vite';
import { Builder, openCompiler, Toolchain, titanSources } from '../src/playground/engine/toolchain.ts';
import { mimeOf, serveAssets } from './build-playground-assets.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUN_TIMEOUT_MS = 60_000;

const { values: options } = parseArgs({
  options: {
    assets: { type: 'string' }, chrome: { type: 'string' }, shots: { type: 'string' },
    only: { type: 'string', multiple: true },
  },
});

const failures = [];
function check(condition, message) {
  if (!condition) {
    failures.push(message);
    console.error(`  FAIL ${message}`);
  }
  return Boolean(condition);
}
function fatal(message) {
  console.error(`verify-examples: ${message}`);
  process.exit(1);
}

if (Number(process.versions.node.split('.')[0]) < 26) fatal(`Node 26+ is required (found ${process.version})`);
if (!options.assets) fatal('missing --assets <staged-dir>');

// The registry imports authored files with Vite's `?raw`; load the same files
// here. The registry is imported dynamically because the hook must exist first.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('?raw')) return nextLoad(url, context);
    const source = fs.readFileSync(new URL(url.slice(0, -'?raw'.length)), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
  },
});
const { examples } = await import(pathToFileURL(path.join(ROOT, 'src/playground/examples/index.ts')).href);
const engineModule = path.join(ROOT, 'src/playground/engine');

// ---------------------------------------------------------------------------
// What each example must do. Every registry slug needs an entry (and only
// those): a new example cannot ship unverified.

const text = new TextDecoder();

/** Console examples: assertions on the finished run's stdout/stderr/result. */
const returned = run => run.kind === 'returned' && run.status === 0;
const CONSOLE = {
  'saturns-moons': run => returned(run) && /^Titan +2574\.7 km +382\.7 h$/m.test(run.stdout) &&
    /^Huygens: landed on Titan at Adiri$/m.test(run.stdout),
  'options-and-maps': run => returned(run) && /^radar +3 +93\.33 K$/m.test(run.stdout) &&
    /^spectrometer +1 +n\/a$/m.test(run.stdout) && /absent key safely handled/.test(run.stdout),
  generics: run => returned(run) && /^Largest moon: Titan \(2574\.7 km radius\)$/m.test(run.stdout) &&
    /^Titan diameter: 5149\.4 km$/m.test(run.stdout),
  // An intentional uncaught raise: recovered frames first, then a trace whose
  // frames name main.titan lines in user functions.
  'errors-and-traces': run => run.kind === 'failed' && /\[defer\] closed link downlink-17/.test(run.stdout) &&
    /\[catch\] BAD_ALTITUDE on frame #17/.test(run.stdout) && /altitude -12\.5 km is below Titan's surface/.test(run.bytes) &&
    /main\.titan:\d+: in main\.verify_altitude\n.*main\.titan:\d+: in main\.analyze_pass/.test(run.stderr + run.trace),
  'tasks-and-timers': run => returned(run) && /Joined results: radar:ok, lidar:ok, spectrometer:ok/.test(run.stdout) &&
    /Heartbeat stopped cleanly/.test(run.stdout),
  'json-roundtrip': run => returned(run) && /exact round-trip match: true/.test(run.stdout) &&
    /code=type_mismatch path=\$\["site"\]\["lon_deg"\]/.test(run.stdout),
  // Served by the local site origin under /play/data/, read through browser fetch.
  'fetch-json': run => returned(run) && /GET http:\/\/127\.0\.0\.1:\d+\/play\/data\/moons\.json -> 200/.test(run.stdout) &&
    /^Saturn — Cassini-Huygens Mission Archive$/m.test(run.stdout),
};

// The accessible HUD every flagship game binds through `set_text`.
const HUD = '[aria-live="polite"]';

/** Waits until the HUD text matches `pattern`; resolves to the text, or null on timeout. */
async function waitForHud(frame, pattern, timeout = 15_000) {
  try {
    await frame.waitForFunction(([selector, source]) =>
      new RegExp(source).test(document.querySelector(selector)?.textContent ?? ''), [HUD, pattern.source], { timeout });
    return await frame.locator(HUD).first().textContent();
  } catch {
    return null;
  }
}

/** Waits until the HUD's `label` number drops below `limit`; resolves to whether it did. */
async function waitForHudBelow(frame, label, limit, timeout = 15_000) {
  try {
    await frame.waitForFunction(([selector, name, bound]) => {
      const match = new RegExp(`${name} (-?[\\d.]+)`).exec(document.querySelector(selector)?.textContent ?? '');
      return match !== null && Number(match[1]) < bound;
    }, [HUD, label, limit], { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Preview examples: input-driven checks of program-owned state, run against
 * the live opaque frame and against each exported bundle. `expect` records
 * one assertion.
 */
const PREVIEW = {
  // Titan owns the VNode diff and the hooks; the DOM changes only if it runs.
  'mini-react': async (frame, label, expect) => {
    const items = frame.locator('.mr-list > li');
    await items.first().waitFor({ timeout: 20_000 });
    const before = await items.count();
    await frame.getByLabel('New flight task').fill('Verify the playground');
    await frame.getByLabel('New flight task').press('Enter');
    let added = true;
    try {
      await frame.waitForFunction(([selector, count]) => document.querySelectorAll(selector).length === count,
        ['.mr-list > li', before + 1], { timeout: 5000 });
    } catch {
      added = false;
    }
    expect(added && await frame.getByText('Verify the playground').count() > 0, `${label}: Enter adds the task through a state update`);
    // The timer is a useEffect running a `timer.ticker` Task while on; its
    // cleanup cancels the Task when paused.
    const clock = frame.locator('.mr-clock-readout');
    const first = await clock.textContent();
    await frame.getByRole('button', { name: 'Timer' }).click();
    let ticked = true;
    try {
      await frame.waitForFunction(([selector, text]) => document.querySelector(selector)?.textContent !== text,
        ['.mr-clock-readout', first], { timeout: 5000 });
    } catch {
      ticked = false;
    }
    expect(ticked, `${label}: the useEffect timer ticks after Timer`);
    await frame.getByRole('button', { name: 'Pause' }).click();
    await frame.waitForTimeout(300);
    const paused = await clock.textContent();
    await frame.waitForTimeout(1500);
    expect(await clock.textContent() === paused, `${label}: Pause runs the effect cleanup and stops the ticker`);
  },
  // Thrust jettisons the chute (CHUTE → RETRO) and burns fuel.
  'huygens-lander': async (frame, label, expect) => {
    expect(await waitForHud(frame, /CHUTE \| ALT -?\d+m \| VY -?[\d.]+ \| FUEL 100%/) !== null,
      `${label}: the descent starts under the parachute with full fuel`);
    const thrust = frame.locator('button[data-control="thrust"]');
    await thrust.dispatchEvent('pointerdown');
    expect(await waitForHud(frame, /RETRO \| ALT/) !== null, `${label}: thrust jettisons the parachute (RETRO)`);
    expect(await waitForHudBelow(frame, 'FUEL', 100), `${label}: holding thrust burns fuel`);
    await thrust.dispatchEvent('pointerup');
    expect(await canvasDrawn(frame), `${label}: the canvas shows a rendered scene`);
  },
  // The mission starts in flight; Plan returns to the planning phase, Launch
  // flies again, and a held burn spends fuel.
  'gravity-assist': async (frame, label, expect) => {
    expect(await frame.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2'))),
      `${label}: WebGL2 is available`);
    await frame.locator('button[data-control="restart"]').click();
    expect(await waitForHud(frame, /PLAN \| v [\d.]+ \| Δv [+-][\d.]+ \| Titan [\d.]+ \| Fuel 100%/) !== null,
      `${label}: Plan returns to the planning phase with full fuel`);
    await frame.locator('button[data-control="launch"]').click();
    expect(await waitForHud(frame, /(CRUISE|ASSIST|RING DIVE)[A-Z+ ]* \| v/) !== null, `${label}: Launch starts the flight`);
    const burn = frame.locator('button[data-control="burn"]');
    await burn.dispatchEvent('pointerdown');
    expect(await waitForHudBelow(frame, 'Fuel', 100), `${label}: holding Burn spends fuel`);
    await burn.dispatchEvent('pointerup');
    const frameImage = await frame.locator('canvas').first().screenshot();
    expect(frameImage.length > 8000, `${label}: the renderer draws a non-trivial frame (${frameImage.length} B PNG)`);
  },
};

async function canvasDrawn(frame) {
  return frame.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return false;
    const colors = new Set();
    for (let i = 0; i < pixels.length && colors.size < 8; i += 4 * 97) colors.add(pixels[i] << 16 | pixels[i + 1] << 8 | pixels[i + 2]);
    return colors.size >= 8;
  });
}

const slugs = examples.map(example => example.slug);
if (slugs.length === 0) fatal('the examples registry is empty');
for (const slug of slugs) {
  const example = examples.find(entry => entry.slug === slug);
  const interactive = 'bindings.js' in example.files || example.previewMode !== 'console';
  if (!(interactive ? PREVIEW : CONSOLE)[slug]) fatal(`no verification for ${interactive ? 'preview' : 'console'} example ${slug}`);
}
for (const slug of [...Object.keys(CONSOLE), ...Object.keys(PREVIEW)]) {
  if (!slugs.includes(slug)) fatal(`verification names unknown example ${slug}`);
}
for (const slug of options.only ?? []) if (!slugs.includes(slug)) fatal(`--only names unknown example ${slug}`);
const selected = examples.filter(example => !options.only || options.only.includes(example.slug));
const isPreview = example => 'bindings.js' in example.files || example.previewMode !== 'console';

// ---------------------------------------------------------------------------
// The staged asset version, verified like the compiler Worker does.

const staged = path.resolve(options.assets);
const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'playground-assets.json'), 'utf8'));
{
  const assets = manifest.assets.map(({ path: p, tier, bytes, sha256, mime }) => ({ path: p, tier, bytes, sha256, mime }));
  const hash = createHash('sha256').update(JSON.stringify({ schema: 1, titanRevision: manifest.titanRevision,
    profile: 'validation', assets })).digest('hex');
  if (manifest.schema !== 1 || hash !== manifest.hash) fatal('the staged manifest hash does not verify');
}
const versionDir = path.join(staged, manifest.hash);
const rows = new Map(manifest.assets.map(row => [row.path, row]));
const verified = new Map();
function assetBytes(name) {
  if (!verified.has(name)) {
    const row = rows.get(name);
    if (!row) throw new Error(`${name} is not in the manifest`);
    const bytes = new Uint8Array(fs.readFileSync(path.join(versionDir, name)));
    if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new Error(`${name}: digest mismatch`);
    }
    verified.set(name, bytes);
  }
  return verified.get(name);
}
const nodeAssets = {
  manifestHash: manifest.hash,
  bytes: async name => assetBytes(name),
  wasmModule: async name => WebAssembly.compile(assetBytes(name)),
  importModule: async name => {
    assetBytes(name);
    return import(pathToFileURL(path.join(versionDir, name)).href);
  },
};

// The release carries the link plan and the notices of everything it
// redistributes, each verified against its manifest digest.
for (const name of ['link-plan.json', 'licenses/image-NOTICES.txt', 'licenses/binaryen-LICENSE.txt',
  'licenses/emscripten/emscripten-LICENSE.txt', 'licenses/toolchain/llvm-LICENSE.txt', 'licenses/toolchain/wasi-libc-LICENSE.txt',
  'licenses/toolchain/yowasp-clang-LICENSE.txt', 'licenses/toolchain/yowasp-runtime-LICENSE.txt', 'licenses/titan-LICENSE.txt',
  'vendor/three.LICENSE.txt']) {
  try {
    check(assetBytes(name).length > 0, `the release carries ${name}`);
  } catch (error) {
    check(false, `the release carries ${name} (${error.message})`);
  }
}

// ---------------------------------------------------------------------------
// Local origins: CDN-like assets, and the site (harness, manifest pointer,
// /play/data fixtures with the production headers' CORS).

function listen(server) {
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
  return promise;
}
const originOf = server => `http://127.0.0.1:${server.address().port}`;

function staticServer(routes) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    for (const [prefix, directory, headers = {}] of routes) {
      if (!url.pathname.startsWith(prefix)) continue;
      let relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (relative === '' || relative.endsWith('/')) relative += 'index.html';
      const file = path.join(directory, relative);
      if (file.startsWith(directory + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : mimeOf(file);
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
        response.end(fs.readFileSync(file));
        return;
      }
    }
    response.writeHead(404).end();
  });
}

const assetServer = await serveAssets(staged, 0);
const assetBase = `${originOf(assetServer)}/playground/`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-verify-examples-'));
const harnessDir = path.join(scratch, 'harness');
const harnessDist = path.join(scratch, 'dist');
const pointerDir = path.join(scratch, 'pointer');
fs.mkdirSync(pointerDir);
fs.copyFileSync(path.join(staged, 'playground-assets.json'), path.join(pointerDir, 'playground-assets.json'));
const site = await listen(staticServer([
  ['/play/data/', path.join(ROOT, 'public/play/data'), { 'Access-Control-Allow-Origin': '*' }],
  ['/play/', pointerDir],
  ['/', harnessDist],
]));
const siteOrigin = originOf(site);

// ---------------------------------------------------------------------------
// Node phase.

const metrics = [];

/** Runs a console image in a worker thread with the loader's own options. */
function runImage(directory, env) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { default: create } = await import(workerData.module);
      const instance = create({
        requireTrace: true, env: workerData.env,
        stdout: bytes => { parentPort.postMessage({ channel: 'stdout', bytes }); },
        stderr: bytes => { parentPort.postMessage({ channel: 'stderr', bytes }); },
      });
      try {
        const result = await instance.run([]);
        parentPort.postMessage({ result: { kind: result.kind, status: result.status, bytes: result.bytes, trace: result.trace } });
      } catch (error) {
        parentPort.postMessage({ error: String(error && error.stack || error) });
      } finally {
        await instance.dispose();
      }
    })();`, { eval: true, workerData: { module: pathToFileURL(path.join(directory, 'app.mjs')).href, env } });
  const out = { stdout: '', stderr: '', kind: 'timeout', status: -1, bytes: '', trace: '', error: '' };
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const { promise, resolve } = Promise.withResolvers();
  const timer = setTimeout(() => { worker.terminate(); resolve(out); }, RUN_TIMEOUT_MS);
  worker.on('message', message => {
    if (message.channel) out[message.channel] += decoders[message.channel].decode(message.bytes, { stream: true });
    if (message.result) {
      Object.assign(out, message.result, { bytes: text.decode(message.result.bytes ?? new Uint8Array()),
        trace: text.decode(message.result.trace ?? new Uint8Array()) });
    }
    if (message.error) out.error = message.error;
  });
  worker.on('error', error => { out.error = String(error); });
  worker.on('exit', () => { clearTimeout(timer); resolve(out); });
  return promise;
}

function writeImage(directory, image) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'app.mjs'), image.mjs);
  fs.writeFileSync(path.join(directory, 'app.wasm'), image.wasm);
  fs.writeFileSync(path.join(directory, 'app.wasm.trace'), image.trace);
  fs.writeFileSync(path.join(directory, 'app.wasm.map'), image.map);
}

console.log(`playground assets ${manifest.hash} (titan ${manifest.titanRevision})`);
console.log('Node phase');
let started = performance.now();
const compiler = await openCompiler(nodeAssets);
const tier1Ms = performance.now() - started;
started = performance.now();
const toolchain = await Toolchain.open(nodeAssets);
const tier2Ms = performance.now() - started;
console.log(`  tier 1 open ${tier1Ms.toFixed(0)} ms, tier 2 open ${tier2Ms.toFixed(0)} ms`);
const builder = new Builder(compiler, manifest.hash);

for (const example of selected) {
  const slug = example.slug;
  console.log(`  ${slug}`);
  const sources = titanSources(example.files);
  started = performance.now();
  const diagnostics = compiler.check(sources);
  const checkMs = performance.now() - started;
  check(!diagnostics.some(d => d.severity === 'error'),
    `${slug}: check reports no errors (${diagnostics.map(d => d.message).join('; ')})`);
  let build;
  try {
    build = await builder.build(example.files, toolchain);
  } catch (error) {
    check(false, `${slug}: build failed: ${error.message}`);
    continue;
  }
  const row = { slug, checkMs, ...build.ms, wasm: build.image.wasm.length, trace: build.image.trace.length,
    map: build.image.map.length, sections: build.sections.length };
  // Adding a function to main.titan recompiles main.c and reuses every other
  // module's object.
  if (Object.keys(sources).length > 1) {
    const edited = { ...example.files,
      'main.titan': `${example.files['main.titan']}\nfunction playground_edit(): integer\n  return 1\nend\n` };
    const rebuilt = await builder.build(edited, toolchain);
    row.editCompile = rebuilt.ms.compile;
    row.reusedAfterEdit = rebuilt.reused.length;
    const others = Object.keys(sources).filter(file => file !== 'main.titan').map(file => file.replace(/\.titan$/, '.c'));
    check(!rebuilt.reused.includes('main.c') && others.every(unit => rebuilt.reused.includes(unit)),
      `${slug}: editing main.titan recompiles main.c and reuses ${others.join(', ')} (reused ${rebuilt.reused.join(', ')})`);
  }
  if (!isPreview(example)) {
    const directory = path.join(scratch, 'node', slug);
    writeImage(directory, build.image);
    started = performance.now();
    const run = await runImage(directory, { PLAYGROUND_ORIGIN: siteOrigin });
    row.runMs = performance.now() - started;
    check(!run.error, `${slug}: runs without a loader error (${run.error})`);
    check(CONSOLE[slug](run), `${slug}: console output matches (kind ${run.kind}, status ${run.status})\n` +
      `${run.stdout}\n${run.stderr}\n${run.bytes}\n${run.trace}`.split('\n').map(line => `      ${line}`).join('\n'));
  }
  metrics.push(row);
  console.log(`    check ${row.checkMs.toFixed(0)} ms, compile ${row.compile.toFixed(0)} ms, link+opt+trace ${row.link.toFixed(0)} ms` +
    `${row.runMs ? `, run ${row.runMs.toFixed(0)} ms` : ''}; wasm ${row.wasm} B, trace ${row.trace} B` +
    `${row.editCompile !== undefined ? `; edit recompiles in ${row.editCompile.toFixed(0)} ms reusing ${row.reusedAfterEdit}` : ''}`);
}
compiler.dispose();

// ---------------------------------------------------------------------------
// Browser phase: the real engine in a Vite-built harness page.

fs.mkdirSync(harnessDir, { recursive: true });
fs.writeFileSync(path.join(harnessDir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Playground verification harness</title></head>
<body style="margin:0;font:14px system-ui;color:#eae4d3;background:#0d0f0a">
<div id="preview" style="width:960px;height:760px"></div>
<script type="module" src="./harness.js"></script></body></html>`);
fs.writeFileSync(path.join(harnessDir, 'harness.js'), `
import { createEngine, decodeShare, encodeShare, exportBundle } from ${JSON.stringify(path.join(engineModule, 'index.ts'))};

const state = { engine: null, progress: [], revision: 0, builds: new Map(), handle: null, run: null, warming: 'idle' };
const base64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };
const titan = files => Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith('.titan')));

window.harness = {
  async createEngine() {
    const started = performance.now();
    state.engine = await createEngine(event => state.progress.push(event));
    return performance.now() - started;
  },
  async failedEngine() {
    try {
      (await createEngine(() => {})).dispose();
      return null;
    } catch (error) {
      return error.message;
    }
  },
  startWarm() {
    state.warming = 'pending';
    const started = performance.now();
    state.warmed = state.engine.request('warm', { tier: 2 }, 0).then(() => { state.warming = 'done'; return performance.now() - started; },
      error => { state.warming = 'failed: ' + error.message; return -1; });
  },
  warmState() { return state.warming; },
  async warmDone() {
    const ms = await state.warmed;
    const assets = state.progress.filter(event => event.event === 'asset' && event.loaded === event.total);
    return { ms, assets: assets.length, cached: assets.filter(event => event.cached).length,
      storage: state.progress.filter(event => event.event === 'storage').map(event => event.persistent) };
  },
  async intelligence(files) {
    const revision = ++state.revision;
    await state.engine.request('sync', { revision, files: titan(files) }, revision);
    const diagnostics = await state.engine.request('check', null, revision);
    const emit = await state.engine.request('emit_c', null, revision);
    return { diagnostics: diagnostics.length, units: emit.units.length };
  },
  async build(key, project) {
    const revision = ++state.revision;
    await state.engine.request('sync', { revision, files: titan(project.files) }, revision);
    const diagnostics = await state.engine.request('check', null, revision);
    const build = await state.engine.request('build', null, revision);
    state.builds.set(key, build);
    return { diagnostics, ms: build.ms, reused: build.reused, wasm: build.image.wasm.length, sections: build.sections };
  },
  run(key, project) {
    state.handle?.stop();
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const run = { stdout: '', stderr: '', console: [], errors: [], result: null, ready: false, stopped: false,
      bindings: null, events: [] };
    state.run = run;
    state.handle = state.engine.run({ build: state.builds.get(key), project, revision: state.revision,
      preview: document.getElementById('preview'), onEvent: event => {
        run.events.push(event.type);
        if (event.type === 'stream') run[event.channel] += decoders[event.channel].decode(event.bytes, { stream: true });
        else if (event.type === 'console') run.console.push(event.level + ': ' + event.text);
        else if (event.type === 'error') run.errors.push(event.message);
        else if (event.type === 'ready') run.ready = true;
        else if (event.type === 'stopped') run.stopped = true;
        else if (event.type === 'bindings') run.bindings = event.names;
        else if (event.type === 'result') run.result = { kind: event.kind, status: event.status,
          bytes: new TextDecoder().decode(event.bytes), trace: new TextDecoder().decode(event.trace) };
      } });
  },
  state() { return state.run; },
  stop() { state.handle?.stop(); state.handle = null; },
  dispose() { state.engine?.dispose(); state.engine = null; },
  async share(project) {
    const fragment = await encodeShare(project);
    const decoded = await decodeShare(fragment);
    return { length: fragment.length, same: JSON.stringify(decoded) === JSON.stringify(project) };
  },
  async zip(key, project) {
    const blob = await exportBundle(project, state.builds.get(key).image);
    return base64(new Uint8Array(await blob.arrayBuffer()));
  },
};
window.harnessReady = true;
`);
await viteBuild({
  root: harnessDir, configFile: false, logLevel: 'warn',
  define: { 'import.meta.env.PUBLIC_PLAYGROUND_CDN_BASE': JSON.stringify(assetBase) },
  worker: { format: 'es' },
  build: { outDir: harnessDist, emptyOutDir: true, target: 'esnext' },
});

const executablePath = options.chrome ?? process.env.TITAN_CHROME ??
  process.env.PATH.split(path.delimiter).map(dir => path.join(dir, 'google-chrome')).find(file => fs.existsSync(file));
if (!executablePath) fatal('no Chrome: pass --chrome, set TITAN_CHROME, or put google-chrome on PATH');
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const pageErrors = [];
async function openHarness(context) {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
  await page.goto(`${siteOrigin}/`);
  await page.waitForFunction(() => window.harnessReady === true);
  return page;
}
const newContext = () => browser.newContext({ viewport: { width: 1280, height: 900 } });
async function shot(page, name) {
  if (!options.shots) return;
  fs.mkdirSync(options.shots, { recursive: true });
  const file = path.join(path.resolve(options.shots), `verify-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`Screenshot: ${file} | ${name}`);
}
/** The live preview frame as a playwright Frame (locators and evaluate). */
async function previewFrame(page) {
  const handle = await page.locator('#preview iframe[title="Program preview"]').last().elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('no preview frame');
  return frame;
}
async function waitForRun(page, predicate, timeout = RUN_TIMEOUT_MS) {
  await page.waitForFunction(predicate, null, { timeout, polling: 100 });
  return page.evaluate(() => window.harness.state());
}
function within(promise, ms, what) {
  const { promise: timeout, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const projectOf = example => ({ v: 1, files: { ...example.files }, previewMode: example.previewMode });

/**
 * Unpacks a downloaded bundle, optionally breaks it (`mutate`), serves it from
 * a new origin, and lets `run` assert on the running page through `expect`.
 */
async function runBundle(context, name, zipBase64, run, { mutate = null, expect = check } = {}) {
  const zip = unzipSync(Buffer.from(zipBase64, 'base64'));
  const zipDir = path.join(scratch, 'zip', name);
  fs.rmSync(zipDir, { recursive: true, force: true });
  for (const [entry, bytes] of Object.entries(zip)) {
    if (entry.endsWith('/')) continue;
    fs.mkdirSync(path.dirname(path.join(zipDir, entry)), { recursive: true });
    fs.writeFileSync(path.join(zipDir, entry), bytes);
  }
  if (mutate) {
    mutate(zipDir);
  } else {
    for (const entry of ['index.html', 'app.mjs', 'app.wasm', 'app.wasm.trace', 'app.wasm.map', 'NOTICES.txt', 'project/main.titan']) {
      check(entry in zip, `${name}: the bundle contains ${entry}`);
    }
    check(zip['NOTICES.txt'] && Buffer.from(zip['NOTICES.txt']).equals(Buffer.from(assetBytes('licenses/image-NOTICES.txt'))),
      `${name}: the bundle's NOTICES.txt is the release's verified image notices`);
  }
  const fresh = await listen(staticServer([['/', zipDir, { 'Access-Control-Allow-Origin': '*' }]]));
  const standalone = await context.newPage();
  if (!mutate) standalone.on('pageerror', error => pageErrors.push(`${name} bundle: ${error}`));
  try {
    await standalone.goto(`${originOf(fresh)}/`);
    await run(standalone, expect);
  } catch (error) {
    expect(false, `${name}: the bundle runs from a fresh origin (${error.message})`);
  } finally {
    await standalone.close();
    fresh.close();
  }
  return zip;
}

/** A console bundle's run, once its page prints the final `(kind, status N)` line. */
async function bundleConsoleRun(standalone) {
  const ended = /\((returned|failed|exited), status (-?\d+)\)\n$/;
  await standalone.waitForFunction(source => new RegExp(source).test(document.getElementById('output').textContent),
    ended.source, { timeout: 30_000 });
  const output = await standalone.locator('#output').textContent();
  const [, kind, status] = ended.exec(output);
  // One page shows every channel, so each assertion reads the whole text.
  return { kind, status: Number(status), stdout: output, stderr: output, bytes: output, trace: output };
}

/** The same per-example assertions as the playground run, against an exported page. */
async function runExportedExample(example, standalone, expect) {
  if (isPreview(example)) {
    await PREVIEW[example.slug](standalone.mainFrame(), `${example.slug} bundle`, expect);
  } else {
    const run = await bundleConsoleRun(standalone);
    expect(CONSOLE[example.slug](run), `${example.slug} bundle: output matches (kind ${run.kind}, status ${run.status})`);
  }
}

// Breakages each bundle oracle must catch: a fetch bundle without its data
// fixture, and a preview bundle whose program cannot run.
const BROKEN_BUNDLES = {
  'fetch-json': ['without its data fixture', dir => fs.rmSync(path.join(dir, 'play/data/moons.json'))],
  'mini-react': ['whose program cannot run', dir => fs.writeFileSync(path.join(dir, 'app.wasm'), 'not wasm')],
};

// Verification fixtures beyond the gallery: bindings that load Three by a
// computed specifier in a non-Three mode, and a program that fails after its
// bindings started a timer.
const THREE_PROJECT = { v: 1, previewMode: 'dom', files: {
  'main.titan': 'local browser = import "browser"\n\nfunction main(_args: {string}): integer\n' +
    '  local show = browser.binding("show_three_revision")\n  defer show:close()\n  show:call()\n  return 0\nend\n',
  'bindings.js': 'export default function createBindings(host) {\n  const name = "three";\n  return {\n' +
    '    async show_three_revision() {\n      const THREE = await import(name);\n      const line = document.createElement("p");\n' +
    '      line.id = "three-revision";\n      line.textContent = `three ${THREE.REVISION}`;\n      host.root.append(line);\n    },\n  };\n}\n',
} };
const FAILING_PROJECT = { v: 1, previewMode: 'dom', files: {
  'main.titan': 'local browser = import "browser"\n\nfunction main(_args: {string}): integer\n' +
    '  local start = browser.binding("start_ticking")\n  defer start:close()\n  start:call()\n' +
    '  raise "preview failure after starting a timer"\nend\n',
  'bindings.js': 'export default function createBindings(host) {\n  return {\n    start_ticking() {\n' +
    '      const timer = setInterval(() => console.log("tick"), 20);\n' +
    '      host.signal.addEventListener("abort", () => clearInterval(timer));\n    },\n  };\n}\n',
} };

console.log('Browser phase');

// A failed start leaves nothing running, and a retry succeeds.
{
  const context = await newContext();
  const page = await openHarness(context);
  const catalog = `${assetBase}${manifest.hash}/stdlib_catalog.bin`;
  await page.route(catalog, route => route.fulfill({ status: 200, body: 'corrupt', contentType: 'application/octet-stream' }));
  const failure = await page.evaluate(() => window.harness.failedEngine());
  check(failure !== null && /digest|size/.test(failure), `a corrupt Tier 1 asset fails createEngine (${failure})`);
  await page.waitForTimeout(200);
  check(page.workers().length === 0, `a failed createEngine leaves no Worker running (${page.workers().length})`);
  await page.unroute(catalog);
  check(await page.evaluate(() => window.harness.failedEngine()) === null, 'createEngine succeeds on retry');
  await page.waitForTimeout(200);
  check(page.workers().length === 0, 'disposing the engine stops its Workers');
  await context.close();
}

const context = await newContext();
let page = await openHarness(context);
check(await page.evaluate(() => typeof WebAssembly.Suspending === 'function'), 'Chromium exposes WebAssembly JSPI');
check(await page.evaluate(() => !crossOriginIsolated), 'the harness page is not cross-origin isolated');

// Tier 1 intelligence keeps working while Tier 2 is still downloading.
{
  const { promise: held, resolve: release } = Promise.withResolvers();
  const core = `${assetBase}${manifest.hash}/llvm.core.wasm`;
  await page.route(core, async route => { await held; await route.continue(); });
  const tier1 = await page.evaluate(() => window.harness.createEngine());
  await page.evaluate(() => window.harness.startWarm());
  try {
    const intel = await within(page.evaluate(files => window.harness.intelligence(files), examples[0].files), 30_000,
      'sync/check/emit_c while Tier 2 downloads');
    check(intel.units > 0, `check and emit_c answer a new revision while Tier 2 downloads (${intel.units} units)`);
  } catch (error) {
    check(false, error.message);
  }
  check(await page.evaluate(() => window.harness.warmState()) === 'pending', 'Tier 2 was still downloading meanwhile');
  release();
  const cold = await page.evaluate(() => window.harness.warmDone());
  await page.unroute(core);
  check(cold.storage.includes(true) && !cold.storage.includes(false), `Cache Storage is reported persistent (${cold.storage})`);
  console.log(`  cold: tier 1 ready ${tier1.toFixed(0)} ms, tier 2 staged ${cold.ms.toFixed(0)} ms after it (${cold.assets} assets, ${cold.cached} cached)`);
}

for (const example of selected) {
  const slug = example.slug;
  const project = projectOf(example);
  console.log(`  ${slug}`);
  let built;
  try {
    built = await page.evaluate(([key, value]) => window.harness.build(key, value), [slug, project]);
  } catch (error) {
    check(false, `${slug}: browser build failed: ${error.message}`);
    continue;
  }
  console.log(`    check+emit ${built.ms.check.toFixed(0)} ms, compile ${built.ms.compile.toFixed(0)} ms, link+opt+trace ${built.ms.link.toFixed(0)} ms`);
  await page.evaluate(([key, value]) => window.harness.run(key, value), [slug, project]);
  if (isPreview(example)) {
    const run = await waitForRun(page, () => window.harness.state().ready || window.harness.state().errors.length > 0);
    check(run.errors.length === 0, `${slug}: preview starts without errors (${run.errors.join('; ')})`);
    try {
      await PREVIEW[slug](await previewFrame(page), slug, check);
    } catch (error) {
      check(false, `${slug}: interaction failed: ${error.message}`);
    }
    await shot(page, slug);
    const after = await page.evaluate(() => window.harness.state());
    check(after.errors.length === 0, `${slug}: no errors while interacting (${after.errors.join('; ')})`);
    // Stop → edit bindings.js → Run, right after this example's own build:
    // the image is reused and the edited bindings run.
    if (example === selected.find(isPreview)) {
      const marker = 'edited-bindings-marker';
      const edited = projectOf(example);
      edited.files['bindings.js'] = edited.files['bindings.js']
        .replace(/export default function createBindings\(host\)\s*\{/, `$&\n  console.info(${JSON.stringify(marker)});`);
      check(edited.files['bindings.js'] !== example.files['bindings.js'], `${slug}: bindings.js has the documented entry point`);
      await page.evaluate(() => window.harness.stop());
      const rebuilt = await page.evaluate(([key, value]) => window.harness.build(key, value), [slug, edited]);
      check(rebuilt.ms.compile === 0 && rebuilt.ms.link === 0, `${slug}: a bindings-only edit reuses the last build`);
      await page.evaluate(([key, value]) => window.harness.run(key, value), [slug, edited]);
      const rerun = await waitForRun(page, () => window.harness.state().ready || window.harness.state().errors.length > 0);
      check(rerun.console.some(line => line.includes(marker)), `${slug}: the edited bindings.js runs after Stop → Run`);
    }
    await page.evaluate(() => window.harness.stop());
    await page.waitForTimeout(600);
    check(await page.locator('#preview iframe').count() === 0, `${slug}: Stop removes the preview frame`);
  } else {
    const run = await waitForRun(page, () => window.harness.state().stopped);
    check(run.errors.length === 0, `${slug}: runs without errors (${run.errors.join('; ')})`);
    const result = run.result ?? { kind: 'none', status: -1, bytes: '', trace: '' };
    check(CONSOLE[slug]({ ...result, stdout: run.stdout, stderr: run.stderr }),
      `${slug}: browser console output matches (kind ${result.kind}, status ${result.status})`);
    await shot(page, slug);
  }
  const shared = await page.evaluate(value => window.harness.share(value), project);
  check(shared.same, `${slug}: #v1= share link round-trips (${shared.length} chars)`);
  const zipped = await page.evaluate(([key, value]) => window.harness.zip(key, value), [slug, project]);
  await runBundle(context, slug, zipped, (standalone, expect) => runExportedExample(example, standalone, expect));
  if (BROKEN_BUNDLES[slug]) {
    const [breakage, mutate] = BROKEN_BUNDLES[slug];
    const caught = [];
    await runBundle(context, `${slug}-broken`, zipped, (standalone, expect) => runExportedExample(example, standalone, expect),
      { mutate, expect: (ok, message) => { if (!ok) caught.push(message); } });
    check(caught.length > 0, `${slug}: the bundle check rejects a bundle ${breakage}`);
  }
}

// A program that fails after its bindings allocated a timer is torn down
// after its result: no frame and no further output remain.
{
  await page.evaluate(([key, value]) => window.harness.build(key, value), ['failing', FAILING_PROJECT]);
  await page.evaluate(([key, value]) => window.harness.run(key, value), ['failing', FAILING_PROJECT]);
  const run = await waitForRun(page, () => window.harness.state().stopped);
  check(run.result?.kind === 'failed' && run.events.indexOf('result') < run.events.indexOf('stopped'),
    `a failed preview delivers its result, then stops (${run.events.join(', ')})`);
  check(/preview failure after starting a timer/.test(run.result?.bytes ?? ''), 'the failed preview reports its error');
  await page.waitForTimeout(600);
  const ticks = (await page.evaluate(() => window.harness.state())).console.length;
  await page.waitForTimeout(300);
  check((await page.evaluate(() => window.harness.state())).console.length === ticks, 'the failed preview stops its timer');
  check(await page.locator('#preview iframe').count() === 0, 'the failed preview removes its frame');
}
await page.close();

// A second visit is served from Cache Storage, even with the asset origin
// unreachable: Tier 1, Tier 2 and the Three graph of a non-Three project.
page = await openHarness(context);
await context.route(`${assetBase}**`, route => route.abort());
const warmTier1 = await page.evaluate(() => window.harness.createEngine());
await page.evaluate(() => window.harness.startWarm());
const warm = await page.evaluate(() => window.harness.warmDone());
console.log(`  second visit, asset origin unreachable: tier 1 ready ${warmTier1.toFixed(0)} ms, tier 2 staged ${warm.ms.toFixed(0)} ms after it (${warm.cached}/${warm.assets} cached)`);
check(warm.assets > 0 && warm.cached === warm.assets, 'a second visit loads every asset from Cache Storage');
await page.evaluate(([key, value]) => window.harness.build(key, value), ['three', THREE_PROJECT]);
await page.evaluate(([key, value]) => window.harness.run(key, value), ['three', THREE_PROJECT]);
try {
  const frame = await previewFrame(page);
  await frame.locator('#three-revision').waitFor({ timeout: 30_000 });
  check(await frame.locator('#three-revision').textContent() === 'three 187',
    'bindings import the verified Three from Cache Storage with the asset origin unreachable');
} catch (error) {
  check(false, `a computed import('three') in dom mode runs from Cache Storage: ${error.message}`);
}
await page.evaluate(() => window.harness.stop());
// Running needs no network; a download may fetch files no run has used yet
// (here Three's license), so the asset origin comes back first.
await context.unroute(`${assetBase}**`);
const threeZip = await page.evaluate(([key, value]) => window.harness.zip(key, value), ['three', THREE_PROJECT]);
const threeBundle = await runBundle(context, 'computed-three', threeZip, async standalone => {
  await standalone.locator('#three-revision').waitFor({ timeout: 30_000 });
  check(await standalone.locator('#three-revision').textContent() === 'three 187', 'the zip of a dom project resolves its Three import');
});
check(['vendor/three.module.js', 'vendor/three.core.js', 'vendor/three.LICENSE.txt'].every(entry => entry in threeBundle),
  'the zip of a project with bindings.js vendors Three and its license');
await page.close();
await context.close();

check(pageErrors.length === 0, `no uncaught page errors (${pageErrors.join('; ')})`);
await browser.close();
assetServer.close();
site.close();
fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures.length === 0 ? `verify-examples: PASS (${selected.length} examples)` :
  `verify-examples: ${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
