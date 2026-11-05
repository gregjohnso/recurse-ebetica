// The File pane previews one explorer file with the Files pane's renderers:
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
  ATTACHMENT_FILE_ICON,
  CHANGES_ICON,
  COPY_ICON,
  FILE_DOWNLOAD_ICON,
  MESSAGE_ICON,
} from "../icons.js";
import { openPane, registerPane, syncPanes } from "../panes.js";
import { renderPowerbarControls } from "../panes/powerbar.js";
import { mountPdf, releasePdfs } from "../pdf-view.js";
import { phoneListEntry } from "../phone-nav.js";
import { selectAgent } from "../sidebar.js";
import { state } from "../state.js";
import type { PaneContext } from "../types.js";
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

const PANE_ID = "explorer-file";

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
let paneEl: PreviewEl | null = null;
let syncHook: (cid: string) => void = () => {};

/** Called on every pane sync with the open conversation. */
export function onPaneSync(hook: (cid: string) => void): void {
  syncHook = hook;
}

/** Preview `path` from conversation `cid` and open the File pane. */
export async function openPreview(cid: string, path: string): Promise<void> {
  treeFor(cid).selected = path;
  const shown: Preview = { cid, path, status: "loading" };
  preview = shown;
  changed();
  if (phoneListEntry()) selectAgent(cid);
  syncPanes();
  openPane(PANE_ID, { focusHeading: false });
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
  if (paneEl?.isConnected && preview && preview.cid === state.selectedId)
    renderPreview(paneEl, preview);
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
  renderPowerbarControls(
    element,
    html`<span class="explorer-preview-name" title=${shown.path}
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
        : nothing}`,
    true,
  );
  const folder = parentPath(shown.path);
  render(
    html`<div class="explorer-preview">
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

function available(ctx: PaneContext): boolean {
  syncHook(ctx.agentId);
  return preview?.cid === ctx.agentId;
}

function update(element: HTMLElement, ctx: PaneContext): void {
  paneEl = element as PreviewEl;
  if (preview?.cid === ctx.agentId) renderPreview(paneEl, preview);
}

onExplorerChange(repaint);

registerPane({
  id: PANE_ID,
  title: "File",
  icon: ATTACHMENT_FILE_ICON,
  available,
  visit(agentId) {
    if (preview && preview.cid !== agentId) preview = null;
  },
  render: update,
  refresh: update,
  leave(element) {
    (element as PreviewEl)._markdownAbort?.abort();
    (element as PreviewEl)._explorerKey = undefined;
    releasePdfs(element);
  },
});
