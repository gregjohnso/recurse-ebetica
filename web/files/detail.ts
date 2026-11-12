// One Files entry's detail view: a header (versions, Draw, Jump to message,
// Download, Delete) over its preview and selection comments. The Files pane
// (../files.ts) shows it instead of its list, dock tabs (./tab.ts) one each in
// an Explorer tab's compact row; both read files through files.ts's store.
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  FILE_DELETE_ICON,
  FILE_DOWNLOAD_ICON,
  JUMP_ICON as JUMP,
  MORE_ICON,
  PEN_ICON,
} from "../icons.js";
import { backendFor } from "../backends/backend.js";
import { attachmentSize } from "../agent-attachments.js";
import { jumpToFile, jumpToMessage } from "../conversation/navigation.js";
import { canDraw, drawOn } from "../image-preview/drawing.js";
import { installImageZoom } from "../image-preview/zoom.js";
import { commentMount, type CommentPane } from "../artifacts/artifact-state.js";
import { renderComments } from "../artifacts/comment-bar.js";
import {
  claimComments,
  reanchor,
  syncSelectionDraft,
} from "../artifacts/selection-comments.js";
import { renderDocumentMarkdown } from "../document-markdown.js";
import { diffPending, diffPreview, isDiff } from "./diff-preview.js";
import {
  fileKindLabel,
  rendersAsMarkdown,
  versionGroups,
  type FilePreviewState,
  type SessionFile,
} from "./model.js";

/** An element showing a detail view: it owns the Markdown and comments. */
export interface DetailHost extends HTMLElement {
  _markdownAbort?: AbortController;
  _rs?: CommentPane["_rs"];
}

/** A conversation's loaded Files listing, as the Files pane holds it. */
export interface FilesListing {
  files: SessionFile[];
  complete: boolean;
  error: string | null;
  failedDeletion: SessionFile | null;
}

/** What detail views read and do through the Files pane's cache. */
export interface FilesStore {
  listing(cid: string): FilesListing;
  /** Load the listing's next page, retrying after an error. */
  loadMore(cid: string): void;
  preview(cid: string, key: string): FilePreviewState | undefined;
  loadPreview(cid: string, file: SessionFile): void;
  reloadPreview(cid: string, key: string): void;
  openImage(cid: string, file: SessionFile): void;
  /** Confirm and delete `file`; true once it is deleted. */
  deleteFile(cid: string, file: SessionFile): Promise<boolean>;
  /** Repaint every Files view. */
  repaint(): void;
}

let store: FilesStore | null = null;
/** Called once by the Files pane. */
export function provideFilesStore(files: FilesStore): void {
  store = files;
}
export function filesStore(): FilesStore {
  return store!;
}

/** Viewer-only images by URL (Explorer files): no stored copy or comments. */
export const urlImages = new WeakMap<SessionFile, string>();

export function downloadHref(cid: string, file: SessionFile): string | null {
  const url = urlImages.get(file);
  if (url) return url;
  if (!file.id || file.unavailable) return null;
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/attachments/${encodeURIComponent(file.id)}`,
  );
}

export function imageHref(cid: string, file: SessionFile): string | null {
  const url = urlImages.get(file);
  if (url) return url;
  const base = downloadHref(cid, file);
  if (!base || file.preview !== "image") return null;
  // Invariant: The bytes route forces octet-stream + nosniff (never renders);
  // raster display goes through the inline-only preview capability.
  return `${base}/preview`;
}

function mediaHref(cid: string, file: SessionFile): string | null {
  const base = downloadHref(cid, file);
  if (!base || (file.preview !== "audio" && file.preview !== "video"))
    return null;
  return `${base}/preview`;
}

export function textPreviewHref(cid: string, file: SessionFile): string | null {
  if (!file.id || file.preview !== "text" || file.unavailable) return null;
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/files/${file.storage}/${encodeURIComponent(file.id)}/preview`,
  );
}

/** The detail image a Draw button inside `from`'s view draws on. */
export function drawImage(from: Element | null): HTMLImageElement | null {
  return (
    from
      ?.closest(".pane-col, .image-popout-body, .files-tab")
      ?.querySelector<HTMLImageElement>(".files-detail img") ?? null
  );
}

/** Enable each shown Draw button once its image can be drawn on. */
export function syncDraw(): void {
  for (const draw of document.querySelectorAll(".files-draw"))
    if (canDraw(drawImage(draw))) draw.removeAttribute("aria-disabled");
    else draw.setAttribute("aria-disabled", "true");
}
document.addEventListener("recurse:attachment-availability", syncDraw);

