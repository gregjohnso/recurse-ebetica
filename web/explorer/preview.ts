// Previews one Explorer file below its tree with the Files pane's renderers:
// document Markdown, plain text in a report-doc block, pdf.js and raster
// images served only after the server's magic-byte check. Other files show
// their size and a download link. Credential files show the server's refusal.
import { html, nothing, render, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "../backends/backend.js";
import { attachmentSize } from "../agent-attachments.js";
import { renderDocumentMarkdown } from "../document-markdown.js";
import {
  CHANGES_ICON,
  CLOSE_ICON,
  COPY_ICON,
  FILE_DOWNLOAD_ICON,
  MESSAGE_ICON,
} from "../icons.js";
import { mountPdf, releasePdfs } from "../pdf-view.js";
import {
  absolutePath,
  baseName,
  changeMarks,
  changed,
  copyPath,
  insertPath,
  onExplorerChange,
  parentPath,
  showChanges,
  treeFor,
  treeUrl,
} from "./state.js";

interface Preview {
  cid: string;
  path: string;
  status: "loading" | "ready" | "error";
  kind?: "text" | "image" | "pdf" | "binary";
  text?: string;
  truncated?: boolean;
  size?: number;
  detail?: string;
}

interface PreviewEl extends HTMLElement {
  _explorerKey?: string;
  _markdownAbort?: AbortController;
}

let preview: Preview | null = null;
/** The preview's element; the Explorer pane places it below the tree. */
export const previewHost: PreviewEl = document.createElement("div");
previewHost.className = "explorer-preview-host";

/** Whether a file from conversation `cid` is being previewed. */
export function previewShown(cid: string): boolean {
  return preview?.cid === cid;
}

/** Close the preview, or only one belonging to another conversation. */
export function closePreview(keepCid?: string): void {
  if (!preview || preview.cid === keepCid) return;
  treeFor(preview.cid).selected = "";
  preview = null;
  previewHost._markdownAbort?.abort();
  previewHost._explorerKey = undefined;
  releasePdfs(previewHost);
  render(nothing, previewHost);
  changed();
}

/** Preview `path` from conversation `cid` below the Explorer tree. */
export async function openPreview(cid: string, path: string): Promise<void> {
  treeFor(cid).selected = path;
  const shown: Preview = { cid, path, status: "loading" };
  preview = shown;
  changed();
  repaint();
  try {
    const response = await backendFor(cid).api(treeUrl(cid, "/file", path), {
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (preview !== shown) return;
    if (!response.ok || !body)
      Object.assign(shown, {
        status: "error",
        detail:
          typeof body?.detail === "string"
            ? body.detail
            : `Couldn’t open this file (${response.status}).`,
      });
    else
      Object.assign(shown, {
        status: "ready",
        kind: body.kind,
        text: typeof body.text === "string" ? body.text : undefined,
        truncated: body.truncated === true,
        size: Number(body.size) || 0,
      });
  } catch {
    if (preview === shown)
      Object.assign(shown, {
        status: "error",
        detail: "Couldn’t reach the server.",
      });
  }
  repaint();
}

function repaint(): void {
  if (preview) renderPreview(previewHost, preview);
}

const icon = (svg: string) => unsafeHTML(svg);

function actionButton(
  label: string,
  svg: string,
  run: () => void,
): TemplateResult {
  return html`<button
    class="icon-btn explorer-action"
    type="button"
    title=${label}
    aria-label=${label}
    @click=${run}
  >
    ${icon(svg)}
  </button>`;
}

function markdown(shown: Preview, element: PreviewEl): HTMLElement {
  const body = document.createElement("div");
  body.className = "files-markdown artifact-doc report-doc";
  element._markdownAbort?.abort();
  const controller = new AbortController();
  element._markdownAbort = controller;
  renderDocumentMarkdown(body, shown.text ?? "", {
    title: baseName(shown.path),
    signal: controller.signal,
    resolveRelative: (relative) => {
      let path: string;
      try {
        path = decodeURIComponent(
          new URL(relative, `https://files.invalid/${shown.path}`).pathname,
        ).slice(1);
      } catch {
        return null;
      }
      return path ? treeUrl(shown.cid, "/raw", path) : null;
    },
  });
  // Spec: Relative links to tree files open in this preview, not a download.
  body.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a[href]",
    );
    if (!link) return;
    const url = new URL(link.href, location.href);
    const path = url.searchParams.get("path");
    if (url.origin !== location.origin || !url.pathname.endsWith("/tree/raw"))
      return;
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    void openPreview(shown.cid, path);
  });
  return body;
}

