// Page bounded owner metadata newest-first; load previews only when visible.
// Share inert reply rendering; cache text in a bounded LRU, images in browser.
// Image dialogs leave their history step before opening Files; share originals.
// Viewers go oldest-first; probes are throttled; desktop rows open dock tabs.
import { html, nothing, render, type TemplateResult } from "lit";
import {
  ATTACHMENT_FILE_ICON,
  BACK_ICON as BACK,
  FILES_ICON,
  CLOSE_ICON,
  NEXT_ICON as NEXT,
  PREVIOUS_ICON as PREVIOUS,
} from "./icons.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { mountPdf, releasePdfs } from "./pdf-view.js";
import { backendFor } from "./backends/backend.js";
import { scrollToLatest } from "./conversation/controls.js";
import { drawOn } from "./image-preview/drawing.js";
import { installImageCommentLayout } from "./image-preview/comments-layout.js";
import {
  closeDrawingEditor,
  closeDrawingFromKeyboard,
  drawingEditorOpen,
} from "./image-preview/editor.js";
import { state } from "./state.js";
import { commentMount } from "./artifacts/artifact-state.js";
import {
  closeSelectionCommentFromKeyboard,
  handleCommentShortcut,
} from "./artifacts/selection-comments.js";
import {
  fetchPaneData,
  openPane,
  registerPane,
  sideWindowOpen,
  syncPanes,
} from "./panes.js";
import { panePowerbar, renderPowerbarControls } from "./panes/powerbar.js";
import { installBoxComments, touchDrewBox } from "./files/box-comments.js";
import {
  detailBody,
  detailHeader,
  downloadHref,
  DOWNLOAD_ICON,
  DRAW_ICON,
  drawImage,
  iconButton,
  imageHref,
  metaLine,
  previewTemplate,
  provideFilesStore,
  syncComments,
  syncDraw,
  textPreviewHref,
  unavailableLabel,
  urlImages,
  type DetailHost,
} from "./files/detail.js";
import { openFileTab, repaintFileTabs } from "./files/tab.js";
import {
  currentFilesRequest,
  ensureFilePreview,
  filesPaneAvailable,
  filesRefreshDue,
  mergeSessionFiles,
  retainFilePreview,
  selectedFile,
  SettledTurnFile,
  versionGroups,
  type FileSelection,
  type FilePreviewState,
  type SessionFile,
} from "./files/model.js";
import type { PaneContext, Turn } from "./types.js";

const PANE_ID = "files";
const BACK_ICON = unsafeHTML(BACK);
const PREVIOUS_ICON = unsafeHTML(PREVIOUS);
const NEXT_ICON = unsafeHTML(NEXT);
const FILES_PAGE_SIZE = 100;
const MAX_CLIENT_SOURCES = 40;
const MAX_CONVERSATION_CACHES = 12;
const MAX_TEXT_PREVIEW_CACHES = 24;

interface FilesPage {
  files: SessionFile[];
  cursor: string | null;
  generation: number;
  stale?: boolean;
  done: boolean;
  capped?: boolean;
}

interface CacheEntry {
  files: Map<string, SessionFile>;
  displayFiles: Map<string, SessionFile> | null;
  cursor: string | null;
  generation: number | null;
  initialized: boolean;
  complete: boolean;
  capped: boolean;
  inflight: boolean;
  pending?: Promise<void>;
  error: string | null;
  failedDeletion: SessionFile | null;
  request: number;
  controller: AbortController | null;
  previews: Map<string, FilePreviewState>;
  previewLru: string[];
  conversationVersion: string | null;
  lastRefresh: number;
  // A throttled running version still reloads at settle, including fast turns.
  refreshPending: boolean;
}

interface FilesEl extends DetailHost {
  _filesHash?: string;
  _filesObserver?: IntersectionObserver;
  _filesSwipe?: boolean;
}

const cache = new Map<string, CacheEntry>();
// The file whose detail view replaces the list, per conversation.
const selections = new Map<string, FileSelection>();
let paneEl: FilesEl | null = null;
let shownId: string | null = null;
let lastSelectedId: string | null = null;
const settledTurnFile = new SettledTurnFile();
let autoOpenProbe: string | null = null;
let popout: {
  dialog: HTMLDialogElement;
  body: FilesEl;
  cid: string;
  file: SessionFile;
  focus: HTMLElement | null;
  closeLayout: () => void;
} | null = null;

function closeImage(): void {
  if (!popout) return;
  const { dialog, body, focus, closeLayout } = popout;
  closeLayout();
  closeDrawingEditor();
  popout = null;
  body._filesObserver?.disconnect();
  if (commentMount.current === body) commentMount.current = null;
  const commentPopover = dialog.querySelector(".report-comment-popover");
  if (commentPopover) document.body.append(commentPopover);
  dialog.close();
  dialog.remove();
  focus?.focus({ preventScroll: true });
  if (history.state?.imagePopout) history.back();
  repaint();
}

