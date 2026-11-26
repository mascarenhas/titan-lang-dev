#!/usr/bin/env node
// Packs the playground's content-hashed asset set (CONTRACTS.md §2):
//
//   node scripts/build-playground-assets.mjs --titan-bundle <PLAYGROUND_OUT>
//     --titan-revision <sha> --wasm-opt <dir> --wasi-sdk <WASI_SDK_PATH>
//     --out <staged-dir> [--site-manifest public/play/playground-assets.json]
//     [--measure]
//
// writes `<out>/<hash>/<path>` for every manifest row, the immutable
// `<out>/<hash>/playground-assets.json`, and the byte-identical stable pointer
// `<out>/playground-assets.json` (and `--site-manifest`, when given). Identical
// inputs give identical bytes and therefore the identical version hash.
//
//   node scripts/build-playground-assets.mjs serve --dir <staged-dir> [--port 4174]
//
// serves a staged set at `http://127.0.0.1:<port>/playground/` with the CORS
// and media types of the CDN, for `PUBLIC_PLAYGROUND_CDN_BASE` in local work.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';
import { readTar, writeTar } from '../src/playground/engine/tar.ts';
import { Toolchain } from '../src/playground/engine/toolchain.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The pinned YoWASP release, the exact generated resource table its bundle
// carries, and its virtual filesystem's path walk; the packer replaces only
// those two passages and refuses any other input.
const YOWASP_VERSION = '22.0.0-git20695-13';
const YOWASP_BUNDLE_SHA256 = 'd0af4569bff0c5b50fa51916ebec3d8ec1f7e8721adadbcbb43207434e4305eb';
const YOWASP_RESOURCE_TABLE = `var modules = async (fetch3) => ({
  "llvm.core.wasm": await fetch3(new URL("./llvm.core.wasm", import.meta.url)).then(compileWasmModule),
  "llvm.core2.wasm": await fetch3(new URL("./llvm.core2.wasm", import.meta.url)).then(compileWasmModule),
  "llvm.core3.wasm": await fetch3(new URL("./llvm.core3.wasm", import.meta.url)).then(compileWasmModule),
  "llvm.core4.wasm": await fetch3(new URL("./llvm.core4.wasm", import.meta.url)).then(compileWasmModule)
});
var filesystem = async (fetch3) => ({
  "usr": await fetch3(new URL("./llvm-resources.tar", import.meta.url)).then((resp) => resp.arrayBuffer()).then(unpackTarFilesystem)
});
var totalSize = 104146055;
`;
const YOWASP_EXPORTS = `export {
  Exit,
  commands,
  runClang,
  runLLVM,
  version
};
`;

// `Directory.traverse` ignores `..`, so `nested/../other/deep.ffi.h` resolves
// to `nested/other/deep.ffi.h`; Titan's generated headers include their
// dependencies by such relative paths.
const YOWASP_TRAVERSE = `    let entry = this;
    let separatorAt = -1;
    do {
      if (entry instanceof File)
        throw "not-directory";
      const files = entry.files;
      separatorAt = path.indexOf("/");
      const segment = separatorAt === -1 ? path : path.substring(0, separatorAt);
      if (separatorAt === -1 && remove)
        delete files[segment];
      else if (segment === "" || segment === ".")
        ;
      else if (segment === "..")
        ;
      else if (Object.hasOwn(files, segment))
        entry = files[segment];
      else if (create === "directory" || create !== null && separatorAt !== -1)
        entry = files[segment] = new _Directory({});
      else if (create === "file")
        entry = files[segment] = new File(new Uint8Array());
      else if (create instanceof File || create instanceof _Directory)
        entry = files[segment] = create;
      else
        throw "no-entry";
      path = path.substring(separatorAt + 1);
`;
const PLAYGROUND_TRAVERSE = `    let entry = this;
    // Titan playground: \`..\` returns to the directory this lookup descended
    // from, and never climbs above the directory the lookup started in.
    const parents = [];
    let separatorAt = -1;
    do {
      if (entry instanceof File)
        throw "not-directory";
      const files = entry.files;
      separatorAt = path.indexOf("/");
      const segment = separatorAt === -1 ? path : path.substring(0, separatorAt);
      if (separatorAt === -1 && remove)
        delete files[segment];
      else if (segment === "" || segment === ".")
        ;
      else if (segment === "..")
        entry = parents.pop() ?? entry;
      else {
        parents.push(entry);
        if (Object.hasOwn(files, segment))
          entry = files[segment];
        else if (create === "directory" || create !== null && separatorAt !== -1)
          entry = files[segment] = new _Directory({});
        else if (create === "file")
          entry = files[segment] = new File(new Uint8Array());
        else if (create instanceof File || create instanceof _Directory)
          entry = files[segment] = create;
        else
          throw "no-entry";
      }
      path = path.substring(separatorAt + 1);
`;
const LLVM_CORE_MODULES = ['llvm.core.wasm', 'llvm.core2.wasm', 'llvm.core3.wasm', 'llvm.core4.wasm'];
const THREE_VERSION = '0.187.0';