function content(shown: Preview, element: PreviewEl): unknown {
  if (shown.status === "loading")
    return html`<div class="files-preview-placeholder">Loading preview…</div>`;
  if (shown.status === "error")
    return html`<div class="files-preview-note" role="alert">
      ${shown.detail}
    </div>`;
  const raw = treeUrl(shown.cid, "/raw", shown.path);
  if (shown.kind === "image")
    return html`<img
      class="files-image explorer-image"
      alt=${baseName(shown.path)}
      src=${raw}
      decoding="async"
    />`;
  if (shown.kind === "pdf") {
    const container = document.createElement("div");
    container.className = "files-pdf report-doc";
    mountPdf(container, raw);
    return container;
  }
  if (shown.kind !== "text")
    return html`<div class="files-preview-note">
      No preview for this kind of file (${attachmentSize(shown.size ?? 0)}).
      <a href=${raw} download=${baseName(shown.path)}>Download</a>
    </div>`;
  return keyed(
    `${shown.cid}\n${shown.path}`,
    html`<div class="files-text-wrap">
      ${/\.(?:md|markdown)$/i.test(shown.path)
        ? markdown(shown, element)
        : html`<pre class="report-doc">${shown.text}</pre>`}
      ${shown.truncated
        ? html`<span class="files-preview-note"
            >Showing the first 1 MiB.
            <a href=${raw} download=${baseName(shown.path)}
              >Download the whole file</a
            ></span
          >`
        : nothing}
    </div>`,
  );
}

function renderPreview(element: PreviewEl, shown: Preview): void {
  const key = JSON.stringify([
    shown.cid,
    shown.path,
    shown.status,
    shown.kind,
    shown.size,
    changeMarks(shown.cid, treeFor(shown.cid).prefix).get(shown.path)?.mark,
  ]);
  if (element._explorerKey === key) return;
  element._explorerKey = key;
  releasePdfs(element);
  const tree = treeFor(shown.cid);
  const mark = changeMarks(shown.cid, tree.prefix).get(shown.path);
  const raw = treeUrl(shown.cid, "/raw", shown.path);
  const folder = parentPath(shown.path);
  render(
    html`<div class="explorer-preview">
      <div class="explorer-preview-bar">
        <span class="explorer-preview-name" title=${shown.path}
          >${baseName(shown.path)}</span
        >
        ${mark
          ? actionButton("Show changes", CHANGES_ICON, () =>
              showChanges(mark.diffPath),
            )
          : nothing}
        ${actionButton("Copy path", COPY_ICON, () =>
          copyPath(absolutePath(tree, shown.path)),
        )}
        ${actionButton("Insert path into message", MESSAGE_ICON, () =>
          insertPath(shown.path),
        )}
        ${shown.status === "ready"
          ? html`<a
              class="icon-btn explorer-action"
              href=${raw}
              download=${baseName(shown.path)}
              title="Download"
              aria-label="Download"
              >${icon(FILE_DOWNLOAD_ICON)}</a
            >`
          : nothing}
        ${actionButton("Close preview", CLOSE_ICON, () => closePreview())}
      </div>
      <div class="explorer-preview-meta">
        ${folder ? `${folder}/` : ""}${baseName(shown.path)}
        ${shown.status === "ready" && shown.size !== undefined
          ? ` · ${attachmentSize(shown.size)}`
          : ""}
      </div>
      ${content(shown, element)}
    </div>`,
    element,
  );
}
onExplorerChange(repaint);