/** Escape on the open image viewer: closes it and reports that it did. */
export function closeImageFromKeyboard(): boolean {
  if (!popout) return false;
  closeImage();
  return true;
}

window.addEventListener("popstate", () => {
  if (popout && drawingEditorOpen()) {
    history.pushState({ ...history.state, imagePopout: true }, "");
    closeDrawingFromKeyboard();
  } else closeImage();
});

function openImage(cid: string, file: SessionFile): void {
  const opening = !popout;
  if (!popout) {
    const dialog = document.createElement("dialog");
    dialog.className = "image-popout";
    dialog.setAttribute("aria-label", "Image viewer");
    const body = document.createElement("div") as FilesEl;
    body.className = "image-popout-body";
    popout = {
      dialog,
      body,
      cid,
      file,
      focus: document.activeElement as HTMLElement | null,
      closeLayout: installImageCommentLayout(body),
    };
    dialog.append(body);
    document.body.append(dialog);
    dialog.addEventListener("keydown", (event) =>
      handleCommentShortcut(event, body),
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!closeDrawingFromKeyboard() && !closeSelectionCommentFromKeyboard())
        closeImage();
    });
    let outside: { x: number; y: number } | null = null;
    dialog.addEventListener("pointerdown", (event) => {
      const target = event.target as Element;
      outside =
        target === dialog ||
        target.classList.contains("image-zoom-viewport") ||
        target === body
          ? { x: event.clientX, y: event.clientY }
          : null;
    });
    dialog.addEventListener("pointerup", (event) => {
      if (
        outside &&
        Math.hypot(event.clientX - outside.x, event.clientY - outside.y) >= 5
      )
        outside = null;
    });
    dialog.addEventListener("pointercancel", () => (outside = null));
    dialog.addEventListener("click", () => {
      if (outside) closeImage();
      outside = null;
    });
    installBoxComments(body);
    body.addEventListener("comments-submitting", () => {
      if (popout?.body !== body) return;
      closeImage();
      scrollToLatest();
    });
    installSwipe(body, (delta) => stepImage(delta));
    history.pushState({ ...history.state, imagePopout: true }, "");
    dialog.showModal();
  }
  popout.cid = cid;
  popout.file = file;
  renderImage();
  if (opening)
    popout.dialog
      .querySelector<HTMLButtonElement>('[aria-label="Close image"]')
      ?.focus({ preventScroll: true });
}

function imageGroups(cid: string, current: SessionFile): SessionFile[][] {
  const groups = versionGroups(allFiles(entry(cid)))
    .reverse()
    .filter(([file]) => file?.storage === "published" && imageHref(cid, file));
  return groups.some((group) => group.some((file) => file.key === current.key))
    ? groups
    : [[current]];
}

function stepImage(delta: -1 | 1): void {
  if (!popout) return;
  const groups = imageGroups(popout.cid, popout.file);
  const index = groups.findIndex((group) =>
    group.some((file) => file.key === popout!.file.key),
  );
  const next = groups[index + delta]?.[0];
  if (next) openImage(popout.cid, next);
}

function renderImage(): void {
  if (!popout) return;
  const { body, cid, file } = popout;
  const groups = imageGroups(cid, file);
  const index = groups.findIndex((group) =>
    group.some((candidate) => candidate.key === file.key),
  );
  render(
    html`<header class="viewer-topbar image-popout-bar">
        <span class="files-name" title=${file.name}>${file.name}</span>
        ${groups.length > 1
          ? html`${iconButton(
                "Previous image",
                PREVIOUS_ICON,
                () => stepImage(-1),
                "",
                index <= 0,
              )}
              <span class="files-position"
                >${index + 1} of ${groups.length}</span
              >
              ${iconButton(
                "Next image",
                NEXT_ICON,
                () => stepImage(1),
                "",
                index === groups.length - 1,
              )}`
          : nothing}
        ${downloadHref(cid, file)
          ? iconButton(
              "Download",
              DOWNLOAD_ICON,
              () => void downloadImage(cid, file),
            )
          : nothing}
        ${iconButton(
          "Draw",
          DRAW_ICON,
          (event) =>
            drawOn(drawImage(event.currentTarget as Element), closeImage),
          "files-draw",
        )}
        ${!allFiles(entry(cid)).some((listed) => listed.key === file.key)
          ? nothing
          : iconButton("Open in Files", unsafeHTML(FILES_ICON), () => {
              const open = () => {
                selections.set(cid, { key: file.key });
                if (paneEl) paneEl._filesHash = undefined;
                repaint();
                openPane(PANE_ID);
              };
              if (history.state?.imagePopout) {
                window.addEventListener("popstate", open, { once: true });
                closeImage();
              } else {
                closeImage();
                open();
              }
            })}
        ${iconButton("Close image", unsafeHTML(CLOSE_ICON), closeImage)}
      </header>
      <article
        class="files-detail"
        data-file-key=${file.key}
        aria-label=${file.name}
      >
        ${previewTemplate(cid, file, body)}
      </article>
      <aside class="image-comment-sidebar" aria-label="Image comments">
        <h2 class="image-comment-heading">Comments</h2>
        <div class="report-comments"></div>
        <div class="report-bar"></div>
      </aside>`,
    body,
  );
  const commentPopover = document.querySelector(".report-comment-popover");
  if (commentPopover)
    body.querySelector(".image-comment-sidebar")!.append(commentPopover);
  observePreviews(body, cid);
  syncComments(body, cid, file);
  syncDraw();
}