// Clang's own freestanding C headers (resource directory) that wasm32 C99 can
// include; target intrinsics and C++/GPU/offload trees stay out. The packer
// proves the kept set is closed under the resource headers' own #includes.
const CLANG_C_HEADER =
  /^(__(stddef|stdarg|float)_[a-z0-9_]+|float|inttypes|iso646|limits|stdalign|stdarg|stdatomic|stdbool|stdckdint|stdcountof|stddef|stddefer|stdint|stdnoreturn|tgmath|unwind|varargs|wasm_simd128)\.h$/;
const COMPILER_RT = 'lib/wasm32-unknown-wasip1/libclang_rt.builtins.a';
// Exactly the CRT and C libraries the reactor link names (`-lc`, `-lsetjmp`,
// `-lwasi-emulated-process-clocks`, `-lc-printscan-long-double`).
const WASI_LIBRARIES = ['crt1-reactor.o', 'libc.a', 'libsetjmp.a', 'libwasi-emulated-process-clocks.a',
  'libc-printscan-long-double.a'];
const WASI_CXX_DIRECTORIES = new Set(['c++', 'eh', 'noeh']);

const TITAN_TIER1 = ['titanc.mjs', 'titanc.wasm', 'stdlib_catalog.bin', 'analysis-target', 'absent-modules',
  'stdlib-sources.json'];
const TITAN_TIER2 = ['titan.a', 'liblua.a', 'libtitan.a', 'libtitan-lpeglabel.a', 'headers.tar', 'link-plan.json',
  'titan-browser.mjs', 'titan-wasm-factory.mjs'];
const SDK_ARCHIVES = ['titan.a', 'libtitan-lpeglabel.a', 'libtitan.a', 'liblua.a'];
const PLAYGROUND_MAX_MEMORY = 268435456;

// Upstream notice texts, verbatim: wasi-libc (WebAssembly/wasi-libc
// 2e6fb9d8ee0c, the revision in wasi-sdk 34's VERSION), LLVM release/22.x
// LICENSE.TXT, YoWASP/clang and YoWASP/runtime-js LICENSE.txt, and the
// licenses of nanotar and jco, whose code is bundled in YoWASP's bundle.js.
const NOTICES_DIR = path.join(ROOT, 'src', 'playground', 'engine', 'notices');
// The toolchain notices that cover code linked into every image.
const IMAGE_TOOLCHAIN_NOTICES = ['llvm-LICENSE.txt', 'wasi-libc-LICENSE.txt', 'wasi-libc-LICENSE-APACHE-LLVM.txt',
  'wasi-libc-LICENSE-APACHE.txt', 'wasi-libc-LICENSE-MIT.txt', 'wasi-libc-libc-top-half-musl-COPYRIGHT.txt',
  'wasi-libc-libc-bottom-half-cloudlibc-LICENSE.txt', 'wasi-libc-fts-musl-fts-COPYING.txt'];

// Pack-time placeholders for the driver's `-###` expansion; the engine
// substitutes each exact argument (engine/toolchain.ts).
const UNIT_SOURCE = '/work/PLAYGROUND_UNIT.c';
const UNIT_DIRECTORY = '/work/PLAYGROUND_UNIT_DIR';
const UNIT_OBJECT = '/PLAYGROUND_OBJECT.o';
const LINK_OUTPUT = '/PLAYGROUND_IMAGE.wasm';
const LINK_ENTRY = '/PLAYGROUND_ENTRY.o';
const LINK_UNITS = '/PLAYGROUND_UNITS.o';
const HEADERS_MOUNT = '/titan/headers';
const ARCHIVES_MOUNT = '/titan/lib';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = new TextEncoder();

