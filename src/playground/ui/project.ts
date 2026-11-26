// The editable project: files, preview mode, revision, dirtiness and
// browser-local persistence of the user's own edits.
import { projectProblem } from "../engine";
import type { ExampleDefinition, Files, PreviewMode, Project } from "../types";

export const ENTRY = "main.titan";
export const BINDINGS = "bindings.js";
export const BINDINGS_TEMPLATE = "export default function createBindings(host) {\n  return {};\n}\n";

const STORAGE_KEY = "titan-playground-project";

// One revision sequence for the page's lifetime: the compiler Worker outlives
// project replacements, so every snapshot it sees must be newer than the last.
let lastRevision = 0;
const nextRevision = () => ++lastRevision;

export type Origin = { kind: "example"; slug: string } | { kind: "share" } | { kind: "saved" };

interface Saved {
  v: 1;
  files: Files;
  previewMode: PreviewMode;
  origin: Origin;
  changed: boolean;
  dirty: string[];
}

function isFiles(value: unknown): value is Files {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((text) => typeof text === "string") &&
    projectProblem(value as Files) === null
  );
}

function isPreviewMode(value: unknown): value is PreviewMode {
  return value === "console" || value === "canvas2d" || value === "dom" || value === "three";
}

export class ProjectStore {
  files: Files;
  previewMode: PreviewMode;
  origin: Origin;
  /** Snapshot identity, unique in this page; the compiler echoes it so late replies can be discarded. */
  revision = nextRevision();
  /** Whether anything changed since the project came from its example or share link. */
  changed = false;
  /** Files whose text changed since then. */
  readonly dirty = new Set<string>();

  private constructor(files: Files, previewMode: PreviewMode, origin: Origin) {
    this.files = { ...files };
    this.previewMode = previewMode;
    this.origin = origin;
  }

  static fromExample(example: ExampleDefinition): ProjectStore {
    return new ProjectStore(example.files, example.previewMode, { kind: "example", slug: example.slug });
  }

  static fromShare(project: Project): ProjectStore {
    return new ProjectStore(project.files, project.previewMode, { kind: "share" });
  }

  /** The project saved by an earlier edit in this browser, if any. */
  static restore(): ProjectStore | null {
    let saved: Partial<Saved>;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? {};
    } catch {
      return null;
    }
    if (saved.v !== 1 || !isFiles(saved.files) || !isPreviewMode(saved.previewMode)) return null;
    const store = new ProjectStore(saved.files, saved.previewMode, saved.origin ?? { kind: "saved" });
    store.changed = saved.changed ?? true;
    for (const path of saved.dirty ?? []) if (Object.hasOwn(store.files, path)) store.dirty.add(path);
    return store;
  }

  /** Project files in display order: the entry first, then folders, then bindings. */
  paths(): string[] {
    const rank = (path: string) => (path === ENTRY ? 0 : path === BINDINGS ? 2 : 1);
    return Object.keys(this.files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /** Whether a run executes in the opaque preview frame rather than the console worker. */
  usesFrame(): boolean {
    return this.previewMode !== "console" || BINDINGS in this.files;
  }

  project(): Project {
    return { v: 1, files: { ...this.files }, previewMode: this.previewMode };
  }

  /** The `.titan` sources the compiler needs. */
  titanFiles(): Files {
    const titan: Files = {};
    for (const [path, text] of Object.entries(this.files)) if (path.endsWith(".titan")) titan[path] = text;
    return titan;
  }

  edit(path: string, text: string): void {
    if (this.files[path] === text) return;
    this.files[path] = text;
    this.dirty.add(path);
    this.touch();
  }

  add(path: string, text: string): void {
    this.files[path] = text;
    this.dirty.add(path);
    this.touch();
  }

  remove(path: string): void {
    delete this.files[path];
    this.dirty.delete(path);
    this.touch();
  }

  rename(from: string, to: string): void {
    this.files[to] = this.files[from];
    delete this.files[from];
    this.dirty.delete(from);
    this.dirty.add(to);
    this.touch();
  }

  private touch(): void {
    this.revision = nextRevision();
    this.changed = true;
    this.save();
  }

  save(): void {
    const saved: Saved = {
      v: 1,
      files: this.files,
      previewMode: this.previewMode,
      origin: this.origin,
      changed: this.changed,
      dirty: [...this.dirty],
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Storage may be full or disabled; the session keeps working without it.
    }
  }
}