/** Watch the shown conversation's turns for one to open in the pane. */
export function noteTurns(cid: string, turns: readonly Turn[]): void {
  settledTurnFile.observe(cid, turns);
}

/** Rows for this conversation arrived from the server. */
export function noteRowsRead(cid: string): void {
  settledTurnFile.rowsRead(cid);
}

// The file to auto-open, once this conversation's listing can show it:
// undefined (unknown) holds the auto-open policy's decision until then.
function autoOpenGeneration(ctx: PaneContext): string | null | undefined {
  const id = settledTurnFile.current(ctx.agentId);
  if (!id) return null;
  const value = entry(ctx.agentId);
  if (value.error) return undefined;
  if (selectedFile(visibleFiles(value).values(), { id })) return id;
  // Invariant: An open pane reloads on its own; reloading here would cancel its
  // previews.
  if (paneEl?.isConnected && shownId === ctx.agentId) return undefined;
  if (!value.initialized || !value.complete) return undefined;
  if (autoOpenProbe === id) return null;
  autoOpenProbe = id;
  revalidate(value, value.generation);
  scheduleFetch(ctx.agentId);
  return undefined;
}

if (!document.getElementById("files-pane-css")) {
  const link = document.createElement("link");
  link.id = "files-pane-css";
  link.rel = "stylesheet";
  link.href = "/static/files.css";
  document.head.appendChild(link);
}

function entry(id: string): CacheEntry {
  let value = cache.get(id);
  if (value) {
    cache.delete(id);
    cache.set(id, value);
    return value;
  }
  while (cache.size >= MAX_CONVERSATION_CACHES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const removed = cache.get(oldest);
    if (removed) abandon(removed);
    cache.delete(oldest);
  }
  value = {
    files: new Map(),
    displayFiles: null,
    cursor: null,
    generation: null,
    initialized: false,
    complete: false,
    capped: false,
    inflight: false,
    error: null,
    failedDeletion: null,
    request: 0,
    controller: null,
    previews: new Map(),
    previewLru: [],
    conversationVersion: null,
    lastRefresh: 0,
    refreshPending: false,
  };
  cache.set(id, value);
  return value;
}

function visibleFiles(value: CacheEntry): Map<string, SessionFile> {
  return value.displayFiles ?? value.files;
}

function allFiles(value: CacheEntry): SessionFile[] {
  return [...visibleFiles(value).values()];
}

/** Open one attached file: its dock tab on desktop, else the detail view in
 * this conversation's Files pane. */
export async function showFileInPane(
  cid: string,
  attachmentId: string,
): Promise<void> {
  const value = entry(cid);
  let file = selectedFile(visibleFiles(value).values(), { id: attachmentId });
  if (!file && value.complete) revalidate(value, value.generation);
  while (!file && !value.complete && !value.error && cid === state.selectedId) {
    await loadPage(cid);
    file = selectedFile(visibleFiles(value).values(), { id: attachmentId });
  }
  if (cid !== state.selectedId) return;
  // Spec: With a side window up, an image opens in Files there, not popped out.
  if (file && imageHref(cid, file) && !sideWindowOpen())
    return openImage(cid, file);
  if (file && openFileTab(cid, file)) return;
  selections.set(cid, { id: attachmentId });
  if (paneEl?.isConnected && shownId === cid) {
    paneEl._filesHash = undefined;
    repaint();
  }
  openPane(PANE_ID);
}

function selectFile(cid: string, selection: FileSelection | null): void {
  const file = selection && selectedFile(allFiles(entry(cid)), selection);
  if (file && openFileTab(cid, file)) return;
  if (file && imageHref(cid, file)) return openImage(cid, file);
  if (selection) selections.set(cid, selection);
  else selections.delete(cid);
  repaint();
  if (paneEl)
    (selection ? panePowerbar(paneEl) : paneEl)
      .querySelector<HTMLElement>(selection ? ".files-back" : ".files-summary")
      ?.focus();
}