function fail(message) {
  console.error(`build-playground-assets: ${message}`);
  process.exit(1);
}

export function mimeOf(name) {
  if (name.endsWith('.wasm')) return 'application/wasm';
  if (name.endsWith('.mjs') || name.endsWith('.js')) return 'text/javascript';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.txt') || name.endsWith('.md')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function read(file) {
  try {
    return new Uint8Array(fs.readFileSync(file));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read JSON ${file}: ${error.message}`);
  }
}

function adaptYowaspBundle(bundle, totalSize) {
  if (sha256(bundle) !== YOWASP_BUNDLE_SHA256) fail('unexpected @yowasp/clang gen/bundle.js contents');
  const source = new TextDecoder().decode(bundle);
  const split = (haystack, needle, what) => {
    const parts = haystack.split(needle);
    if (parts.length !== 2) fail(`@yowasp/clang bundle no longer has its expected ${what}`);
    return parts;
  };
  const [before, after] = split(source, YOWASP_TRAVERSE, 'directory traversal');
  const [head, tail] = split(before + PLAYGROUND_TRAVERSE + after, YOWASP_RESOURCE_TABLE, 'resource table');
  const [body, end] = split(tail, YOWASP_EXPORTS, 'export list');
  // The asset manager owns fetching, verification, caching and progress; the
  // bundle only receives the compiled core modules and the resource archive.
  const table = `// Titan playground: verified, cached resources come from provideResources().
var playgroundResources = null;
function provideResources(resources) {
  playgroundResources = resources;
}
var modules = async () => playgroundResources.modules();
var filesystem = async () => ({
  "usr": unpackTarFilesystem(await playgroundResources.archive())
});
var totalSize = ${totalSize};
`;
  return text.encode(head + table + body + YOWASP_EXPORTS.replace('  version\n', '  version,\n  provideResources\n') + end);
}

function buildC99Archive(stockTar, wasiSdk) {
  const stock = new Map(readTar(stockTar).filter(entry => entry.type === 'file').map(entry => [entry.name, entry.data]));
  const files = new Map();
  const resourceHeaders = [...stock.keys()].filter(name => /^include\/[^/]+$/.test(name));
  for (const name of resourceHeaders) {
    if (CLANG_C_HEADER.test(name.slice('include/'.length))) files.set(name, stock.get(name));
  }
  // Closure: a kept header may include only kept resource headers or libc.
  const decoder = new TextDecoder();
  for (const [name, data] of files) {
    for (const match of decoder.decode(data).matchAll(/^\s*#\s*include(?:_next)?\s*[<"]([^>"]+)[>"]/gm)) {
      const target = `include/${match[1]}`;
      if (stock.has(target) && !files.has(target)) fail(`${name} includes dropped resource header ${match[1]}`);
    }
  }
  const builtins = stock.get(COMPILER_RT);
  if (!builtins) fail(`@yowasp/clang resources lack ${COMPILER_RT}`);
  files.set(COMPILER_RT, builtins);

  const sysroot = path.join(wasiSdk, 'share', 'wasi-sysroot');
  const version = fs.readFileSync(path.join(wasiSdk, 'VERSION'), 'utf8').split('\n')[0].trim();
  if (!/^34(\.|$)/.test(version)) fail(`wasi-sdk major 34 required, found ${version}`);
  const includeRoot = path.join(sysroot, 'include', 'wasm32-wasip1');
  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!relative && WASI_CXX_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(directory, entry.name), name);
      } else if (entry.isFile()) {
        files.set(`include/wasm32-wasip1/${name}`, read(path.join(directory, entry.name)));
      } else {
        fail(`unexpected sysroot entry ${path.join(directory, entry.name)}`);
      }
    }
  };
  walk(includeRoot, '');
  for (const library of WASI_LIBRARIES) {
    files.set(`lib/wasm32-wasip1/${library}`, read(path.join(sysroot, 'lib', 'wasm32-wasip1', library)));
  }
  return writeTar(files);
}

// Quoted argv of the in-process command line `clang -###` prints.
function driverCommand(output, tool) {
  for (const line of output.split('\n')) {
    const argv = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\(.)/g, '$1'));
    if (argv[0] === '' && argv[1] === tool) return argv.slice(1);
    if (argv[0] === tool) return argv;
  }
  fail(`clang -### printed no ${tool} command:\n${output}`);
}

