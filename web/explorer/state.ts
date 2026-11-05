// Per-conversation explorer state: lazily read folder listings, expansion,
// keyboard cursor, the previewed file and Git change marks from Changes.
// Shared actions copy or insert a path and open a file's diff in Changes.
import { backendFor } from "../backends/backend.js";
import { loadedChanges } from "../diff.js";
import { inputEl } from "../dom.js";
import { openPane } from "../panes.js";
import { copyText } from "../tool_details.js";
import { insertTextAtSelection } from "../type_to_compose.js";
import { focusComposerAtEnd } from "../composer.js";

export interface ExplorerEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  mtime: number;
  ignored: boolean;
  symlink: boolean;
  credential: boolean;
}

export interface Listing {
  status: "loading" | "ready" | "error";
  entries: ExplorerEntry[];
  more: number;
  moreExact?: boolean;
  detail?: string;
}

export interface ExplorerTree {
  readonly cid: string;
  root: string | null;
  prefix: string | null;
  listings: Map<string, Listing>;
  expanded: Set<string>;
  cursor: string;
  selected: string | null;
  generation: number;
}

export interface ChangeMark {
  mark: "M" | "U";
  diffPath: string;
}

const MAX_TREES = 12;
const trees = new Map<string, ExplorerTree>();
const listeners = new Set<() => void>();

/** Repaint every explorer view after state changes. */
export function changed(): void {
  for (const listener of listeners) listener();
}

export function onExplorerChange(listener: () => void): void {
  listeners.add(listener);
}

export function offExplorerChange(listener: () => void): void {
  listeners.delete(listener);
}

export function treeFor(cid: string): ExplorerTree {
  let tree = trees.get(cid);
  if (tree) {
    trees.delete(cid);
    trees.set(cid, tree);
    return tree;
  }
  tree = {
    cid,
    root: null,
    prefix: null,
    listings: new Map(),
    expanded: new Set(),
    cursor: "",
    selected: null,
    generation: 0,
  };
  trees.set(cid, tree);
  while (trees.size > MAX_TREES) trees.delete(trees.keys().next().value!);
  return tree;
}

export const joinPath = (dir: string, name: string): string =>
  dir ? `${dir}/${name}` : name;

export const parentPath = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

/** The backend URL of one explorer route for a root-relative path. */
export function treeUrl(
  cid: string,
  route: "" | "/file" | "/raw",
  path: string,
): string {
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/tree${route}?path=${encodeURIComponent(path)}`,
  );
}

async function detailOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    detail?: unknown;
  } | null;
  return typeof body?.detail === "string"
    ? body.detail
    : `Couldn’t read this folder (${response.status}).`;
}

/** Read one folder; a changed root resets the tree to the new directory. */
export async function loadListing(
  tree: ExplorerTree,
  path: string,
): Promise<void> {
  const generation = tree.generation;
  const prior = tree.listings.get(path);
  if (!prior)
    tree.listings.set(path, { status: "loading", entries: [], more: 0 });
  changed();
  let next: Listing;
  let root: string | null = null;
  try {
    const response = await backendFor(tree.cid).api(
      treeUrl(tree.cid, "", path),
      {
        cache: "no-store",
      },
    );
    if (!response.ok) {
      next = {
        status: "error",
        entries: [],
        more: 0,
        detail: await detailOf(response),
      };
    } else {
      const body = (await response.json()) as {
        root: string;
        git_prefix?: string | null;
        entries: ExplorerEntry[];
        more: number;
        more_exact?: boolean;
      };
      root = body.root;
      if (!path) tree.prefix = body.git_prefix ?? null;
      next = {
        status: "ready",
        entries: body.entries,
        more: body.more,
        moreExact: body.more_exact !== false,
      };
    }
  } catch {
    next = {
      status: "error",
      entries: [],
      more: 0,
      detail: "Couldn’t reach the server.",
    };
  }
  if (generation !== tree.generation) return;
  if (root !== null && tree.root !== null && root !== tree.root) {
    resetTree(tree);
    tree.root = root;
    tree.listings.set("", next);
    changed();
    return;
  }
  if (root !== null) tree.root = root;
  tree.listings.set(path, next);
  changed();
}

function resetTree(tree: ExplorerTree): void {
  tree.generation++;
  tree.listings.clear();
  tree.expanded.clear();
  tree.cursor = "";
}

/** Re-read the root and every expanded folder; no filesystem watcher. */
export function refreshTree(tree: ExplorerTree): Promise<unknown> {
  return loadListing(tree, "").then(() =>
    Promise.all(
      [...tree.expanded]
        .filter((path) => tree.listings.has(path))
        .map((path) => loadListing(tree, path)),
    ),
  );
}

export function setExpanded(
  tree: ExplorerTree,
  path: string,
  open: boolean,
): void {
  if (open) {
    tree.expanded.add(path);
    if (!tree.listings.has(path)) void loadListing(tree, path);
  } else tree.expanded.delete(path);
  changed();
}

/** Root-relative change marks from the loaded Changes summary. */
export function changeMarks(
  cid: string,
  prefix: string | null,
): Map<string, ChangeMark> {
  const marks = new Map<string, ChangeMark>();
  const summary = loadedChanges(cid);
  if (!summary?.available || prefix === null) return marks;
  for (const file of summary.files ?? []) {
    if (file.status === "untracked") {
      marks.set(file.path, { mark: "U", diffPath: file.path });
      continue;
    }
    if (!file.path.startsWith(prefix)) continue;
    marks.set(file.path.slice(prefix.length), {
      mark: "M",
      diffPath: file.path,
    });
  }
  return marks;
}

/** Folders that contain at least one changed path. */
export function changedFolders(marks: Map<string, ChangeMark>): Set<string> {
  const folders = new Set<string>();
  for (const path of marks.keys())
    for (let dir = parentPath(path); dir; dir = parentPath(dir)) {
      if (folders.has(dir)) break;
      folders.add(dir);
    }
  return folders;
}

export function absolutePath(tree: ExplorerTree, path: string): string {
  if (!tree.root) return path;
  return path ? `${tree.root.replace(/\/$/, "")}/${path}` : tree.root;
}

export function copyPath(text: string): Promise<boolean> {
  return copyText(text);
}

/** Insert a path at the composer caret, surrounded by spaces where needed. */
export function insertPath(path: string): void {
  if (!focusComposerAtEnd()) return;
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, start);
  const text = (before && !/\s$/.test(before) ? " " : "") + path + " ";
  const next = insertTextAtSelection(
    inputEl.value,
    inputEl.selectionStart,
    inputEl.selectionEnd,
    text,
  );
  inputEl.value = next.value;
  inputEl.setSelectionRange(next.caret, next.caret);
  inputEl.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }),
  );
}

/** Open Changes and expand the file's diff once its row is rendered. */
export function showChanges(diffPath: string): void {
  openPane("diff");
  let tries = 0;
  const find = () => {
    const row = [
      ...document.querySelectorAll<HTMLElement>("#panes .diff-file-toggle"),
    ].find(
      (toggle) => toggle.querySelector(".diff-path")?.textContent === diffPath,
    );
    if (!row) {
      if (++tries < 40) setTimeout(find, 50);
      return;
    }
    if (row.getAttribute("aria-expanded") !== "true") row.click();
    row.scrollIntoView({ block: "start" });
    row.focus({ preventScroll: true });
  };
  find();
}
