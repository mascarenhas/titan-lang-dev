// The playground build pipeline, shared verbatim by the compiler Worker and
// `scripts/verify-examples.mjs`: titanc.wasm emits C, YoWASP compiles each
// unit with the driver's packed `-cc1` expansion and links with the packed
// `wasm-ld` command, Binaryen 133 `wasm-opt` optimizes and instruments stack
// checks, and titanc.wasm turns the DWARF line tables into the trace table and
// embeds the loader. No DOM, no network: assets arrive through `AssetSource`.

import type { Build, Completion, Cursor, Diagnostic, Emit, Files, Hover, Image, Stage } from '../types.ts';
import { tarTree, type Tree } from './tar.ts';
import { wasmSections } from './wasm-sections.ts';

/** Verified manifest assets, however the host stores and loads them. */
export interface AssetSource {
  readonly manifestHash: string;
  bytes(path: string): Promise<Uint8Array>;
  wasmModule(path: string): Promise<WebAssembly.Module>;
  importModule(path: string): Promise<Record<string, unknown>>;
}

/** The titanc.mjs adapter (CONTRACTS.md §4). */
export interface Compiler {
  check(files: Files): Diagnostic[];
  hover(files: Files, at: Cursor): Hover | null;
  complete(files: Files, at: Cursor): Completion | null;
  emit_c(files: Files, identity: string): Emit;
  build_trace(input: { linked: Uint8Array; identity: string; factory: string; loader: string }): Image;
  dispose(): void;
}

type OpenCompiler = (input: {
  wasm: Uint8Array; catalog: Uint8Array; analysisTarget: Uint8Array; absentModules: Uint8Array;
}) => Promise<Compiler>;

/** Every asset `openCompiler` loads; `stdlib-sources.json` loads lazily for navigation. */
export const TIER1_PATHS: readonly string[] = ['titanc.mjs', 'titanc.wasm', 'stdlib_catalog.bin', 'analysis-target',
  'absent-modules'];

/** A failure of the C toolchain itself, never a Titan language error. */
export class ToolchainError extends Error {
  override name = 'ToolchainError';
}

/** Titan diagnostics that stopped C emission. */
export class DiagnosticsError extends Error {
  override name = 'DiagnosticsError';
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.find(d => d.severity === 'error')?.message ?? 'the project has errors');
    this.diagnostics = diagnostics;
  }
}

export async function openCompiler(assets: AssetSource): Promise<Compiler> {
  const [adapter, wasm, catalog, analysisTarget, absentModules] = await Promise.all([
    assets.importModule('titanc.mjs'),
    ...TIER1_PATHS.slice(1).map(path => assets.bytes(path)),
  ]) as [Record<string, unknown>, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  // titanc.mjs is the matched adapter of titanc.wasm; its signature is the contract.
  const open: unknown = adapter.openCompiler;
  if (typeof open !== 'function') throw new ToolchainError('titanc.mjs does not export openCompiler');
  return (open as OpenCompiler)({ wasm, catalog, analysisTarget, absentModules });
}

/** Only `.titan` sources reach the compiler. */
export function titanSources(files: Files): Files {
  const sources: Files = {};
  for (const [path, text] of Object.entries(files)) if (path.endsWith('.titan')) sources[path] = text;
  return sources;
}

const utf8 = new TextEncoder();

/** SHA-256 over length-delimited UTF-8 fields, so no field can bleed into the next. */
async function recipeDigest(fields: string[]): Promise<string> {
  const parts = fields.map(field => utf8.encode(field));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length + 12, 0));
  let offset = 0;
  for (const part of parts) {
    const length = utf8.encode(`${part.length}:`);
    out.set(length, offset);
    out.set(part, offset + length.length);
    offset += length.length + part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(0, offset)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Bump when this file changes how sources become an image or an object.
const IMAGE_RECIPE = 'titan-playground-image/1';
const OBJECT_RECIPE = 'titan-playground-object/1';

/**
 * The image identity: the manifest hash (SDK, tools, packed flags), this
 * pipeline's recipe version, and every `.titan` path with its exact text.
 */
export function imageIdentity(manifestHash: string, files: Files): Promise<string> {
  const sources = titanSources(files);
  const paths = Object.keys(sources).sort();
  return recipeDigest([IMAGE_RECIPE, manifestHash, ...paths.flatMap(path => [path, sources[path]])]);
}

interface Recipe {
  cc1: string[];
  wasmLd: string[];
  wasmOpt: string[];
  headers: { mount: string; roots: string[] };
  archives: { mount: string; names: string[] };
  placeholders: {
    unitSource: string; unitDirectory: string; unitObject: string; unitMainFile: string;
    linkOutput: string; linkEntry: string; linkUnits: string;
  };
}

interface Llvm {
  provideResources(resources: { modules(): Promise<Record<string, WebAssembly.Module>>; archive(): Promise<ArrayBuffer> }): void;
  runLLVM(args: string[], files: Tree | Record<string, unknown>, options: {
    stdout?: (bytes: Uint8Array | null) => void; stderr?: (bytes: Uint8Array | null) => void;
    decodeASCII?: boolean; fetchProgress?: () => void;
  }): Promise<Record<string, unknown>>;
}

interface EmscriptenModule {
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array; unlink(path: string): void };
  callMain(args: string[]): number;
}