/** Navigate oldest to newest; return false at either end. */
function stepFile(cid: string, delta: -1 | 1): boolean {
  const all = allFiles(entry(cid));
  const selection = selections.get(cid);
  const shown = selection ? selectedFile(all, selection) : null;
  const groups = versionGroups(all).reverse();
  const index = shown ? groups.findIndex((group) => group.includes(shown)) : -1;
  const next = index < 0 ? null : groups[index + delta]?.[0];
  if (!next) return false;
  selections.set(cid, { key: next.key, latest: true });
  repaint();
  paneEl?.scrollTo({ top: 0 });
  return true;
}

document.addEventListener("keydown", (event) => {
  if (
    popout &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
    !(event.target as Element).closest("input, textarea, select")
  ) {
    stepImage(event.key === "ArrowLeft" ? -1 : 1);
    event.preventDefault();
    return;
  }
  const target = event.target as Element | null;
  if (
    (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !shownId ||
    !target?.closest?.('.pane-col[data-pane="files"]') ||
    target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  if (stepFile(shownId, event.key === "ArrowLeft" ? -1 : 1))
    event.preventDefault();
});

// Invariant: A horizontal swipe steps files only at normal zoom and only when
// no element under the finger scrolls sideways; pinch-zoomed drags pan.
function installSwipe(
  element: FilesEl,
  step: (delta: -1 | 1) => void = (delta) => {
    if (shownId) stepFile(shownId, delta);
  },
): void {
  let start: { x: number; y: number } | null = null;
  const scrollsSideways = (node: Element | null): boolean => {
    for (let at = node; at && at !== element; at = at.parentElement)
      if (at.scrollWidth > at.clientWidth + 1) return true;
    return false;
  };
  element.addEventListener(
    "touchstart",
    (event) => {
      const target = event.target as Element;
      start =
        event.touches.length === 1 &&
        (window.visualViewport?.scale ?? 1) <= 1.01 &&
        !target.closest('[data-zoomed="true"]') &&
        target.closest(".files-detail") &&
        !scrollsSideways(target)
          ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY }
          : null;
    },
    { passive: true },
  );
  element.addEventListener("touchcancel", () => (start = null));
  // Spec: A sideways trackpad swipe steps once per gesture, momentum included.
  let swept = 0;
  let sweptAt = 0;
  element.addEventListener(
    "wheel",
    (event) => {
      const target = event.target as Element;
      if (event.timeStamp - sweptAt > 250) swept = 0;
      sweptAt = event.timeStamp;
      if (
        swept === Infinity ||
        event.ctrlKey ||
        event.metaKey ||
        Math.abs(event.deltaX) <= Math.abs(event.deltaY) ||
        target.closest('[data-zoomed="true"]') ||
        !target.closest(".files-detail") ||
        scrollsSideways(target)
      )
        return;
      swept += event.deltaX;
      if (Math.abs(swept) < 60) return;
      step(swept > 0 ? 1 : -1);
      swept = Infinity;
    },
    { passive: true },
  );
  element.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      if (
        !start ||
        !touch ||
        touchDrewBox() ||
        (event.target as Element).closest('[data-zoomed="true"]')
      )
        return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      start = null;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy))
        step(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );
}

document.querySelector("#messages")?.addEventListener("click", (event) => {
  const image = (event.target as Element).closest?.("img");
  const match =
    image &&
    !image.closest("button, a") &&
    /^\/api\/conversations\/([\w-]+)\/attachments\/([\w.-]+)\/(?:preview|thumbnail)$/.exec(
      image.getAttribute("src") ?? "",
    );
  if (match && match[1] === state.selectedId)
    showFileInPane(match[1], match[2]!);
});

function abandon(value: CacheEntry): void {
  value.request++;
  value.controller?.abort();
  value.controller = null;
  value.inflight = false;
  for (const preview of value.previews.values()) {
    preview.controller?.abort();
    preview.controller = undefined;
    if (preview.status === "loading") preview.status = "idle";
  }
}

function reset(
  value: CacheEntry,
  generation: number | null = null,
  preservePreviews = false,
): void {
  abandon(value);
  value.files.clear();
  value.displayFiles = null;
  if (!preservePreviews) {
    value.previews.clear();
    value.previewLru = [];
  }
  value.cursor = null;
  value.generation = generation;
  value.initialized = false;
  value.complete = false;
  value.capped = false;
  value.error = null;
  value.refreshPending = false;
}

function revalidate(value: CacheEntry, generation: number | null): void {
  abandon(value);
  if (value.displayFiles === null && value.files.size)
    value.displayFiles = new Map(value.files);
  value.files.clear();
  value.cursor = null;
  value.generation = generation;
  value.complete = false;
  value.capped = false;
  value.error = null;
}

function repaint(): void {
  if (popout && popout.cid !== state.selectedId) closeImage();
  if (paneEl && shownId) renderPane(paneEl, shownId);
  syncPanes();
  renderImage();
  repaintFileTabs();
}

