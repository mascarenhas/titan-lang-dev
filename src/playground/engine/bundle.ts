// Client-side "Download" bundle: the exact image the playground built, a small
// host page with the same binding contract as the preview frame, the editable
// `bindings.js` with the vendored Three graph it may import, the notices of
// everything the image redistributes, any `/play/data/` fixture the sources
// name, and the project's source snapshot under `project/`.

import { zipSync, type Zippable } from 'fflate';
import type { Image, Project } from '../types.ts';
import { projectProblem } from './paths.ts';

export interface BundleSources {
  /** Verified vendored Three files; every project with bindings.js ships them. */
  three(): Promise<{ module: Uint8Array; core: Uint8Array; license: Uint8Array }>;
  /** Verified notices for the Titan runtime, standard library and C libraries in every image. */
  notices(): Promise<Uint8Array>;
  /** A same-site `/play/data/<name>` fixture. */
  fixture(name: string): Promise<Uint8Array>;
}

const FIXTURE = /["']\/play\/data\/([A-Za-z0-9._-]+)["']/g;
const ZIP_TIME = new Date('2026-01-01T00:00:00Z');
const PREVIEW_MODES = ['console', 'canvas2d', 'dom', 'three'];

function hostPage(project: Project, hasBindings: boolean): string {
  const importMap = hasBindings ?
    '\n<script type="importmap">{"imports":{"three":"./vendor/three.module.js"}}</script>' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Titan program</title>${importMap}
<style>
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color-scheme: light dark; }
#stage { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem; outline: none; }
#stage > canvas { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; touch-action: none; }
#output { margin: 0; padding: 0.75rem; white-space: pre-wrap; }
</style>
</head>
<body>
<main id="stage" tabindex="0" aria-label="Program"></main>
<pre id="output" aria-live="polite"></pre>
<script type="module">
// Serve this folder over HTTP (browsers refuse ES modules from file:// URLs).
import create from "./app.mjs";

const mode = ${JSON.stringify(project.previewMode)};
const stage = document.getElementById("stage");
const output = document.getElementById("output");
const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
const show = channel => chunk => { output.textContent += decoders[channel].decode(chunk, { stream: true }); };
const canvas = document.createElement("canvas");
canvas.width = 640;
canvas.height = 400;
if (mode === "canvas2d" || mode === "three") stage.append(canvas);
stage.addEventListener("pointerdown", () => stage.focus({ preventScroll: true }));
const controller = new AbortController();
const bindings = ${hasBindings ?
    '(await import("./bindings.js")).default({ root: stage, canvas, signal: controller.signal })' : '{}'};
const instance = create({
  bindings,
  requireTrace: true,
  env: { PLAYGROUND_ORIGIN: location.origin },
  stdout: show("stdout"),
  stderr: show("stderr"),
});
// The program reports its own errors on stderr; the page adds how it ended.
try {
  const result = await instance.run([]);
  output.textContent += \`(\${result.kind}, status \${result.status})\\n\`;
} catch (error) {
  output.textContent += \`\${error}\\n\`;
}
${hasBindings ? '// Interactive programs keep running; reload the page to restart.' : 'await instance.dispose();'}
</script>
</body>
</html>
`;
}

export async function buildBundle(project: Project, image: Image, sources: BundleSources): Promise<Blob> {
  const problem = projectProblem(project.files) ??
    (PREVIEW_MODES.includes(project.previewMode) ? null : 'The project names an unknown preview mode.');
  if (problem) throw new Error(problem);
  const utf8 = new TextEncoder();
  const bindings = project.files['bindings.js'];
  const files: Zippable = {
    'index.html': utf8.encode(hostPage(project, bindings !== undefined)),
    'app.mjs': utf8.encode(image.mjs),
    // Already compressed or high-entropy payloads are stored.
    'app.wasm': [image.wasm, { level: 0 }],
    'app.wasm.trace': [image.trace, { level: 0 }],
    'app.wasm.map': utf8.encode(image.map),
    'NOTICES.txt': await sources.notices(),
  };
  if (bindings !== undefined) {
    files['bindings.js'] = utf8.encode(bindings);
    const three = await sources.three();
    files.vendor = { 'three.module.js': three.module, 'three.core.js': three.core, 'three.LICENSE.txt': three.license };
  }
  const fixtures = new Set<string>();
  for (const [path, text] of Object.entries(project.files)) {
    if (path.endsWith('.titan')) for (const match of text.matchAll(FIXTURE)) fixtures.add(match[1]);
  }
  if (fixtures.size > 0) {
    const data: Zippable = {};
    for (const name of [...fixtures].sort()) data[name] = await sources.fixture(name);
    files.play = { data };
  }
  const projectFiles: Zippable = {};
  for (const [path, text] of Object.entries(project.files)) projectFiles[path] = utf8.encode(text);
  files.project = projectFiles;
  const zip = zipSync(files, { level: 6, mtime: ZIP_TIME });
  return new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}