/** A file's preview; `host` asks for the detail view's full-size one. */
export function previewTemplate(
  cid: string,
  file: SessionFile,
  host?: DetailHost,
): unknown {
  const image = imageHref(cid, file);
  const preview = store?.preview(cid, file.key);
  if (image) {
    // Invariant: The list shows the thread-sized thumbnail; detail views load
    // the original, which box comments, crops and drawing measure.
    const img = html`<img
      class="files-image"
      alt=${file.name}
      src=${host ? image : image.replace(/\/preview$/, "/thumbnail")}
      loading=${host ? "eager" : "lazy"}
      decoding="async"
      @load=${(event: Event) => {
        syncDraw();
        if (host) {
          const image = event.target as HTMLImageElement;
          image
            .closest<HTMLElement>(".files-image-frame")
            ?.style.setProperty(
              "--image-aspect",
              String(image.naturalWidth / image.naturalHeight),
            );
          installImageZoom(image);
        }
      }}
    />`;
    // Invariant: Box marks are appended beside the image, so another file gets
    // a fresh frame instead of inheriting them.
    return host
      ? keyed(
          file.key,
          html`<div class="image-zoom-viewport">
            <div class="files-image-frame report-doc report-box-frame">
              ${img}
            </div>
          </div>`,
        )
      : img;
  }
  const media = mediaHref(cid, file);
  if (media)
    return file.preview === "audio"
      ? html`<audio
          class="files-media"
          controls
          preload="metadata"
          src=${media}
          aria-label=${file.name}
        ></audio>`
      : html`<video
          class="files-media"
          controls
          playsinline
          preload="metadata"
          src=${media}
          aria-label=${file.name}
        ></video>`;
  const pdf = file.preview === "pdf" ? downloadHref(cid, file) : null;
  if (pdf)
    return html`<div class="files-pdf report-doc" data-files-pdf=${pdf}></div>`;
  if (file.preview !== "text")
    return html`<div class="files-preview-note">
      No preview for this kind of file. Download it to open it.
    </div>`;
  if (preview?.status === "evicted")
    return html`<button
      class="files-preview-placeholder"
      type="button"
      @click=${() => store?.reloadPreview(cid, file.key)}
    >
      Reload preview
    </button>`;
  if (!textPreviewHref(cid, file))
    return html`<div class="files-preview-note">
      Preview available after the queued message appears.
    </div>`;
  // Invariant: Comment marks rewrite the preview's text nodes, so another
  // file gets fresh DOM rather than Lit updating those nodes in place.
  if (preview?.status === "ready")
    return keyed(
      file.key,
      html`<div class="files-text-wrap">
        ${isDiff(file, preview.text ?? "")
          ? diffPreview(preview)
          : rendersAsMarkdown(file)
            ? markdownPreview(
                cid,
                file,
                preview.text ?? "",
                preview.relatedFiles,
                host,
              )
            : html`<pre class="report-doc">${preview.text}</pre>`}
        ${preview.truncated
          ? html`<span class="files-preview-note">Preview truncated.</span>`
          : nothing}
      </div>`,
    );
  if (preview?.status === "missing")
    return html`<div class="files-preview-note">Preview unavailable.</div>`;
  return html`<div
    class="files-preview-placeholder"
    data-files-text=${file.key}
    aria-label=${`Text preview for ${file.name}`}
  >
    ${preview?.status === "loading"
      ? "Loading preview…"
      : "Preview loads when visible."}
  </div>`;
}

function versionLabel(file: SessionFile, number: number, latest: boolean) {
  const when = file.created_at
    ? new Date(file.created_at * 1000).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return [`Version ${number}`, when, latest ? "latest" : ""]
    .filter(Boolean)
    .join(" · ");
}

// The version menu: picking one shows that version in place.
function versionMenu(
  file: SessionFile,
  versions: SessionFile[],
  pick: (key: string) => void,
) {
  if (versions.length < 2) return nothing;
  return html`<div class="files-versions">
    <select
      aria-label="Version"
      @change=${(event: Event) => {
        const select = event.currentTarget as HTMLSelectElement;
        pick(select.value);
        if (select.isConnected) select.focus();
      }}
    >
      ${versions.map(
        (version, index) =>
          html`<option
            value=${version.key}
            .selected=${version.key === file.key}
          >
            ${versionLabel(version, versions.length - index, index === 0)}
          </option>`,
      )}
    </select>
  </div>`;
}

const JUMP_ICON = unsafeHTML(JUMP);
export const DOWNLOAD_ICON = unsafeHTML(FILE_DOWNLOAD_ICON);
export const DRAW_ICON = unsafeHTML(PEN_ICON);
const TRASH_ICON = unsafeHTML(FILE_DELETE_ICON);