// The owned collection changed outside the conversation record (a
// completed upload or release): no poll version moves, so mark the entry
// owed and reload now when its pane is open. Closed panes reload on open
// through the version mismatch this leaves behind.
export function invalidateFiles(id: string): void {
  const value = cache.get(id);
  if (!value) return;
  value.conversationVersion = null;
  value.refreshPending = true;
  if (paneEl?.isConnected && shownId === id && !document.hidden) {
    revalidate(value, value.generation);
    void loadPage(id);
  }
}

function loadPage(id: string, signal?: AbortSignal): Promise<void> | void {
  const value = entry(id);
  if (value.inflight) return value.pending;
  if (value.complete || value.error || id === "__draft__") return;
  const controller = signal ? null : new AbortController();
  const activeSignal = signal || controller!.signal;
  const request = ++value.request;
  value.controller = controller;
  value.inflight = true;
  if (!value.cursor) value.lastRefresh = performance.now();
  const query = new URLSearchParams();
  if (value.initialized && value.cursor) query.set("cursor", value.cursor);
  if (value.generation !== null)
    query.set("generation", String(value.generation));
  query.set("limit", String(FILES_PAGE_SIZE));
  const url = `/api/conversations/${encodeURIComponent(id)}/files?${query}`;
  return (value.pending = backendFor(id)
    .api(url, { signal: activeSignal })
    .then(async (response) => {
      if (
        !currentFilesRequest(lastSelectedId || id, id, value.request, request)
      ) {
        // Invariant: An unread body holds its connection open; release it.
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) throw new Error(`files ${response.status}`);
      const page = (await response.json()) as FilesPage;
      if (
        !currentFilesRequest(lastSelectedId || id, id, value.request, request)
      )
        return;
      if (
        page.stale ||
        (value.generation !== null && value.generation !== page.generation)
      ) {
        revalidate(value, page.generation);
        if (
          !activeSignal.aborted &&
          !document.hidden &&
          paneEl?.isConnected &&
          shownId === id
        )
          void loadPage(id, activeSignal);
        return;
      }
      value.generation = page.generation;
      mergeSessionFiles(
        value.files,
        page.files || [],
        Number.POSITIVE_INFINITY,
        MAX_CLIENT_SOURCES,
      );
      value.cursor = page.cursor;
      value.capped = !!page.capped;
      value.complete = !!page.done || !page.cursor;
      value.initialized = true;
      value.error = null;
      value.displayFiles = null;
    })
    .catch(() => {
      if (request !== value.request) return;
      if (activeSignal.aborted) {
        if (!value.initialized) value.error = null;
        return;
      }
      value.error = value.displayFiles
        ? "Couldn’t refresh files. Showing the last loaded version."
        : value.initialized
          ? "Couldn’t load older files. Showing what loaded."
          : "Couldn’t load files.";
    })
    .finally(() => {
      if (request !== value.request) return;
      value.inflight = false;
      value.pending = undefined;
      value.controller = null;
      repaint();
      const selection = selections.get(id);
      if (
        selection &&
        !selectedFile(value.files.values(), selection) &&
        !value.complete &&
        !value.error &&
        paneEl?.isConnected &&
        shownId === id
      )
        requestAnimationFrame(() => void loadPage(id));
    }));
}

function conversationVersion(ctx: PaneContext): string | null {
  const conv = ctx.conv;
  if (!conv || conv.id !== ctx.agentId) return null;
  // Invariant: Status/version/tree stamps capture settle and between-poll
  // turns. Each distinct version reloads once; unchanged legacy message counts
  // do not prove no publication occurred.
  return [
    conv.message_log_generation ?? 0,
    conv.msg_count,
    conv.status,
    ctx.nodes[ctx.agentId]?.updated ?? 0,
    JSON.stringify(
      (conv.pending || []).map((message) => [
        message.id,
        message.attachment_ids,
        (message.attachments || []).map((file) => file.id),
      ]),
    ),
  ].join(":");
}

// Open panes read immediately; closed probes queue per agent and abort on
// switch. loadPage guards make completed repeat probes no-ops.
function scheduleFetch(id: string): void {
  if (!id || id === "__draft__") return;
  fetchPaneData(PANE_ID, id, (signal) => loadPage(id, signal));
}

function available(ctx: PaneContext): boolean {
  const id = ctx.agentId;
  const switched = lastSelectedId !== id;
  if (switched) {
    if (lastSelectedId) abandon(entry(lastSelectedId));
    lastSelectedId = id && id !== "__draft__" && ctx.node ? id : null;
  }
  if (!id || id === "__draft__" || !ctx.node) return false;
  const version = conversationVersion(ctx);
  if (version === null) return false;
  const value = entry(id);
  const paneOpen = paneEl?.isConnected && shownId === id;
  // Invariant: A selection boundary is a fresh opportunity to observe the owned
  // file collection. A completed empty (or stale) projection must not suppress
  // the next probe merely because conversation metadata did not change.
  if (switched && value.complete) revalidate(value, value.generation);
  // Invariant: Stale-while-revalidate like the Changes pane: a version move
  // resets the closed entry and its probe re-establishes availability, but a
  // matching version keeps its warm button while the probe converges the tail
  // pages. An open pane's refresh belongs to update(), never to this reset.
  if (!paneOpen && value.conversationVersion !== version) {
    reset(value, ctx.conv?.message_log_generation ?? null, true);
    value.conversationVersion = version;
  }
  // Invariant: Availability follows a snapshot or recorded error, never
  // optimism. Successful empty lists hide controls until version changes;
  // errors stay retryable.
  if (!paneOpen) scheduleFetch(id);
  return filesPaneAvailable(
    value.initialized,
    value.error,
    visibleFiles(value).size,
  );
}

