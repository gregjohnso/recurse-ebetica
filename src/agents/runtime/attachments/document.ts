// Markdown publication snapshots direct local references into ordinary owned
// attachments. The parent manifest commits last; previews never read workspace
// paths. Descriptor-relative no-follow opens confine dependencies to its folder.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { marked } from "marked";
import { openAt } from "../../../utils/dir_fd";
import {
  AttachmentError,
  MAX_FILE_BYTES,
  MAX_RELATED_FILES,
  readRelatedFiles,
  relatedFilePath,
  type Manifest,
} from "./base";
import { publicMetadata } from "./preview";
import { registerFile, registeredFile, type RegisterOptions } from "./publish";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function openDescendant(
  directory: FileHandle,
  path: string,
): Promise<FileHandle> {
  const parts = path.split("/");
  let current = directory;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await openAt(current.fd, part, DIRECTORY_FLAGS);
      if (current !== directory) await current.close();
      current = next;
    }
    const file = await openAt(current.fd, parts.at(-1)!, FILE_FLAGS);
    try {
      if (!(await file.stat()).isFile())
        throw new AttachmentError("not a regular file");
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  } finally {
    if (current !== directory) await current.close();
  }
}

async function documentBytes(
  file: FileHandle,
  size: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
    if (!bytesRead)
      throw new AttachmentError("document changed while being read");
    offset += bytesRead;
  }
  if ((await file.stat()).size !== size)
    throw new AttachmentError("document changed while being read");
  return bytes;
}

async function documentReferences(
  text: string,
): Promise<{ hrefs: string[]; capped: boolean }> {
  const hrefs = new Set<string>();
  let capped = false;
  const record = (href: string | null) => {
    if (
      !href ||
      /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href) ||
      hrefs.has(href)
    )
      return;
    if (hrefs.size >= MAX_RELATED_FILES) capped = true;
    else hrefs.add(href);
  };
  const rewriter = new HTMLRewriter()
    .on("img[src]", {
      element: (element) => record(element.getAttribute("src")),
    })
    .on("a[href]", {
      element: (element) => record(element.getAttribute("href")),
    });
  const html = await marked.parse(text, { async: false, gfm: true });
  await rewriter.transform(new Response(html)).text();
  return { hrefs: [...hrefs], capped };
}

export interface DocumentPublication {
  item: Manifest;
  included: number;
  warnings: string[];
}

/** Publish original Markdown bytes together with bounded direct local files. */
export async function registerDocumentFile(
  collection: string,
  owner: string,
  runId: string,
  toolCallId: string,
  source: string,
  workdir: string,
  options: RegisterOptions = {},
): Promise<DocumentPublication> {
  const rootOptions = { ...options, manyPerCall: true };
  const replay = await registeredFile(
    collection,
    owner,
    runId,
    toolCallId,
    source,
    rootOptions,
  );
  if (replay) {
    const related = readRelatedFiles(replay.related_files);
    return {
      item: publicMetadata(replay),
      included: related ? new Set(Object.values(related)).size : 0,
      warnings: [],
    };
  }
  if (
    ![".md", ".markdown"].includes(
      extname(options.name ?? source).toLowerCase(),
    )
  )
    return {
      item: await registerFile(
        collection,
        owner,
        runId,
        toolCallId,
        source,
        workdir,
        rootOptions,
      ),
      included: 0,
      warnings: [],
    };

  const fullPath = resolve(workdir, source);
  let directory: FileHandle | undefined;
  let root: FileHandle | undefined;
  try {
    directory = await open(dirname(fullPath), DIRECTORY_FLAGS);
    root = await openAt(directory.fd, basename(fullPath), FILE_FLAGS);
    const rootStat = await root.stat();
    if (!rootStat.isFile())
      throw new AttachmentError("source must be a regular file");
    if (rootStat.size <= 0)
      throw new AttachmentError("attachment source is empty");
    const maxRootBytes = Math.min(
      MAX_FILE_BYTES,
      options.limits?.maxFileBytes ?? MAX_FILE_BYTES,
    );
    if (rootStat.size > maxRootBytes)
      throw new AttachmentError(
        `file is too large (max ${Math.floor(maxRootBytes / (1024 * 1024))} MB)`,
      );
    const warnings: string[] = [];
    const related: Record<string, string> = Object.create(null);
    const captured = new Map<string, string>();
    let totalBytes = rootStat.size;
    let expectedSha256: string | undefined;
    if (rootStat.size > MAX_DOCUMENT_BYTES) {
      warnings.push(
        "References not included: Markdown exceeds the 256 KiB reference scan limit.",
      );
    } else {
      const bytes = await documentBytes(root, rootStat.size);
      expectedSha256 = createHash("sha256").update(bytes).digest("hex");
      let text: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        warnings.push("References not included: Markdown is not valid UTF-8.");
      }
      if (text !== null) {
        const { hrefs, capped } = await documentReferences(text);
        if (capped)
          warnings.push(
            "Additional references skipped: at most 100 references are scanned.",
          );
        for (const href of hrefs) {
          const path = relatedFilePath(href);
          if (path === null) {
            warnings.push(
              `Skipped reference ${JSON.stringify(href.slice(0, 180))}: only non-hidden descendant files are included.`,
            );
            continue;
          }
          const existing = captured.get(path);
          const candidate = JSON.stringify({
            ...related,
            [href]: existing ?? "0".repeat(32),
          });
          if (readRelatedFiles(candidate) === null) {
            warnings.push(
              `Skipped reference ${JSON.stringify(href.slice(0, 180))}: reference metadata limit reached.`,
            );
            continue;
          }
          if (existing) {
            related[href] = existing;
            continue;
          }
          let dependency: FileHandle | undefined;
          try {
            dependency = await openDescendant(directory, path);
            const stat = await dependency.stat();
            if (stat.dev === rootStat.dev && stat.ino === rootStat.ino)
              throw new AttachmentError("self-reference is not included");
            if (totalBytes + stat.size > MAX_FILE_BYTES)
              throw new AttachmentError(
                "100 MB combined publication limit reached",
              );
            const item = await registerFile(
              collection,
              owner,
              runId,
              toolCallId,
              join(dirname(fullPath), path),
              workdir,
              {
                ...options,
                name: undefined,
                manyPerCall: true,
                sourceHandle: dependency,
                relatedFiles: undefined,
                expectedSha256: undefined,
                reserveParentSlot: true,
              },
            );
            const id = String(item.id);
            if (
              readRelatedFiles(JSON.stringify({ ...related, [href]: id })) ===
              null
            )
              throw new AttachmentError("reference metadata limit reached");
            related[href] = id;
            captured.set(path, id);
            totalBytes += Number(item.size);
          } catch (error) {
            const reason =
              error instanceof AttachmentError
                ? error.message
                : "file unavailable or unsafe";
            warnings.push(
              `Skipped reference ${JSON.stringify(href.slice(0, 180))}: ${reason}.`,
            );
          } finally {
            await dependency?.close();
          }
        }
      }
    }
    return {
      item: await registerFile(
        collection,
        owner,
        runId,
        toolCallId,
        source,
        workdir,
        {
          ...rootOptions,
          sourceHandle: root,
          relatedFiles: JSON.stringify(related),
          expectedSha256,
        },
      ),
      included: captured.size,
      warnings,
    };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("cannot open Markdown source safely");
  } finally {
    await root?.close();
    await directory?.close();
  }
}
