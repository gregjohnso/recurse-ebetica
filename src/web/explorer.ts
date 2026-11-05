// Read-only file explorer routes over one conversation's working directory.
// Paths walk component by component from the cwd without following symlinks;
// only regular non-credential files open. One directory and one bounded Git
// ignore check per request; agent-marked requests are refused (README.md).
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { resolve } from "node:path";
import { contentDisposition } from "../agents/runtime/attachments/published";
import { inlineRasterMediaType } from "../agents/runtime/attachments/base";
import {
  descriptorPath,
  lstatAt,
  openAt,
  typedEntriesAt,
} from "../utils/dir_fd";
import { runBounded, safeGitEnv } from "../workdir_git";
import { agentMarked } from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";
import { rangedResponse } from "./static";

type Rec = Record<string, unknown>;

/** Entries returned per directory; the rest are counted as `more`. */
export const EXPLORER_MAX_ENTRIES = 1000;
/** Names read per directory; past this `more` is a lower bound. */
export const EXPLORER_SCAN_MAX_ENTRIES = 10_000;
/** Text preview bytes; longer files are truncated. */
export const EXPLORER_TEXT_MAX_BYTES = 1024 * 1024;
/** Raw downloads and image previews larger than this are refused. */
export const EXPLORER_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const GIT_TIMEOUT_SECONDS = 5;
const GIT_OUTPUT_MAX_BYTES = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK;
const RASTER_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const CREDENTIAL_RE =
  /^(?:\.env.*|id_(?:rsa|dsa|ecdsa|ed25519).*|\.netrc|_netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc|\.vault-token|\.htpasswd|credentials(?:\..*)?|auth\.json|.*\.tfstate.*|.*\.(?:pem|key|p12|pfx))$/i;
const CREDENTIAL_SUFFIXES = [
  [".git", "config"],
  [".kube", "config"],
  [".docker", "config.json"],
  [".config", "gh", "hosts.yml"],
];
const GIT = [
  "git",
  "-c",
  "core.fsmonitor=false",
  "--no-optional-locks",
  "--no-replace-objects",
];
const SAFE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

export interface ExplorerEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  mtime: number;
  ignored: boolean;
  symlink: boolean;
  credential: boolean;
}

export interface ExplorerRoutesDeps {
  readonly store: {
    load(cid: string): Rec | null;
    effectiveWorkdir(conv: Rec): string;
  };
  readonly durable?: {
    owns(conv: Rec | null | undefined): boolean;
    effectiveCwd(cid: string): Promise<string | null>;
  };
  /** The server's process environment, scrubbed before running Git. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Recurse's data directory; files under it are listed but never read. */
  readonly dataDir: string;
}

/**
 * True when the file at real absolute `path` may hold secrets: credential
 * names, anything under .ssh, known config files, or Recurse's data dir.
 */
export function credentialPath(path: string, dataDir: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return (
    CREDENTIAL_RE.test(parts.at(-1) ?? "") ||
    parts.includes(".ssh") ||
    CREDENTIAL_SUFFIXES.some((suffix) =>
      suffix.every((part, index) => parts.at(index - suffix.length) === part),
    ) ||
    recurseStatePath(path, dataDir)
  );
}

/** True inside Recurse's data dir, except files of a managed worktree. */
function recurseStatePath(path: string, dataDir: string): boolean {
  const base = dataDir.replace(/\/$/, "");
  if (path !== base && !path.startsWith(`${base}/`)) return false;
  const [top, name, ...rest] = path.slice(base.length + 1).split("/");
  return !(top === "worktrees" && name && !name.startsWith(".") && rest.length);
}

/** Validated components of a root-relative path; 422 for anything else. */
export function explorerPath(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  const parts = raw.split("/");
  if (
    raw.includes("\0") ||
    raw.startsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    throw new HttpError(422, "path must be relative to the working directory");
  return parts;
}

function failure(error: unknown): HttpError {
  const code = (error as { code?: unknown })?.code;
  if (error instanceof HttpError) return error;
  if (code === "ENOENT") return new HttpError(404, "not found");
  if (code === "ELOOP" || code === "EMLINK")
    return new HttpError(422, "symbolic links are not followed");
  if (code === "ENOTDIR") return new HttpError(422, "not a directory");
  if (code === "EACCES" || code === "EPERM")
    return new HttpError(403, "permission denied");
  return new HttpError(404, "not found");
}

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** The real path of the opened root, or a 409 if it no longer names it. */
async function rootPath(dir: FileHandle, root: string): Promise<string> {
  const path =
    process.platform === "linux"
      ? await readlink(descriptorPath(dir.fd))
      : await realpath(root);
  const [opened, named] = await Promise.all([
    dir.stat(),
    lstat(path).catch(() => null),
  ]);
  if (!named || !sameFile(opened, named))
    throw new HttpError(409, "the folder changed; try again");
  return path.replace(/\/$/, "");
}

async function openDirectory(root: string, parts: string[]) {
  // Invariant: Each component opens relative to its pinned parent with
  // O_NOFOLLOW, so a symlink or swapped parent never widens the root, and
  // credential checks use the path of the opened root, not a second lookup.
  let dir: FileHandle = await open(
    root,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const realRoot = await rootPath(dir, root);
    for (const part of parts) {
      const next = await openAt(dir.fd, part, DIRECTORY_FLAGS);
      await dir.close();
      dir = next;
    }
    return { dir, realRoot };
  } catch (error) {
    await dir.close().catch(() => {});
    throw error;
  }
}

function entryType(stats: Stats): ExplorerEntry["type"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  return stats.isFile() ? "file" : "other";
}

/** Root-relative paths that Git ignores; empty when Git cannot say in time. */
async function ignoredPaths(
  root: string,
  paths: string[],
  env: ExplorerRoutesDeps["env"],
  signal: AbortSignal,
): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const result = await runBounded(
    [...GIT, "check-ignore", "--stdin", "-z"],
    root,
    safeGitEnv(env),
    GIT_OUTPUT_MAX_BYTES,
    GIT_TIMEOUT_SECONDS,
    signal,
    // Invariant: check-ignore rejects --literal-pathspecs; a "./" prefix keeps
    // names such as ":(exclude)b" from being read as pathspec magic.
    new TextEncoder().encode(paths.map((path) => `./${path}\0`).join("")),
  );
  if (!result || result.truncated || (result.code !== 0 && result.code !== 1))
    return new Set();
  return new Set(
    new TextDecoder()
      .decode(result.out)
      .split("\0")
      .filter((path) => path.startsWith("./"))
      .map((path) => path.slice(2)),
  );
}