function badge(ctx: PaneContext): string | number | null {
  const value = cache.get(ctx.agentId);
  if (!value?.initialized) return null;
  const count = visibleFiles(value).size;
  return value.complete && !value.capped ? count : `${count}+`;
}

async function downloadImage(cid: string, file: SessionFile): Promise<void> {
  const href = downloadHref(cid, file);
  if (!href) return;
  if (
    matchMedia("(pointer: coarse)").matches &&
    navigator.share &&
    navigator.canShare
  ) {
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error("Image download failed");
      const original = new File([await response.blob()], file.name, {
        type: file.media_type,
      });
      const files = [original];
      if (navigator.canShare({ files })) {
        await navigator.share({ files });
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.dataset.bytes = String(file.size);
  document.body.append(link);
  link.click();
  link.remove();
}

/** Open the image at `url` (from conversation `cid`) in the image viewer. */
export function viewImage(cid: string, name: string, url: string): void {
  const file: SessionFile = {
    key: `url:${url}`,
    storage: "published",
    name,
    size: 0,
    media_type: "image/*",
    preview: "image",
    references: 0,
    sources: [],
  };
  urlImages.set(file, url);
  openImage(cid, file);
}

function retainPreview(id: string, key: string): void {
  const value = entry(id);
  // Invariant: Previews on screen (the pane's detail, dock tabs) stay loaded.
  const shown = new Set(
    [
      ...document.querySelectorAll<HTMLElement>(".files-detail[data-file-key]"),
    ].map((detail) => detail.dataset.fileKey!),
  );
  value.previewLru = retainFilePreview(
    value.previews,
    value.previewLru,
    key,
    MAX_TEXT_PREVIEW_CACHES,
    shown,
  );
}

function reloadPreview(id: string, key: string): void {
  const value = entry(id);
  const preview = ensureFilePreview(value.previews, key);
  preview.status = "idle";
  preview.text = undefined;
  preview.truncated = undefined;
  preview.relatedFiles = undefined;
  value.previewLru = value.previewLru.filter((candidate) => candidate !== key);
  repaint();
}

function loadTextPreview(id: string, file: SessionFile): void {
  const value = entry(id);
  const preview = ensureFilePreview(value.previews, file.key);
  const href = textPreviewHref(id, file);
  if (!href || preview.status !== "idle") return;
  const controller = new AbortController();
  preview.status = "loading";
  preview.controller = controller;
  backendFor(id)
    .api(href, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("preview unavailable");
      const payload = (await response.json()) as {
        kind?: unknown;
        text?: unknown;
        truncated?: unknown;
        related_files?: Record<string, unknown>;
      };
      if (value.previews.get(file.key) !== preview) return;
      if (payload.kind !== "text" || typeof payload.text !== "string")
        throw new Error("invalid preview");
      preview.status = "ready";
      preview.text = payload.text;
      preview.truncated = payload.truncated === true;
      preview.relatedFiles =
        payload.related_files === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(payload.related_files).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string" &&
                  /^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(entry[1]),
              ),
            );
      retainPreview(id, file.key);
    })
    .catch(() => {
      if (!controller.signal.aborted) preview.status = "missing";
    })
    .finally(() => {
      preview.controller = undefined;
      repaint();
    });
}

async function deleteFile(cid: string, file: SessionFile): Promise<boolean> {
  const href = downloadHref(cid, file);
  if (!href) return false;
  if (!confirm(`Delete ${file.name}? This cannot be undone.`)) return false;
  const value = entry(cid);
  try {
    const response = await backendFor(cid).api(href, { method: "DELETE" });
    if (!response.ok) throw new Error(`delete ${response.status}`);
  } catch {
    value.failedDeletion = file;
    repaint();
    return false;
  }
  if (value.failedDeletion?.key === file.key) value.failedDeletion = null;
  value.files.delete(file.key);
  value.displayFiles?.delete(file.key);
  value.previews.delete(file.key);
  value.previewLru = value.previewLru.filter(
    (candidate) => candidate !== file.key,
  );
  repaint();
  return true;
}