function markdownPreview(
  cid: string,
  file: SessionFile,
  text: string,
  relatedFiles?: Record<string, string>,
  host?: DetailHost,
): HTMLElement {
  const body = document.createElement("div");
  body.className = "files-markdown artifact-doc report-doc";
  const controller = new AbortController();
  if (host) host._markdownAbort = controller;
  const listed = () => store?.listing(cid).files ?? [];
  const openImage = (image: SessionFile) => store?.openImage(cid, image);
  const sibling = (path: string): SessionFile | undefined => {
    let name: string;
    try {
      name = decodeURIComponent(
        new URL(
          path,
          new URL(file.name, "https://files.invalid/"),
        ).pathname.slice(1),
      );
    } catch {
      return undefined;
    }
    return versionGroups(listed()).find(
      (group) => group[0]!.name === name,
    )?.[0];
  };
  renderDocumentMarkdown(body, text, {
    title: file.name,
    signal: controller.signal,
    onImageOpen: (path) => {
      if (relatedFiles === undefined) {
        const found = sibling(path);
        if (found) openImage(found);
        return;
      }
      const id = Object.hasOwn(relatedFiles, path) ? relatedFiles[path] : null;
      if (!id) return;
      openImage(
        listed().find((candidate) => candidate.id === id) ?? {
          key: `published:${id}`,
          storage: "published",
          id,
          name: path.split("/").pop() || path,
          size: 0,
          media_type: "image/*",
          preview: "image",
          references: 0,
          sources: [],
        },
      );
    },
    resolveRelative: (path, image) => {
      if (relatedFiles !== undefined) {
        const id = Object.hasOwn(relatedFiles, path)
          ? relatedFiles[path]
          : null;
        if (!id) return null;
        const url = backendFor(cid).url(
          `/api/conversations/${encodeURIComponent(cid)}/attachments/${encodeURIComponent(id)}`,
        );
        return image ? `${url}/thumbnail` : url;
      }
      const found = sibling(path);
      return found
        ? image
          ? (imageHref(cid, found)?.replace(/\/preview$/, "/thumbnail") ?? null)
          : downloadHref(cid, found)
        : null;
    },
  });
  return body;
}

export function unavailableLabel(file: SessionFile): string | null {
  return file.unavailable === "copied"
    ? "Unavailable in copied conversation"
    : file.unavailable
      ? "File unavailable"
      : null;
}