function exactlyOnce(argv, value, what) {
  const count = argv.filter(arg => arg === value).length;
  if (count !== 1) fail(`${what}: expected ${value} once in the expanded command, found ${count}`);
}

async function expandRecipe(llvm, plan) {
  for (const key of ['compile_flags', 'include_roots', 'link_flags', 'optimizer_flags']) {
    if (!Array.isArray(plan[key]) || plan[key].some(item => typeof item !== 'string')) {
      fail(`link-plan.json: ${key} must be an array of strings`);
    }
  }
  const run = async (args, files) => {
    const chunks = [];
    const sink = bytes => { if (bytes) chunks.push(Buffer.from(bytes)); };
    try {
      await llvm.runLLVM(['clang', '-###', ...args], files, { stdout: sink, stderr: sink, fetchProgress: () => {} });
    } catch (error) {
      fail(`clang -### failed (${error.message}):\n${Buffer.concat(chunks).toString()}`);
    }
    return Buffer.concat(chunks).toString();
  };
  const includes = plan.include_roots.flatMap(root => ['-I', `${HEADERS_MOUNT}/${root}`]);
  const cc1 = driverCommand(await run(['--target=wasm32-wasip1', ...plan.compile_flags, ...includes,
    '-I', UNIT_DIRECTORY, '-c', UNIT_SOURCE, '-o', UNIT_OBJECT], { work: { 'PLAYGROUND_UNIT.c': '' } }), 'clang');
  if (cc1[1] !== '-cc1') fail('clang -### did not expand to an in-process -cc1 command');
  for (const value of [UNIT_SOURCE, UNIT_DIRECTORY, UNIT_OBJECT, 'PLAYGROUND_UNIT.c']) exactlyOnce(cc1, value, 'cc1');

  const placeholders = { 'PLAYGROUND_ENTRY.o': '', 'PLAYGROUND_UNITS.o': '' };
  const archives = Object.fromEntries(SDK_ARCHIVES.map(name => [name, '']));
  const ld = driverCommand(await run(['--target=wasm32-wasip1', ...plan.link_flags, '-o', LINK_OUTPUT, LINK_ENTRY,
    LINK_UNITS, ...SDK_ARCHIVES.map(name => `${ARCHIVES_MOUNT}/${name}`)],
  { ...placeholders, titan: { lib: archives } }), 'wasm-ld');
  for (const value of [LINK_OUTPUT, LINK_ENTRY, LINK_UNITS]) exactlyOnce(ld, value, 'wasm-ld');
  const memory = ld.findIndex(arg => arg.startsWith('--max-memory='));
  if (memory === -1 || ld.findLastIndex(arg => arg.startsWith('--max-memory=')) !== memory) {
    fail('wasm-ld: expected exactly one --max-memory');
  }
  ld[memory] = `--max-memory=${PLAYGROUND_MAX_MEMORY}`;
  if (ld.some(arg => arg === '--allow-undefined' || arg.includes('-group'))) {
    fail('wasm-ld: the link must not allow undefined symbols or use archive groups');
  }
  // Playground override (CONTRACTS.md §1, option B): no post-link Binaryen
  // optimization level. On a 9 MB validation image `-O1` costs ~10 s per Run;
  // `--debuginfo --stack-check` and every feature flag stay as planned.
  const levels = plan.optimizer_flags.filter(arg => /^-O/.test(arg));
  if (levels.length !== 1 || levels[0] !== '-O1') fail(`link-plan.json: expected one -O1 optimizer level, found ${levels}`);
  const wasmOpt = plan.optimizer_flags.filter(arg => arg !== '-O1');
  for (const flag of ['--debuginfo', '--stack-check']) {
    if (!wasmOpt.includes(flag)) fail(`link-plan.json: optimizer flags lack ${flag}`);
  }
  return {
    yowasp: YOWASP_VERSION,
    cc1,
    wasmLd: ld,
    wasmOpt,
    headers: { mount: HEADERS_MOUNT, roots: plan.include_roots },
    archives: { mount: ARCHIVES_MOUNT, names: SDK_ARCHIVES },
    placeholders: {
      unitSource: UNIT_SOURCE, unitDirectory: UNIT_DIRECTORY, unitObject: UNIT_OBJECT,
      unitMainFile: 'PLAYGROUND_UNIT.c', linkOutput: LINK_OUTPUT, linkEntry: LINK_ENTRY, linkUnits: LINK_UNITS,
    },
  };
}

