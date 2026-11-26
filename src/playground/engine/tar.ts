// Deterministic USTAR reading and writing for the playground's toolchain
// archives. Names are relative, ASCII, at most 100 bytes, and directories
// carry no trailing slash with parents before children: YoWASP's
// `unpackTarFilesystem` reads only the 100-byte name field and indexes the
// parent directory of every entry, so it needs exactly this shape.

/** A YoWASP virtual filesystem tree. */
export interface Tree {
  [name: string]: Tree | Uint8Array;
}

export interface TarEntry {
  name: string;
  type: 'file' | 'directory';
  data: Uint8Array;
}

const BLOCK = 512;
const ascii = new TextDecoder('latin1');

function field(header: Uint8Array, offset: number, size: number): string {
  const bytes = header.subarray(offset, offset + size);
  const end = bytes.indexOf(0);
  return ascii.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(header: Uint8Array, offset: number, size: number): number {
  const text = field(header, offset, size).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('invalid tar number field');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function checkName(name: string): void {
  if (name === '' || name.startsWith('/') || name.endsWith('/') ||
      name.split('/').some(part => part === '' || part === '.' || part === '..') ||
      !/^[\x21-\x7e]+$/.test(name)) {
    throw new Error(`invalid tar entry name ${JSON.stringify(name)}`);
  }
}

/** Reads regular files and directories; any other entry kind is refused. */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(header, 148, 8)) throw new Error('tar header checksum mismatch');
    // Only POSIX ustar ("ustar\0") has a name prefix; old GNU headers reuse it.
    const posix = ascii.decode(header.subarray(257, 263)) === 'ustar\0';
    const prefix = posix ? field(header, 345, 155) : '';
    const name = (prefix ? prefix + '/' : '') + field(header, 0, 100).replace(/\/$/, '');
    checkName(name);
    const flag = String.fromCharCode(header[156]);
    const size = octal(header, 124, 12);
    const start = offset + BLOCK;
    if (start + size > bytes.length) throw new Error('truncated tar entry');
    if (flag === '5') entries.push({ name, type: 'directory', data: new Uint8Array(0) });
    else if (flag === '0' || flag === '\0') entries.push({ name, type: 'file', data: bytes.subarray(start, start + size) });
    else throw new Error(`unsupported tar entry type ${JSON.stringify(flag)} for ${name}`);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Builds the nested tree `runLLVM` mounts; file bytes are not copied. */
export function tarTree(bytes: Uint8Array): Tree {
  const root: Tree = Object.create(null);
  for (const entry of readTar(bytes)) {
    const parts = entry.name.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      const next = dir[part];
      if (next === undefined) dir = dir[part] = Object.create(null);
      else if (next instanceof Uint8Array) throw new Error(`tar entry ${entry.name} is under a file`);
      else dir = next;
    }
    const leaf = parts[parts.length - 1];
    if (entry.type === 'directory') dir[leaf] ??= Object.create(null);
    else dir[leaf] = entry.data;
  }
  return root;
}

function put(header: Uint8Array, offset: number, size: number, text: string): void {
  for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  if (text.length > size) throw new Error('tar field overflow');
}

function putOctal(header: Uint8Array, offset: number, size: number, value: number): void {
  put(header, offset, size, value.toString(8).padStart(size - 1, '0'));
}

/**
 * Writes `files` (relative path → bytes) as a deterministic USTAR archive:
 * every ancestor directory is emitted before its children, entries sort by
 * path components, and owner, mode and time fields are fixed.
 */
export function writeTar(files: Map<string, Uint8Array>): Uint8Array {
  const directories = new Set<string>();
  for (const name of files.keys()) {
    checkName(name);
    if (name.length > 100) throw new Error(`tar entry name longer than 100 bytes: ${name}`);
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  for (const directory of directories) {
    if (files.has(directory)) throw new Error(`tar path ${directory} is both a file and a directory`);
  }
  const compare = (a: string, b: string): number => {
    const x = a.split('/'), y = b.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  };
  const names = [...directories, ...files.keys()].sort(compare);
  let total = 2 * BLOCK;
  for (const name of names) total += BLOCK + Math.ceil((files.get(name)?.length ?? 0) / BLOCK) * BLOCK;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const name of names) {
    const data = files.get(name);
    const header = out.subarray(offset, offset + BLOCK);
    put(header, 0, 100, name);
    putOctal(header, 100, 8, data ? 0o644 : 0o755);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, data?.length ?? 0);
    putOctal(header, 136, 12, 0);
    header[156] = (data ? '0' : '5').charCodeAt(0);
    put(header, 257, 6, 'ustar');
    put(header, 263, 2, '00');
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    offset += BLOCK;
    if (data) {
      out.set(data, offset);
      offset += Math.ceil(data.length / BLOCK) * BLOCK;
    }
  }
  return out;
}