provideFilesStore({
  listing(cid) {
    const value = entry(cid);
    return {
      files: allFiles(value),
      complete: value.complete,
      error: value.error,
      failedDeletion: value.failedDeletion,
    };
  },
  loadMore(cid) {
    entry(cid).error = null;
    void loadPage(cid);
  },
  preview: (cid, key) => cache.get(cid)?.previews.get(key),
  loadPreview: loadTextPreview,
  reloadPreview,
  openImage,
  deleteFile,
  repaint,
});

const backButton = (cid: string) =>
  iconButton("All files", BACK_ICON, () => selectFile(cid, null), "files-back");

// Previous and next file over the pane's detail view, oldest to newest.
function fileNav(cid: string, index: number, total: number): unknown {
  if (total < 2) return nothing;
  return html`<div class="files-nav">
    ${iconButton(
      "Previous file",
      PREVIOUS_ICON,
      () => stepFile(cid, -1),
      "files-previous",
      index === 0,
    )}
    <span class="files-position">${index + 1} of ${total}</span>
    ${iconButton(
      "Next file",
      NEXT_ICON,
      () => stepFile(cid, 1),
      "files-next",
      index === total - 1,
    )}
  </div>`;
}

// The whole row, including thumbnail, opens the file: a dock tab on desktop.
// The detail view replaces the list on phones.
function rowTemplate(
  cid: string,
  file: SessionFile,
  versions: SessionFile[],
): TemplateResult {
  const unavailable = unavailableLabel(file);
  const count = versions.length > 1 ? `${versions.length} versions` : "";
  return html`<article
    class="files-card"
    data-file-key=${file.key}
    aria-label=${file.name}
    role="listitem"
  >
    ${file.preview === "image" && !unavailable
      ? html`<span
          class="files-thumb"
          @click=${() => selectFile(cid, { key: file.key, latest: true })}
          >${previewTemplate(cid, file)}</span
        >`
      : html`<span class="files-kind" aria-hidden="true"
          >${unsafeHTML(ATTACHMENT_FILE_ICON)}</span
        >`}
    <button
      class="files-open"
      type="button"
      title=${file.name}
      aria-label=${`Open ${file.name}`}
      @click=${() => selectFile(cid, { key: file.key, latest: true })}
    >
      <span class="files-name">${file.name}</span>
      <span class="files-meta"
        >${metaLine(file, [count, unavailable ?? ""])}</span
      >
    </button>
  </article>`;
}

function observePreviews(element: FilesEl, id: string): void {
  element._filesObserver?.disconnect();
  const observer = new IntersectionObserver(
    (entries) => {
      if (shownId !== id && popout?.cid !== id) return;
      for (const observation of entries) {
        if (!observation.isIntersecting) continue;
        const target = observation.target as HTMLElement;
        if (target.dataset.filesText) {
          const file = visibleFiles(entry(id)).get(target.dataset.filesText);
          if (file) loadTextPreview(id, file);
        }
        observer.unobserve(target);
      }
    },
    { root: element, rootMargin: "160px 0px" },
  );
  element._filesObserver = observer;
  for (const target of element.querySelectorAll<HTMLElement>(
    "[data-files-text]",
  ))
    observer.observe(target);
}