// Translation units compiled through the engine's own Toolchain (packed
// recipe, sysroot, SDK headers and the adapted YoWASP filesystem), so a broken
// archive, flag set or path walk fails the pack. The `..` probes carry a
// decoy header where an ignored `..` would land.
const PROBES = [
  ['probe.c', {
    'probe.c': '#include <stdio.h>\n#include <setjmp.h>\n#include "lua.h"\n#include "lauxlib.h"\n#include "titan.h"\n' +
      'int playground_probe(lua_State *L) { jmp_buf j; if (setjmp(j)) return 1; lua_pushinteger(L, 1);' +
      ' return snprintf(0, 0, "%d", 1); }\n',
  }],
  ['nested/util.c', {
    'nested/util.c': '#include "util.ffi.h"\nint util_probe(void) { return UTIL_VALUE; }\n',
    'nested/util.ffi.h': '#include "../other/deep.ffi.h"\n#define UTIL_VALUE (DEEP_VALUE + 1)\n',
    'nested/other/deep.ffi.h': '#error "`..` was ignored"\n',
    'other/deep.ffi.h': '#define DEEP_VALUE 41\n',
  }],
  ['.titan-links/main/synthetic/main__entrypoint.c', {
    '.titan-links/main/synthetic/main__entrypoint.c': '#include "../../../other/deep.ffi.h"\nint entry_probe(void) { return DEEP_VALUE; }\n',
    '.titan-links/main/synthetic/other/deep.ffi.h': '#error "`..` was ignored"\n',
    'other/deep.ffi.h': '#define DEEP_VALUE 41\n',
  }],
];

async function probeToolchain(staging, assets) {
  const toolchain = await Toolchain.open({
    manifestHash: 'pack-probe',
    bytes: async name => assets.get(name).bytes,
    wasmModule: async name => WebAssembly.compile(assets.get(name).bytes),
    importModule: async name => import(pathToFileURL(path.join(staging, name)).href),
  });
  for (const [key, files] of PROBES) {
    try {
      if ((await toolchain.compile(files, key)).length === 0) fail(`probe ${key} produced an empty object`);
    } catch (error) {
      fail(`probe ${key}: ${error.message}`);
    }
  }
}

async function loadAdaptedLlvm(staging, assets) {
  for (const name of ['llvm.mjs', 'wasm-opt.mjs']) fs.writeFileSync(path.join(staging, name), assets.get(name).bytes);
  const llvm = await import(pathToFileURL(path.join(staging, 'llvm.mjs')).href);
  llvm.provideResources({
    modules: async () => Object.fromEntries(await Promise.all(LLVM_CORE_MODULES.map(async name =>
      [name, await WebAssembly.compile(assets.get(name).bytes)]))),
    archive: async () => assets.get('llvm-resources-c99.tar').bytes.slice().buffer,
  });
  return llvm;
}

function manifestHash(titanRevision, rows) {
  return sha256(text.encode(JSON.stringify({ schema: 1, titanRevision, profile: 'validation', assets: rows })));
}

