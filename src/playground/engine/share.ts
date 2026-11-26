// `#v1=` share links: base64url (unpadded) over deflate-raw of the UTF-8 JSON
// `{v:1,files,previewMode}`. Encoding and decoding apply the same project
// rules and the same serialized-size budget, so every link this encoder
// produces decodes; decoding bounds the fragment and the inflated stream
// before building strings.

import type { PreviewMode, Project } from '../types.ts';
import { projectProblem } from './paths.ts';

/** Share links above this many compressed bytes deserve a download instead. */
export const SHARE_WARN_BYTES = 16 * 1024;
const PREFIX = '#v1=';
// The JSON of a valid project (2 MiB of text) plus escaping headroom.
const MAX_SHARE_JSON_BYTES = 4 * 1024 * 1024;
// Deflate never expands by more than a few bytes per 16 KiB block.
const MAX_FRAGMENT_CHARS = PREFIX.length + Math.ceil((MAX_SHARE_JSON_BYTES * 1.01 + 1024) * 4 / 3);
const TOO_LARGE = 'The project is too large for a share link; download it instead.';
const PREVIEW_MODES: readonly PreviewMode[] = ['console', 'canvas2d', 'dom', 'three'];

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('The share link is not valid base64url.');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

class TooLarge extends Error {}

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new TooLarge(TOO_LARGE);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function validate(files: Record<string, string>, previewMode: unknown): PreviewMode {
  const problem = projectProblem(files);
  if (problem) throw new Error(problem);
  const mode = PREVIEW_MODES.find(candidate => candidate === previewMode);
  if (!mode) throw new Error('The project names an unknown preview mode.');
  return mode;
}

export async function encodeShare(project: Project): Promise<string> {
  validate(project.files, project.previewMode);
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, files: project.files, previewMode: project.previewMode }));
  if (json.length > MAX_SHARE_JSON_BYTES) throw new Error(TOO_LARGE);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const fragment = PREFIX + base64url(await collect(stream, MAX_SHARE_JSON_BYTES * 2));
  if (fragment.length > MAX_FRAGMENT_CHARS) throw new Error(TOO_LARGE);
  return fragment;
}

export async function decodeShare(fragment: string): Promise<Project> {
  const hash = fragment.startsWith('#') ? fragment : `#${fragment}`;
  if (!hash.startsWith(PREFIX)) throw new Error('This is not a Titan playground share link.');
  if (hash.length > MAX_FRAGMENT_CHARS) throw new Error(TOO_LARGE);
  const compressed = unbase64url(hash.slice(PREFIX.length));
  let json: unknown;
  try {
    const stream = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await collect(stream, MAX_SHARE_JSON_BYTES)));
  } catch (error) {
    if (error instanceof TooLarge) throw error;
    throw new Error('The share link is damaged.');
  }
  if (!json || typeof json !== 'object' || !('v' in json) || json.v !== 1 || !('files' in json) ||
      !json.files || typeof json.files !== 'object' || Array.isArray(json.files)) {
    throw new Error('The share link does not hold a version 1 project.');
  }
  // Rebuild the map so no inherited or magic key survives the parse.
  const files: Record<string, string> = Object.create(null);
  for (const [path, text] of Object.entries(json.files)) {
    if (typeof text !== 'string') throw new Error(`${path} is not a text file.`);
    files[path] = text;
  }
  // Links from before preview modes existed run as console projects.
  const previewMode = validate(files, 'previewMode' in json ? json.previewMode : 'console');
  return { v: 1, files: { ...files }, previewMode };
}