function renderPane(element: FilesEl, id: string): void {
  const value = entry(id);
  const all = allFiles(value);
  const groups = versionGroups(all);
  const files = groups.map((group) => group[0]!);
  const selection = selections.get(id) ?? null;
  let shown = selection ? selectedFile(all, selection) : null;
  if (shown && selection?.latest)
    shown = groups.find((group) => group.includes(shown!))![0]!;
  // Invariant: A list click names a loaded row; a reply attachment may name one
  // whose row is still loading. Once loading finishes without it, show the
  // list.
  if (selection && !shown && value.complete) selections.delete(id);
  const hash = JSON.stringify({
    id,
    shown: shown?.key ?? (selections.has(id) ? "pending" : null),
    initialized: value.initialized,
    complete: value.complete,
    capped: value.capped,
    inflight: value.inflight,
    error: value.error,
    failedDeletion: value.failedDeletion?.key,
    files: all.map((file) => [
      file.key,
      file.references,
      file.sources.map((source) => [source.offset, source.message_id]),
      value.previews.get(file.key)?.status,
      value.previews.get(file.key)?.truncated,
    ]),
  });
  // Invariant: Another pane may have taken selection comments since the last
  // paint, so an unchanged view still reclaims them.
  if (element._filesHash === hash)
    return syncComments(element, id, selections.has(id) ? shown : null);
  element._filesHash = hash;
  element._markdownAbort?.abort();
  if (!shown) renderPowerbarControls(element, nothing);
  const status = !value.initialized
    ? html`<div class="files-state" role="status">Loading files…</div>`
    : !files.length && value.complete
      ? html`<div class="files-state">No files in this conversation.</div>`
      : nothing;
  const errorBanner =
    value.failedDeletion || value.error
      ? html`<div class="files-error" role="alert">
          ${value.failedDeletion
            ? `Couldn’t delete ${value.failedDeletion.name}.`
            : value.error}
          <button
            class="btn sm"
            type="button"
            @click=${() => {
              if (value.failedDeletion)
                void deleteFile(id, value.failedDeletion);
              else {
                value.error = null;
                void loadPage(id);
              }
            }}
          >
            Retry
          </button>
        </div>`
      : nothing;
  if (selections.has(id)) {
    const versions = groups.find((group) => group.includes(shown!)) ?? [];
    if (shown)
      renderPowerbarControls(
        element,
        detailHeader(id, shown, versions, {
          back: backButton(id),
          pick: (key) => {
            selections.set(id, { key, latest: key === versions[0]?.key });
            repaint();
          },
        }),
        true,
      );
    const index = groups.length - 1 - groups.indexOf(versions);
    render(
      shown
        ? html`${errorBanner}${detailBody(
            id,
            shown,
            element,
            fileNav(id, index, groups.length),
          )}`
        : value.error
          ? html`${backButton(id)}${errorBanner}`
          : html`<div class="files-state" role="status">Loading file…</div>`,
      element,
    );
    releasePdfs();
    for (const view of element.querySelectorAll<HTMLElement>(
      "[data-files-pdf]",
    ))
      mountPdf(view, view.dataset.filesPdf!);
    syncDraw();
    syncComments(element, id, shown);
    requestAnimationFrame(() => {
      if (shownId === id) observePreviews(element, id);
    });
    return;
  }
  syncComments(element, id, null);
  render(
    html`<div
        class="files-summary"
        role="status"
        aria-live="polite"
        tabindex="-1"
      >
        ${value.initialized
          ? `${files.length}${value.complete && !value.capped ? "" : "+"} file${files.length === 1 ? "" : "s"}`
          : "Loading files…"}
      </div>
      ${errorBanner} ${status}
      ${value.capped
        ? html`<div class="files-error" role="status">
            Some files could not be listed.
          </div>`
        : nothing}
      ${files.length
        ? html`<div class="files-grid" role="list">
            ${repeat(
              groups,
              (group) => group[0]!.key,
              (group) => rowTemplate(id, group[0]!, group),
            )}
          </div>`
        : nothing}
      ${value.initialized && !value.complete && !value.inflight && !value.error
        ? html`<button
            class="btn sm files-load-more"
            type="button"
            @click=${() => void loadPage(id)}
          >
            Load older files
          </button>`
        : nothing}`,
    element,
  );
  releasePdfs();
  requestAnimationFrame(() => {
    if (shownId === id) observePreviews(element, id);
  });
}

function update(element: FilesEl, ctx: PaneContext, opened = false): void {
  const id = ctx.agentId;
  const value = entry(id);
  const version = conversationVersion(ctx);
  const running = ctx.conv?.status === "running";
  const changed = value.conversationVersion !== version;
  // Invariant: A change throttled away while running is still owed: the settle
  // poll consumes it, so a fast turn never slips through between polls.
  if (changed && running) value.refreshPending = true;
  const refresh =
    !document.hidden &&
    version !== null &&
    (opened ||
      shownId !== id ||
      (!value.inflight &&
        filesRefreshDue(
          running,
          changed || value.refreshPending,
          value.lastRefresh,
          performance.now(),
        )));
  if (refresh) {
    if (value.initialized)
      revalidate(value, ctx.conv?.message_log_generation ?? null);
    value.conversationVersion = version;
    value.refreshPending = false;
  }
  if (shownId !== id) {
    if (shownId) abandon(entry(shownId));
    shownId = id;
  }
  paneEl = element;
  if (!element._filesSwipe) {
    element._filesSwipe = true;
    installSwipe(element);
    installBoxComments(element);
    element.addEventListener("recurse:pdf-pages", repaint);
  }
  renderPane(element, id);
  if (!document.hidden && (!value.initialized || refresh)) void loadPage(id);
}

registerPane({
  id: PANE_ID,
  title: "Files",
  icon: FILES_ICON,
  available,
  visit: (agentId) => settledTurnFile.beginVisit(agentId),
  autoOpenGeneration,
  autoOpened(ctx) {
    const id = settledTurnFile.current(ctx.agentId);
    if (id) selections.set(ctx.agentId, { id, latest: true });
  },
  badge,
  cache: {
    version: 1,
    key: (ctx) => ctx.agentId,
    resume(element, ctx) {
      update(element as FilesEl, ctx, true);
    },
    dispose(element) {
      const files = element as FilesEl;
      files._filesObserver?.disconnect();
      files._markdownAbort?.abort();
      releasePdfs(files);
      if (paneEl === element) paneEl = null;
      if (commentMount.current === element) commentMount.current = null;
    },
  },
  render(element, ctx) {
    update(element as FilesEl, ctx, true);
  },
  refresh(element, ctx) {
    update(element as FilesEl, ctx);
  },
});
