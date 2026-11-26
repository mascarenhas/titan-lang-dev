// Walks a WebAssembly binary's top-level sections for the Inspect pane.
// Custom sections report their own names (`name`, `sourceMappingURL`, ...).

import type { Section } from '../types.ts';

const KNOWN = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export',
  'start', 'element', 'code', 'data', 'datacount', 'tag'];

function leb(bytes: Uint8Array, at: { offset: number }): number {
  let result = 0, shift = 0;
  for (;;) {
    if (at.offset >= bytes.length || shift > 28) throw new Error('invalid WebAssembly LEB128');
    const byte = bytes[at.offset++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return result;
    shift += 7;
  }
}

/** Every section in file order with its payload size in bytes. */
export function wasmSections(bytes: Uint8Array): Section[] {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d ||
      bytes[4] !== 1 || bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new Error('not a WebAssembly 1.0 binary');
  }
  const sections: Section[] = [];
  const at = { offset: 8 };
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  while (at.offset < bytes.length) {
    const id = bytes[at.offset++];
    const size = leb(bytes, at);
    const start = at.offset, end = start + size;
    if (end > bytes.length) throw new Error('truncated WebAssembly section');
    let name = KNOWN[id];
    if (name === undefined) throw new Error(`unknown WebAssembly section id ${id}`);
    if (id === 0) {
      const length = leb(bytes, at);
      if (at.offset + length > end) throw new Error('invalid WebAssembly custom section name');
      name = utf8.decode(bytes.subarray(at.offset, at.offset + length));
    }
    sections.push({ name, bytes: size });
    at.offset = end;
  }
  return sections;
}