export function metaLine(file: SessionFile, extra: string[]): string {
  return [
    file.media_type || "application/octet-stream",
    file.size > 0 ? attachmentSize(file.size) : "",
    fileKindLabel(file.storage),
    ...extra,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** An icon button; `size` is `lg` or an Explorer tab's `explorer-action`. */
export function iconButton(
  label: string,
  glyph: unknown,
  onClick: (event: Event) => void,
  extraClass = "",
  disabled = false,
  size = "lg",
): TemplateResult {
  return html`<button
    class=${`icon-btn ${size} ${extraClass}`}
    type="button"
    aria-label=${label}
    title=${label}
    aria-disabled=${disabled ? "true" : nothing}
    @click=${(event: Event) => disabled || onClick(event)}
  >
    ${glyph}
  </button>`;
}

// Jump to the file's first source message, or find one when none is known.
async function jumpToSource(cid: string, file: SessionFile, event: Event) {
  const source = file.sources.find((candidate) => candidate.offset !== null);
  if (source) return void jumpToMessage(cid, source.offset!, source.message_id);
  const button = event.currentTarget as HTMLButtonElement;
  const status = button.parentElement!.querySelector(".files-jump-status")!;
  button.disabled = true;
  status.textContent = "Finding message…";
  try {
    status.textContent = (await jumpToFile(cid, file.id!))
      ? ""
      : "Message unavailable";
  } catch {
    status.textContent = "Couldn’t find message";
  } finally {
    button.disabled = false;
  }
}

/** How a detail header's controls act on the view showing it. */
export interface HeaderActions {
  /** Show version `key` instead. */
  pick(key: string): void;
  /** Shown before the name, such as the pane's All files button. */
  back?: unknown;
  /** After Delete removed the file. */
  deleted?(): void;
}

// The version menu behind a File options button; none for a single version.
function versionOptions(
  file: SessionFile,
  versions: SessionFile[],
  pick: (key: string) => void,
) {
  if (versions.length < 2) return nothing;
  return html`<details class="pane-powerbar-overflow">
    <summary aria-label="File options" title="File options">
      ${unsafeHTML(MORE_ICON)}
    </summary>
    <div class="menu form pane-powerbar-menu">
      ${versionMenu(file, versions, pick)}
    </div>
  </details>`;
}

// Draw, Jump to message, Download and Delete, as `size` icon buttons.
function fileActions(
  cid: string,
  file: SessionFile,
  actions: HeaderActions,
  size: string,
) {
  const href = downloadHref(cid, file);
  const unavailable = unavailableLabel(file);
  const jump =
    file.sources.some((source) => source.offset !== null) ||
    (!file.sources.length && file.id && !unavailable);
  const button = (
    label: string,
    glyph: unknown,
    onClick: (event: Event) => void,
    extraClass = "",
  ) => iconButton(label, glyph, onClick, extraClass, false, size);
  const draw = imageHref(cid, file) && !unavailable;
  return html` <span class="files-jump-status" role="status"></span>
    ${draw
      ? button(
          "Draw",
          DRAW_ICON,
          (event) => drawOn(drawImage(event.currentTarget as Element)),
          "files-draw",
        )
      : nothing}
    ${jump
      ? button("Jump to message", JUMP_ICON, (event) =>
          jumpToSource(cid, file, event),
        )
      : nothing}
    ${href
      ? html`<a
            class=${`icon-btn ${size}`}
            href=${href}
            download=${file.name}
            data-bytes=${file.size}
            aria-label="Download"
            title="Download"
            >${DOWNLOAD_ICON}</a
          >${button("Delete", TRASH_ICON, async () => {
            if (await store?.deleteFile(cid, file)) actions.deleted?.();
          })}`
      : nothing}`;
}

/** The detail header: the name and versions, then file actions. */
export function detailHeader(
  cid: string,
  file: SessionFile,
  versions: SessionFile[],
  actions: HeaderActions,
): TemplateResult {
  return html`<header class="files-detail-head">
    ${actions.back ?? nothing}
    <div class="files-detail-title">
      <h3 class="files-name" title=${file.name}>${file.name}</h3>
      ${versionOptions(file, versions, actions.pick)}
    </div>
    <div class="files-actions">${fileActions(cid, file, actions, "lg")}</div>
  </header>`;
}

const references = (file: SessionFile): string =>
  file.references > 1 ? `${file.references} references` : "";

/** A dock tab's header, an Explorer tab's compact row: the metadata line
 * with the version menu and file actions at its end. The tab names the file. */
export function tabHeader(
  cid: string,
  file: SessionFile,
  versions: SessionFile[],
  actions: HeaderActions,
): TemplateResult {
  const index = versions.indexOf(file);
  const version =
    versions.length > 1
      ? `Version ${versions.length - index} of ${versions.length}`
      : "";
  const meta = metaLine(file, [references(file), version]);
  return html`<div class="explorer-preview-bar">
      ${versionOptions(file, versions, actions.pick)}
      ${fileActions(cid, file, actions, "explorer-action")}
    </div>
    <div class="explorer-preview-meta" title=${meta}>
      <span class="files-meta">${meta}</span>
    </div>`;
}

/** The pane's bar over a detail view: `nav`, then the file's metadata. */
export function detailBar(file: SessionFile, nav: unknown): TemplateResult {
  return html`<div class="files-detail-bar">
    ${nav}
    <span class="files-meta">${metaLine(file, [references(file)])}</span>
  </div>`;
}

/** The detail body: `bar` over the preview, then comments. */
export function detailBody(
  cid: string,
  file: SessionFile,
  host: DetailHost,
  bar: unknown = nothing,
): TemplateResult {
  const unavailable = unavailableLabel(file);
  return html`<article
      class="files-detail"
      data-file-key=${file.key}
      aria-label=${file.name}
    >
      ${bar}
      ${unavailable
        ? html`<div class="files-unavailable" role="status">
            ${unavailable}
          </div>`
        : previewTemplate(cid, file, host)}
    </article>
    <div class="report-comments"></div>
    <div class="report-bar"></div>`;
}

// Spec: A shown text preview takes selection comments exactly like an Artifact
// version: staged in the comment bar, submitted to this conversation.
export function syncComments(
  element: DetailHost,
  cid: string,
  file: SessionFile | null,
) {
  syncSelectionDraft();
  const pending = file && diffPending(store?.preview(cid, file.key));
  if (pending) void pending.then(() => store?.repaint());
  const doc = file?.id && element.querySelector(".report-doc") ? file : null;
  // Invariant: Mutated in place: an in-flight send clears the flags on the
  // object it started with.
  element._rs ??= {
    deleting: false,
    sending: false,
    sendFailed: false,
    sendSeq: 0,
    agentId: cid,
    selId: null,
    contentInfo: null,
  };
  Object.assign(element._rs, {
    agentId: cid,
    selId: doc?.id ?? null,
    contentInfo: doc
      ? { noun: "file", id: doc.id!, title: doc.name, version: doc.key }
      : null,
  });
  const pane = element as CommentPane;
  if (!doc) {
    if (commentMount.current === pane) commentMount.current = null;
    return;
  }
  claimComments(pane);
  reanchor(pane, doc.id!);
  renderComments(pane);
}