type WasmOptFactory = (options: Record<string, unknown>) => Promise<EmscriptenModule>;

const LLVM_CORE_MODULES = ['llvm.core.wasm', 'llvm.core2.wasm', 'llvm.core3.wasm', 'llvm.core4.wasm'];
const SDK_ARCHIVES = ['titan.a', 'libtitan-lpeglabel.a', 'libtitan.a', 'liblua.a'];

/** Every asset `Toolchain.open` loads; licenses, link-plan.json and the Three graph load lazily or never. */
export const TIER2_PATHS: readonly string[] = ['llvm.mjs', ...LLVM_CORE_MODULES, 'llvm-resources-c99.tar',
  'llvm-recipe.json', 'wasm-opt.mjs', 'wasm-opt.wasm', 'headers.tar', 'titan-wasm-factory.mjs', 'titan-browser.mjs',
  ...SDK_ARCHIVES];

function dirname(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? '' : key.slice(0, slash);
}

function join(directory: string, name: string): string | null {
  const parts = directory ? directory.split('/') : [];
  for (const part of name.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** Generated files as the nested tree runLLVM mounts. */
function filesTree(files: Files): Tree {
  const root: Record<string, unknown> = Object.create(null);
  for (const [key, text] of Object.entries(files)) {
    const parts = key.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = (dir[part] ??= Object.create(null)) as Record<string, unknown>;
    dir[parts[parts.length - 1]] = utf8.encode(text);
  }
  return root as Tree;
}

/**
 * The generated headers a unit can reach through quoted or angle includes,
 * resolved like the compiler: the including file's directory, then the
 * unit's own directory (its include root). SDK headers are fixed by the
 * manifest hash and are not part of the closure.
 */
export function headerClosure(files: Files, unit: string): string[] {
  const seen = new Set<string>();
  const pending = [unit];
  const include = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]/gm;
  while (pending.length > 0) {
    const key = pending.pop() as string;
    for (const match of files[key].matchAll(include)) {
      const directories = match[1] === '"' ? [dirname(key), dirname(unit)] : [dirname(unit)];
      for (const directory of directories) {
        const target = join(directory, match[2]);
        if (target !== null && target in files) {
          if (!seen.has(target)) {
            seen.add(target);
            pending.push(target);
          }
          break;
        }
      }
    }
  }
  seen.delete(unit);
  return [...seen].sort();
}

function collect(): { sink: (bytes: Uint8Array | null) => void; text(): string } {
  const decoder = new TextDecoder();
  let out = '';
  return {
    sink: bytes => { if (bytes) out += decoder.decode(bytes, { stream: true }); },
    text: () => out + decoder.decode(),
  };
}

interface ToolchainParts {
  llvm: Llvm;
  wasmOpt: { factory: WasmOptFactory; module: WebAssembly.Module };
  recipe: Recipe;
  headers: Tree;
  archives: Tree;
}

/** The Tier 2 tools, loaded once and kept warm across builds and Stop. */
export class Toolchain {
  private readonly parts: ToolchainParts;
  /** Text of the SDK's `titan-wasm-factory.mjs` and `titan-browser.mjs`, for embedding. */
  readonly factory: string;
  readonly loader: string;

  private constructor(parts: ToolchainParts, factory: string, loader: string) {
    this.parts = parts;
    this.factory = factory;
    this.loader = loader;
  }

  static async open(assets: AssetSource): Promise<Toolchain> {
    const text = async (path: string) => new TextDecoder().decode(await assets.bytes(path));
    // A packed, digest-verified asset written by scripts/build-playground-assets.mjs.
    const recipe = JSON.parse(await text('llvm-recipe.json')) as Recipe;
    if (recipe.archives.names.join() !== SDK_ARCHIVES.join()) throw new ToolchainError('llvm-recipe.json names other SDK archives');
    const [llvmExports, wasmOptExports, wasmOptModule, headers, factory, loader, archives] = await Promise.all([
      assets.importModule('llvm.mjs'),
      assets.importModule('wasm-opt.mjs'),
      assets.wasmModule('wasm-opt.wasm'),
      assets.bytes('headers.tar'),
      text('titan-wasm-factory.mjs'),
      text('titan-browser.mjs'),
      Promise.all(recipe.archives.names.map(name => assets.bytes(name))),
    ]);
    const { runLLVM, provideResources } = llvmExports;
    const createWasmOpt = wasmOptExports.default;
    if (typeof runLLVM !== 'function' || typeof provideResources !== 'function') {
      throw new ToolchainError('llvm.mjs is not the packed YoWASP bundle');
    }
    if (typeof createWasmOpt !== 'function') throw new ToolchainError('wasm-opt.mjs exports no module factory');
    // The entry points of the two packed modules, checked above.
    const llvm = { runLLVM, provideResources } as Llvm;
    const archiveTree: Tree = Object.create(null);
    recipe.archives.names.forEach((name, index) => { archiveTree[name] = archives[index]; });
    llvm.provideResources({
      modules: async () => Object.fromEntries(await Promise.all(LLVM_CORE_MODULES.map(async name =>
        [name, await assets.wasmModule(name)] as const))),
      // The tar reader may keep views into this buffer; hand it a private copy.
      archive: async () => (await assets.bytes('llvm-resources-c99.tar')).slice().buffer,
    });
    // An argument-less run only stages the toolchain resources.
    await llvm.runLLVM(null as unknown as string[], {}, { fetchProgress: () => {} });
    return new Toolchain({ llvm, wasmOpt: { factory: createWasmOpt as WasmOptFactory, module: wasmOptModule }, recipe,
      headers: tarTree(headers), archives: archiveTree }, factory, loader);
  }

  private async run(tool: string, args: string[], files: Record<string, unknown>): Promise<Record<string, unknown>> {
    const log = collect();
    try {
      return await this.parts.llvm.runLLVM(args, files, { stdout: log.sink, stderr: log.sink, decodeASCII: false });
    } catch (error) {
      const output = log.text().trim();
      throw new ToolchainError(`${tool} failed${output ? `:\n${output}` : ` (${String(error)})`}`);
    }
  }

  private mount(root: string, tree: Tree): Record<string, unknown> {
    const parts = root.split('/').filter(Boolean);
    let node: Record<string, unknown> = tree;
    for (const part of parts.reverse()) node = { [part]: node };
    return node;
  }

  /** Compiles generated unit `key` of `files` to a relocatable object. */
  async compile(files: Files, key: string): Promise<Uint8Array> {
    const { recipe, headers } = this.parts;
    const p = recipe.placeholders;
    const directory = dirname(key);
    const argv = recipe.cc1.map(arg =>
      arg === p.unitSource ? `/work/${key}` :
      arg === p.unitDirectory ? (directory ? `/work/${directory}` : '/work') :
      arg === p.unitObject ? '/unit.o' :
      arg === p.unitMainFile ? key.slice(directory ? directory.length + 1 : 0) : arg);
    const tree = { work: filesTree(files), ...this.mount(recipe.headers.mount, headers) };
    const result = await this.run('clang', argv, tree);
    const object = result['unit.o'];
    if (!(object instanceof Uint8Array)) throw new ToolchainError(`clang produced no object for ${key}`);
    return object;
  }

  /** Links the entry and unit objects with the SDK archives. */
  async link(entry: Uint8Array, units: Uint8Array[]): Promise<Uint8Array> {
    const { recipe, archives } = this.parts;
    const p = recipe.placeholders;
    const objects: Tree = Object.create(null);
    units.forEach((object, index) => { objects[`${index}.o`] = object; });
    const argv = recipe.wasmLd.flatMap(arg =>
      arg === p.linkOutput ? ['/image.wasm'] :
      arg === p.linkEntry ? ['/entry.o'] :
      arg === p.linkUnits ? units.map((_, index) => `/objects/${index}.o`) : [arg]);
    const tree = { 'entry.o': entry, objects, ...this.mount(recipe.archives.mount, archives) };
    const result = await this.run('wasm-ld', argv, tree);
    const image = result['image.wasm'];
    if (!(image instanceof Uint8Array)) throw new ToolchainError('wasm-ld produced no image');
    return image;
  }

  /** Binaryen `wasm-opt` with the image's optimizer flags, in private MEMFS. */
  async optimize(linked: Uint8Array): Promise<Uint8Array> {
    const output: string[] = [];
    const { factory, module } = this.parts.wasmOpt;
    let instance: EmscriptenModule;
    try {
      instance = await factory({
        noInitialRun: true,
        print: (line: string) => output.push(line),
        printErr: (line: string) => output.push(line),
        // Synchronous on purpose: Emscripten calls this hook inside a Promise
        // executor, so a failed instantiation rejects the factory's promise.
        instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
          done(new WebAssembly.Instance(module, imports));
          return {};
        },
      });
    } catch (error) {
      throw new ToolchainError(`wasm-opt failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    instance.FS.writeFile('/linked.wasm', linked);
    let status: number;
    try {
      status = instance.callMain(['/linked.wasm', ...this.parts.recipe.wasmOpt, '-o', '/image.wasm']);
    } catch (error) {
      // Emscripten reports exit(N) from main as a thrown ExitStatus.
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
        status = error.status;
      } else {
        status = -1;
        output.push(String(error));
      }
    }
    if (status !== 0) throw new ToolchainError(`wasm-opt failed (status ${status}):\n${output.join('\n')}`);
    return instance.FS.readFile('/image.wasm');
  }
}

/** Keeps recent unit objects keyed by generated TU, header closure and recipe. */
class ObjectCache {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly capacity = 96;

  get(key: string): Uint8Array | undefined {
    const object = this.objects.get(key);
    if (object) {
      this.objects.delete(key);
      this.objects.set(key, object);
    }
    return object;
  }

  set(key: string, object: Uint8Array): void {
    this.objects.delete(key);
    this.objects.set(key, object);
    while (this.objects.size > this.capacity) this.objects.delete(this.objects.keys().next().value as string);
  }

  clear(): void {
    this.objects.clear();
  }
}

export type StageListener = (stage: Stage, state: 'start' | 'end', ms?: number) => void;

/** Turns a project snapshot into a deployable image, reusing unchanged objects. */
export class Builder {
  private readonly objects = new ObjectCache();
  private readonly compiler: Compiler;
  /** The last successful build; an unchanged identity (e.g. a bindings-only edit) returns it as is. */
  private last: { identity: string; units: string[]; build: Build } | null = null;
  readonly manifestHash: string;

  constructor(compiler: Compiler, manifestHash: string) {
    this.compiler = compiler;
    this.manifestHash = manifestHash;
  }

  async emit(files: Files): Promise<Emit> {
    return this.compiler.emit_c(titanSources(files), await imageIdentity(this.manifestHash, files));
  }

  clearObjects(): void {
    this.objects.clear();
    this.last = null;
  }

  private async object(toolchain: Toolchain, emit: Emit, key: string, reused: string[]): Promise<Uint8Array> {
    const closure = headerClosure(emit.files, key);
    const cacheKey = await recipeDigest([OBJECT_RECIPE, this.manifestHash, key, emit.files[key],
      ...closure.flatMap(header => [header, emit.files[header]])]);
    const cached = this.objects.get(cacheKey);
    if (cached) {
      reused.push(key);
      return cached;
    }
    const object = await toolchain.compile(emit.files, key);
    this.objects.set(cacheKey, object);
    return object;
  }

  async build(files: Files, toolchain: Toolchain, onStage: StageListener = () => {}): Promise<Build> {
    const timed = async <T>(stage: Stage, work: () => Promise<T>): Promise<[T, number]> => {
      onStage(stage, 'start');
      const started = performance.now();
      const value = await work();
      const ms = performance.now() - started;
      onStage(stage, 'end', ms);
      return [value, ms];
    };
    const identity = await imageIdentity(this.manifestHash, files);
    if (this.last?.identity === identity) {
      return { ...this.last.build, reused: this.last.units, ms: { check: 0, compile: 0, link: 0 } };
    }
    const [emit, check] = await timed('check', async () => {
      const emitted = this.compiler.emit_c(titanSources(files), identity);
      if (emitted.diagnostics.some(d => d.severity === 'error')) throw new DiagnosticsError(emitted.diagnostics);
      return emitted;
    });
    const reused: string[] = [];
    const [[entry, units], compile] = await timed('compile', async () => {
      const objects: Uint8Array[] = [];
      for (const key of emit.units) objects.push(await this.object(toolchain, emit, key, reused));
      return [await this.object(toolchain, emit, emit.entry, []), objects] as const;
    });
    const [image, link] = await timed('link', async () => {
      const optimized = await toolchain.optimize(await toolchain.link(entry, units));
      return this.compiler.build_trace({ linked: optimized, identity, factory: toolchain.factory, loader: toolchain.loader });
    });
    const build = { image, sections: wasmSections(image.wasm), reused, ms: { check, compile, link } };
    this.last = { identity, units: emit.units, build };
    return build;
  }
}