async function pack(options) {
  for (const key of ['titan-bundle', 'titan-revision', 'wasm-opt', 'wasi-sdk', 'out']) {
    if (!options[key]) fail(`missing --${key}`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(options['titan-revision'])) fail('--titan-revision must be a git commit id');
  const bundle = path.resolve(options['titan-bundle']);
  const out = path.resolve(options.out);
  const assets = new Map();
  const add = (name, tier, bytes) => {
    if (assets.has(name)) fail(`duplicate asset ${name}`);
    assets.set(name, { tier, bytes });
  };

  const yowasp = path.join(ROOT, 'node_modules', '@yowasp', 'clang');
  const yowaspVersion = readJson(path.join(yowasp, 'package.json')).version;
  if (yowaspVersion !== YOWASP_VERSION) fail(`@yowasp/clang ${YOWASP_VERSION} required, found ${yowaspVersion}`);
  for (const name of LLVM_CORE_MODULES) add(name, 2, read(path.join(yowasp, 'gen', name)));
  add('llvm-resources-c99.tar', 2, buildC99Archive(read(path.join(yowasp, 'gen', 'llvm-resources.tar')),
    path.resolve(options['wasi-sdk'])));
  const resourceBytes = [...LLVM_CORE_MODULES, 'llvm-resources-c99.tar']
    .reduce((sum, name) => sum + assets.get(name).bytes.length, 0);
  add('llvm.mjs', 2, adaptYowaspBundle(read(path.join(yowasp, 'gen', 'bundle.js')), resourceBytes));

  const wasmOptDir = path.resolve(options['wasm-opt']);
  const wasmOptRecord = readJson(path.join(wasmOptDir, 'wasm-opt.json'));
  if (wasmOptRecord.binaryen !== 'version_133') fail('wasm-opt must be Binaryen version_133');
  for (const [file, asset] of [['wasm-opt.js', 'wasm-opt.mjs'], ['wasm-opt.wasm', 'wasm-opt.wasm']]) {
    const bytes = read(path.join(wasmOptDir, file));
    if (sha256(bytes) !== wasmOptRecord[file]) fail(`${file} does not match wasm-opt.json`);
    add(asset, 2, bytes);
  }
  // Binaryen's license, and Emscripten's for the JS runtime and system
  // libraries (musl, libc++, compiler-rt) compiled into wasm-opt.wasm.
  add('licenses/binaryen-LICENSE.txt', 2, read(path.join(wasmOptDir, 'LICENSE')));
  const emscriptenDir = path.join(wasmOptDir, 'emscripten');
  for (const name of fs.readdirSync(emscriptenDir).sort()) {
    add(`licenses/emscripten/${name}`, 2, read(path.join(emscriptenDir, name)));
  }
  // YoWASP (Apache-2.0 package, ISC runtime, bundled nanotar and jco glue),
  // LLVM for Clang/LLD/compiler-rt, and wasi-libc for the packed sysroot.
  for (const name of fs.readdirSync(NOTICES_DIR).sort()) add(`licenses/toolchain/${name}`, 2, read(path.join(NOTICES_DIR, name)));

  for (const name of TITAN_TIER1) add(name, 1, read(path.join(bundle, name)));
  for (const name of TITAN_TIER2) add(name, 2, read(path.join(bundle, name)));
  const titanNotices = [['LICENSE', 'licenses/titan-LICENSE.txt'], ['THIRD_PARTY_NOTICES.md', 'licenses/titan-THIRD_PARTY_NOTICES.md']];
  const licenseDir = path.join(bundle, 'LICENSES');
  for (const name of fs.readdirSync(licenseDir).sort()) titanNotices.push([`LICENSES/${name}`, `licenses/titan/${name}.txt`]);
  for (const [source, asset] of titanNotices) add(asset, 2, read(path.join(bundle, source)));
  // Every deployed image carries the Titan runtime and standard library (with
  // their bundled third parties), wasi-libc and compiler-rt builtins.
  const imageNotices = [...titanNotices.map(([, asset]) => asset),
    ...IMAGE_TOOLCHAIN_NOTICES.map(name => `licenses/toolchain/${name}`)];
  add('licenses/image-NOTICES.txt', 2, text.encode(imageNotices.map(asset =>
    `${'='.repeat(78)}\n${asset.replace(/^licenses\//, '')}\n${'='.repeat(78)}\n\n${new TextDecoder().decode(assets.get(asset).bytes).trimEnd()}\n`)
    .join('\n')));

  const three = path.join(ROOT, 'node_modules', 'three');
  const threeVersion = readJson(path.join(three, 'package.json')).version;
  if (threeVersion !== THREE_VERSION) fail(`three ${THREE_VERSION} required, found ${threeVersion}`);
  const threeModule = read(path.join(three, 'build', 'three.module.js'));
  const threeSource = new TextDecoder().decode(threeModule);
  // The preview frame points these specifiers at its own blob of three.core.js.
  const specifiers = [...threeSource.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)].map(match => match[2]);
  if (specifiers.length === 0 || specifiers.some(specifier => specifier !== './three.core.js') ||
      !threeSource.includes("'./three.core.js'")) {
    fail(`three.module.js must import only './three.core.js' (found ${[...new Set(specifiers)]})`);
  }
  add('vendor/three.module.js', 2, threeModule);
  add('vendor/three.core.js', 2, read(path.join(three, 'build', 'three.core.js')));
  add('vendor/three.LICENSE.txt', 2, read(path.join(three, 'LICENSE')));

  fs.mkdirSync(out, { recursive: true });
  const staging = fs.mkdtempSync(path.join(out, '.staging-'));
  try {
    const llvm = await loadAdaptedLlvm(staging, assets);
    const recipe = await expandRecipe(llvm, readJson(path.join(bundle, 'link-plan.json')));
    add('llvm-recipe.json', 2, text.encode(JSON.stringify(recipe, null, 2) + '\n'));
    await probeToolchain(staging, assets);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const rows = [...assets.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(name => {
    const { tier, bytes } = assets.get(name);
    return { path: name, tier, bytes: bytes.length, sha256: sha256(bytes), mime: mimeOf(name) };
  });
  const hash = manifestHash(options['titan-revision'], rows);
  const manifest = text.encode(JSON.stringify({ schema: 1, hash, titanRevision: options['titan-revision'],
    profile: 'validation', assets: rows }, null, 2) + '\n');
  const version = path.join(out, hash);
  for (const row of rows) {
    const file = path.join(version, row.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, assets.get(row.path).bytes);
  }
  fs.writeFileSync(path.join(version, 'playground-assets.json'), manifest);
  fs.writeFileSync(path.join(out, 'playground-assets.json'), manifest);
  if (options['site-manifest']) {
    fs.mkdirSync(path.dirname(path.resolve(options['site-manifest'])), { recursive: true });
    fs.writeFileSync(path.resolve(options['site-manifest']), manifest);
  }

  console.log(`playground assets ${hash} (${rows.length} files) in ${version}`);
  for (const row of rows) {
    let line = `  tier ${row.tier}  ${String(row.bytes).padStart(10)}  ${row.path}`;
    if (options.measure) {
      const br = zlib.brotliCompressSync(assets.get(row.path).bytes, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: row.bytes },
      }).length;
      line += `  br11 ${br}`;
    }
    console.log(line);
  }
  const total = tier => rows.filter(row => row.tier === tier).reduce((sum, row) => sum + row.bytes, 0);
  console.log(`  tier 1 raw ${total(1)} bytes, tier 2 raw ${total(2)} bytes`);
}

