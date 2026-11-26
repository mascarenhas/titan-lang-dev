// The engine's asset manager: every manifest file is fetched once from the
// versioned base, checked against its manifest size and SHA-256 before
// anything trusts, persists, compiles or imports it, and kept in the
// `titan-playground-v1-<hash>` Cache Storage bucket for later visits. When
// Cache Storage is unavailable, or fails later, assets last for the session
// and a `storage` progress event says so; network and integrity failures
// still fail the request.

import type { PlaygroundAsset, PlaygroundManifest, Progress } from '../types.ts';
import type { AssetSource } from './toolchain.ts';

const CACHE_PREFIX = 'titan-playground-v1-';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Recomputes the manifest version hash exactly as the packer defines it. */
export async function manifestHash(manifest: PlaygroundManifest): Promise<string> {
  const assets = manifest.assets.map(({ path, tier, bytes, sha256, mime }) => ({ path, tier, bytes, sha256, mime }));
  const canonical = JSON.stringify({ schema: 1, titanRevision: manifest.titanRevision, profile: 'validation', assets });
  return sha256Hex(new TextEncoder().encode(canonical));
}

export class AssetManager implements AssetSource {
  readonly manifestHash: string;
  private persistent: boolean | null = null;
  private readonly rows = new Map<string, PlaygroundAsset>();
  private readonly payloads = new Map<string, Promise<Uint8Array>>();
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();
  private cache: Promise<Cache | null>;
  private readonly base: string;
  private readonly onProgress: (event: Progress) => void;

  constructor(manifest: PlaygroundManifest, base: string, onProgress: (event: Progress) => void) {
    this.manifestHash = manifest.hash;
    this.base = base;
    this.onProgress = onProgress;
    for (const row of manifest.assets) this.rows.set(row.path, row);
    this.cache = this.openCache();
  }

  private storage(persistent: boolean): void {
    if (this.persistent === persistent || this.persistent === false) return;
    this.persistent = persistent;
    this.onProgress({ event: 'storage', persistent });
  }

  private async openCache(): Promise<Cache | null> {
    try {
      const name = CACHE_PREFIX + this.manifestHash;
      // Older versions' buckets are ours to drop; the current one is kept.
      for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== name) await caches.delete(key);
      const cache = await caches.open(name);
      this.storage(true);
      return cache;
    } catch {
      this.storage(false);
      return null;
    }
  }

  /** A Cache Storage operation whose failure only ends persistence. */
  private async cached<T>(operation: (cache: Cache) => Promise<T>): Promise<T | undefined> {
    const cache = await this.cache;
    if (!cache || this.persistent === false) return undefined;
    try {
      return await operation(cache);
    } catch {
      this.storage(false);
      return undefined;
    }
  }

  url(path: string): string {
    return new URL(`${this.manifestHash}/${path}`, this.base).href;
  }

  private row(path: string): PlaygroundAsset {
    const row = this.rows.get(path);
    if (!row) throw new Error(`playground asset ${path} is not in the manifest`);
    return row;
  }

  private async verify(row: PlaygroundAsset, bytes: Uint8Array): Promise<boolean> {
    return bytes.length === row.bytes && await sha256Hex(bytes) === row.sha256;
  }

  private async load(row: PlaygroundAsset): Promise<Uint8Array> {
    const url = this.url(row.path);
    const stored = await this.cached(async cache => {
      const response = await cache.match(url);
      return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
    });
    if (stored) {
      if (await this.verify(row, stored)) {
        this.onProgress({ event: 'asset', tier: row.tier, path: row.path, loaded: row.bytes, total: row.bytes, cached: true });
        return stored;
      }
      await this.cached(cache => cache.delete(url));
    }
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok || !response.body) throw new Error(`${row.path}: request failed (${response.status})`);
    const bytes = new Uint8Array(row.bytes);
    let loaded = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > row.bytes) {
        await reader.cancel();
        throw new Error(`${row.path}: larger than its manifest size`);
      }
      bytes.set(value, loaded);
      loaded += value.length;
      this.onProgress({ event: 'asset', tier: row.tier, path: row.path, loaded, total: row.bytes, cached: false });
    }
    if (!await this.verify(row, bytes.subarray(0, loaded))) throw new Error(`${row.path}: digest mismatch`);
    await this.cached(cache => cache.put(url, new Response(bytes.slice(), { headers: { 'Content-Type': row.mime } })));
    return bytes;
  }

  bytes(path: string): Promise<Uint8Array> {
    let payload = this.payloads.get(path);
    if (!payload) {
      payload = this.load(this.row(path));
      // A failure is not remembered: the next request retries.
      payload.catch(() => this.payloads.delete(path));
      this.payloads.set(path, payload);
    }
    return payload;
  }

  /** Compiles a verified `.wasm`; only the module, not its bytes, stays in memory. */
  wasmModule(path: string): Promise<WebAssembly.Module> {
    let module = this.modules.get(path);
    if (!module) {
      const row = this.row(path);
      module = this.load(row).then(bytes => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>));
      module.catch(() => this.modules.delete(path));
      this.modules.set(path, module);
    }
    return module;
  }

  /** Imports a verified ES module asset; its versioned URL exists only at run time. */
  async importModule(path: string): Promise<Record<string, unknown>> {
    const row = this.row(path);
    const url = URL.createObjectURL(new Blob([await this.bytes(path) as Uint8Array<ArrayBuffer>], { type: row.mime }));
    try {
      return await import(/* @vite-ignore */ url) as Record<string, unknown>;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Drops the playground's own Cache Storage buckets and the in-memory copies. */
  async clear(): Promise<void> {
    this.payloads.clear();
    this.modules.clear();
    try {
      for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX)) await caches.delete(key);
    } catch {
      this.storage(false);
    }
    this.cache = this.openCache();
  }
}
