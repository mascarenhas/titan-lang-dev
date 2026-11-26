// Project file-name rules, enforced on create, rename, share decode and zip.

import type { Files } from '../types.ts';

export const MAX_PROJECT_FILES = 128;
export const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 255;
// A Set, not a Record: a Record lookup of "__proto__" would read the prototype.
const MAGIC_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Why `path` cannot name a project file next to `existing` paths, or null
 * when it can. Paths are relative POSIX paths outside the reserved `titan/`
 * library mount.
 */
export function pathProblem(path: string, existing: Iterable<string> = []): string | null {
  if (path.length === 0) return 'A file name cannot be empty.';
  if (path.length > MAX_PATH_LENGTH) return `A file path can have at most ${MAX_PATH_LENGTH} characters.`;
  if (/[\x00-\x1f\x7f]/.test(path)) return 'A file path cannot contain control characters.';
  if (path.includes('\\')) return 'Use / to separate folders, not \\.';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return 'A file path cannot start with a URL scheme.';
  const segments = path.split('/');
  if (segments.some(segment => segment === '')) return 'A file path cannot start or end with /, or contain //.';
  if (segments.some(segment => segment === '.' || segment === '..')) return 'A file path cannot contain . or .. folders.';
  const magic = segments.find(segment => MAGIC_SEGMENTS.has(segment));
  if (magic) return `"${magic}" is a reserved name.`;
  if (segments[0] === 'titan') return 'titan/ is the read-only standard library.';
  for (const other of existing) {
    if (other === path) return `${path} already exists.`;
    if (other.startsWith(path + '/')) return `${path} is already a folder.`;
    if (path.startsWith(other + '/')) return `${other} is a file, not a folder.`;
  }
  return null;
}

/** Why a whole file map is not a valid project, or null when it is. */
export function projectProblem(files: Files): string | null {
  const paths = Object.keys(files);
  if (paths.length === 0) return 'A project needs at least one file.';
  if (paths.length > MAX_PROJECT_FILES) return `A project can have at most ${MAX_PROJECT_FILES} files.`;
  let bytes = 0;
  const seen: string[] = [];
  for (const path of paths) {
    const text = files[path];
    if (typeof text !== 'string') return `${path} is not a text file.`;
    const problem = pathProblem(path, seen);
    if (problem) return problem;
    seen.push(path);
    bytes += new TextEncoder().encode(text).length;
  }
  if (bytes > MAX_PROJECT_BYTES) return `A project can hold at most ${MAX_PROJECT_BYTES / 1024 / 1024} MiB of text.`;
  if (!('main.titan' in files)) return 'A project needs a root main.titan.';
  return null;
}