/** The repository prefix of `root` ("" at the top), or null outside Git. */
async function gitPrefix(
  root: string,
  env: ExplorerRoutesDeps["env"],
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runBounded(
    [...GIT, "rev-parse", "--show-prefix"],
    root,
    safeGitEnv(env),
    4096,
    GIT_TIMEOUT_SECONDS,
    signal,
  );
  if (!result || result.code !== 0 || result.truncated) return null;
  return new TextDecoder().decode(result.out).trim();
}

/**
 * List one directory: folders first, then case-insensitive names. Reads at
 * most EXPLORER_SCAN_MAX_ENTRIES names, so a huge folder sorts only those.
 */
export async function listDirectory(
  root: string,
  parts: string[],
  dataDir: string,
  env: ExplorerRoutesDeps["env"],
  signal: AbortSignal,
): Promise<{ entries: ExplorerEntry[]; more: number; more_exact: boolean }> {
  const { dir, realRoot } = await openDirectory(root, parts);
  try {
    const { entries: scanned, complete } = await typedEntriesAt(
      dir.fd,
      EXPLORER_SCAN_MAX_ENTRIES,
    );
    const keyed = scanned.map((entry) => ({
      ...entry,
      key: entry.name.toLowerCase(),
    }));
    keyed.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : 1),
    );
    const shown = keyed.slice(0, EXPLORER_MAX_ENTRIES);
    const prefix = parts.length ? `${parts.join("/")}/` : "";
    const [stats, ignored] = await Promise.all([
      Promise.all(
        shown.map(({ name }) => lstatAt(dir.fd, name).catch(() => null)),
      ),
      ignoredPaths(
        root,
        shown.map(({ name }) => prefix + name),
        env,
        signal,
      ),
    ]);
    const entries: ExplorerEntry[] = [];
    shown.forEach(({ name }, index) => {
      const stat = stats[index];
      if (!stat) return;
      const type = entryType(stat);
      entries.push({
        name,
        type,
        size: type === "file" ? stat.size : 0,
        mtime: Math.floor(stat.mtimeMs),
        ignored: ignored.has(prefix + name),
        symlink: type === "symlink",
        credential:
          type === "file" &&
          credentialPath(`${realRoot}/${prefix}${name}`, dataDir),
      });
    });
    return {
      entries,
      more: keyed.length - shown.length,
      more_exact: complete,
    };
  } finally {
    await dir.close().catch(() => {});
  }
}

/** Open one regular, non-credential file without following symlinks. */
export async function openRegularFile(
  root: string,
  parts: string[],
  dataDir: string,
): Promise<{ handle: FileHandle; stats: Stats; name: string }> {
  if (!parts.length) throw new HttpError(422, "not a file");
  const name = parts.at(-1)!;
  const { dir, realRoot } = await openDirectory(root, parts.slice(0, -1));
  try {
    // Invariant: FIFOs, devices and sockets are refused from lstat before any
    // open; O_NONBLOCK and the inode match cover a swap in between.
    const before = await lstatAt(dir.fd, name);
    if (before.isSymbolicLink())
      throw new HttpError(422, "symbolic links are not followed");
    if (!before.isFile()) throw new HttpError(422, "not a regular file");
    if (credentialPath(`${realRoot}/${parts.join("/")}`, dataDir))
      throw new HttpError(403, "credential file contents are not shown");
    const handle = await openAt(dir.fd, name, FILE_FLAGS);
    const stats = await handle.stat().catch(() => null);
    if (!stats?.isFile() || !sameFile(before, stats)) {
      await handle.close().catch(() => {});
      throw new HttpError(409, "the file changed while opening");
    }
    return { handle, stats, name };
  } finally {
    await dir.close().catch(() => {});
  }
}