/** Serves `directory` under `/playground/` like the CDN; resolves to the server. */
export function serveAssets(directory, port, host = '127.0.0.1') {
  const root = path.resolve(directory);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    const relative = decodeURIComponent(url.pathname).replace(/^\/playground\//, '');
    const file = path.join(root, relative);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD' }).end();
      return;
    }
    if (!url.pathname.startsWith('/playground/') || !file.startsWith(root + path.sep) ||
        (request.method !== 'GET' && request.method !== 'HEAD') || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404, headers).end();
      return;
    }
    const bytes = fs.readFileSync(file);
    response.writeHead(200, { ...headers, 'Content-Type': mimeOf(file), 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once('error', reject);
  server.listen(port, host, () => resolve(server));
  return promise;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'titan-bundle': { type: 'string' }, 'titan-revision': { type: 'string' }, 'wasm-opt': { type: 'string' },
      'wasi-sdk': { type: 'string' }, out: { type: 'string' }, 'site-manifest': { type: 'string' },
      measure: { type: 'boolean' }, dir: { type: 'string' }, port: { type: 'string' },
    },
  });
  if (positionals[0] === 'serve') {
    if (!values.dir) fail('serve needs --dir <staged-dir>');
    const port = Number(values.port ?? 4174);
    await serveAssets(values.dir, port);
    console.log(`serving ${path.resolve(values.dir)} at http://127.0.0.1:${port}/playground/`);
  } else if (positionals.length === 0) {
    await pack(values);
  } else {
    fail(`unknown command ${positionals[0]}`);
  }
}