async function readPrefix(handle: FileHandle, size: number) {
  const bytes = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const { bytesRead } = await handle.read(bytes, at, size - at, at);
    if (!bytesRead) break;
    at += bytesRead;
  }
  return bytes.subarray(0, at);
}

/** UTF-8 text without NUL, allowing one cut character at a truncated end. */
function decodeText(bytes: Uint8Array, truncated: boolean): string | null {
  if (bytes.includes(0)) return null;
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.length - cut),
      );
    } catch {}
  }
  return null;
}

const extensionOf = (name: string) =>
  name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

export function registerExplorerRoutes(
  router: Router,
  deps: ExplorerRoutesDeps,
): void {
  let dataDir: Promise<string> | null = null;
  const scope = async (ex: Exchange) => {
    if (agentMarked(ex))
      throw new HttpError(403, "only the operator can browse files");
    const conv = deps.store.load(ex.params.cid!);
    if (!conv) throw new HttpError(404);
    let workdir: string;
    try {
      workdir = deps.store.effectiveWorkdir(conv);
    } catch {
      throw new HttpError(404, "unknown workdir");
    }
    const live = deps.durable?.owns(conv)
      ? await deps.durable.effectiveCwd(String(conv.id)).catch(() => null)
      : null;
    const raw = ex.query.path;
    const parts = explorerPath(typeof raw === "string" ? raw : null);
    const root = live || workdir;
    dataDir ??= realpath(deps.dataDir).catch(() => resolve(deps.dataDir));
    return {
      root,
      parts,
      dataDir: await dataDir,
    };
  };
  const query = { query: { path: { type: "str" as const } } };

  router.get(
    "/api/conversations/{cid}/tree",
    async (ex) => {
      const { root, parts, dataDir } = await scope(ex);
      const signal = ex.request.signal;
      try {
        const [listing, prefix] = await Promise.all([
          listDirectory(root, parts, dataDir, deps.env, signal),
          parts.length ? null : gitPrefix(root, deps.env, signal),
        ]);
        return jsonResponse(
          { root, path: parts.join("/"), git_prefix: prefix, ...listing },
          200,
          { "cache-control": "no-store" },
        );
      } catch (error) {
        throw failure(error);
      }
    },
    query,
  );

  router.get(
    "/api/conversations/{cid}/tree/file",
    async (ex) => {
      const { root, parts, dataDir } = await scope(ex);
      let opened;
      try {
        opened = await openRegularFile(root, parts, dataDir);
      } catch (error) {
        throw failure(error);
      }
      const { handle, stats, name } = opened;
      try {
        const meta = {
          path: parts.join("/"),
          name,
          size: stats.size,
          mtime: Math.floor(stats.mtimeMs),
        };
        const extension = extensionOf(name);
        const noStore = { "cache-control": "no-store" };
        if (extension === "pdf")
          return jsonResponse({ ...meta, kind: "pdf" }, 200, noStore);
        const head = await readPrefix(
          handle,
          Math.min(stats.size, EXPLORER_TEXT_MAX_BYTES),
        );
        if (
          RASTER_EXTENSIONS[extension] &&
          stats.size <= IMAGE_MAX_BYTES &&
          inlineRasterMediaType(head.subarray(0, 16)) ===
            RASTER_EXTENSIONS[extension]
        )
          return jsonResponse({ ...meta, kind: "image" }, 200, noStore);
        const truncated = stats.size > head.length;
        const text = decodeText(head, truncated);
        return jsonResponse(
          text === null
            ? { ...meta, kind: "binary" }
            : { ...meta, kind: "text", text, truncated },
          200,
          noStore,
        );
      } finally {
        await handle.close().catch(() => {});
      }
    },
    query,
  );

  router.add(
    ["GET", "HEAD"],
    "/api/conversations/{cid}/tree/raw",
    async (ex) => {
      const { root, parts, dataDir } = await scope(ex);
      let opened;
      try {
        opened = await openRegularFile(root, parts, dataDir);
      } catch (error) {
        throw failure(error);
      }
      const { handle, stats, name } = opened;
      if (stats.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
        await handle.close().catch(() => {});
        throw new HttpError(413, "file is too large to download here");
      }
      let media: string | null = null;
      try {
        const expected = RASTER_EXTENSIONS[extensionOf(name)];
        if (expected && stats.size <= IMAGE_MAX_BYTES) {
          const sniffed = inlineRasterMediaType(await readPrefix(handle, 16));
          media = sniffed === expected ? sniffed : null;
        }
      } catch {
        await handle.close().catch(() => {});
        throw new HttpError(404, "not found");
      }
      return rangedResponse(
        ex.request,
        { handle, size: stats.size },
        {
          ...SAFE_HEADERS,
          "accept-ranges": "bytes",
          "content-length": String(stats.size),
          "content-type": media ?? "application/octet-stream",
          "content-disposition": media
            ? contentDisposition(name).replace(/^attachment/, "inline")
            : contentDisposition(name),
        },
      );
    },
    { ...query, longRunning: true },
  );
}
