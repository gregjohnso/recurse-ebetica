// Files dock tabs: on desktop a file clicked in the Files list opens in its own
// dock tab, keyed by the file's stable key so a saved layout restores it. A
// tab shows the detail view (./detail.ts) under its own header; while the
// listing reloads it keeps the last listed copy, and a file no longer listed
// says so with a way to close the tab.
import { html, nothing, render } from "lit";
import { mountPdf, releasePdfs } from "../pdf-view.js";
import {
  closeDockPanel,
  openDockPanel,
  registerDockPanelKind,
} from "../panes.js";
import { DRAFT, state } from "../state.js";
import { commentMount } from "../artifacts/artifact-state.js";
import { installBoxComments } from "./box-comments.js";
import {
  detailBody,
  detailHeader,
  filesStore,
  syncComments,
  syncDraw,
  type DetailHost,
} from "./detail.js";
import { versionGroups, type SessionFile } from "./model.js";

const FILES_TAB = "files:";

interface FileTab {
  id: string;
  cid: string;
  /** The version shown; the version menu changes it. */
  key: string;
  element: DetailHost;
  /** The last listed copy, kept while the listing reloads. */
  shown: SessionFile | null;
  hash?: string;
  loading?: number;
  /** Loads the text preview once the tab shows it. */
  observer?: IntersectionObserver;
}

const tabs = new Map<string, FileTab>();

/** Open `file` in its own dock tab, focusing an open one; false without a
 * dock (phones), where the Files pane shows it instead. */
export function openFileTab(cid: string, file: SessionFile): boolean {
  const id = FILES_TAB + file.key;
  const tab = tabs.get(id);
  if (tab?.cid === cid) tab.key = file.key;
  if (!openDockPanel(id, file.name, file.name)) return false;
  const opened = tabs.get(id);
  if (opened) paint(opened);
  return true;
}

/** Repaint every open Files tab after the Files cache changed. */
export function repaintFileTabs(): void {
  for (const tab of tabs.values()) paint(tab);
}

function paint(tab: FileTab): void {
  const store = filesStore();
  const { files, complete, error, failedDeletion } = store.listing(tab.cid);
  const listed = files.find((file) => file.key === tab.key) ?? null;
  if (listed || complete) tab.shown = listed;
  const file = tab.shown;
  if (!listed && !complete && !error && !tab.loading)
    tab.loading = requestAnimationFrame(() => {
      tab.loading = undefined;
      if (tabs.get(tab.id) === tab && tab.cid === state.selectedId)
        store.loadMore(tab.cid);
    });
  const preview = file ? store.preview(tab.cid, file.key) : undefined;
  const versions = file
    ? (versionGroups(files).find((group) => group.includes(file)) ?? [file])
    : [];
  const deleteFailed = !!file && failedDeletion?.key === file.key;
  const hash = JSON.stringify([
    file && [file.key, file.references, file.sources, file.unavailable],
    versions.map((version) => version.key),
    preview && [preview.status, preview.truncated],
    file ? deleteFailed : [complete, error],
  ]);
  const element = tab.element;
  if (tab.hash !== hash) {
    tab.hash = hash;
    element._markdownAbort?.abort();
    render(
      file
        ? detail(tab, file, versions, deleteFailed)
        : missing(tab, complete, error),
      element,
    );
    releasePdfs();
    for (const view of element.querySelectorAll<HTMLElement>(
      "[data-files-pdf]",
    ))
      mountPdf(view, view.dataset.filesPdf!);
    syncDraw();
    tab.observer?.disconnect();
    const placeholder = element.querySelector("[data-files-text]");
    if (file && placeholder) {
      tab.observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        tab.observer?.disconnect();
        store.loadPreview(tab.cid, file);
      });
      tab.observer.observe(placeholder);
    }
    // Invariant: Lit fills a diff in a microtask after render; comments anchor
    // to it on the next frame.
    requestAnimationFrame(() => {
      if (tabs.get(tab.id) === tab) syncComments(element, tab.cid, tab.shown);
    });
  }
  syncComments(element, tab.cid, file);
}

function detail(
  tab: FileTab,
  file: SessionFile,
  versions: SessionFile[],
  deleteFailed: boolean,
) {
  const store = filesStore();
  return html`${detailHeader(tab.cid, file, versions, {
    pick: (key) => {
      tab.key = key;
      paint(tab);
    },
    deleted: () => closeDockPanel(tab.id),
  })}
  ${deleteFailed
    ? html`<div class="files-error" role="alert">
        Couldn’t delete ${file.name}.
        <button
          class="btn sm"
          type="button"
          @click=${async () => {
            if (await store.deleteFile(tab.cid, file)) closeDockPanel(tab.id);
          }}
        >
          Retry
        </button>
      </div>`
    : nothing}
  ${detailBody(tab.cid, file, tab.element)}`;
}

function missing(tab: FileTab, complete: boolean, error: string | null) {
  if (error)
    return html`<div class="files-error" role="alert">
      ${error}
      <button
        class="btn sm"
        type="button"
        @click=${() => filesStore().loadMore(tab.cid)}
      >
        Retry
      </button>
    </div>`;
  if (!complete)
    return html`<div class="files-state" role="status">Loading file…</div>`;
  return html`<div class="files-state" role="status">
    This file is no longer in this conversation.
    <button class="btn sm" type="button" @click=${() => closeDockPanel(tab.id)}>
      Close tab
    </button>
  </div>`;
}

registerDockPanelKind(FILES_TAB, (id, cid) => {
  if (!cid || cid === DRAFT) return null;
  const element: DetailHost = document.createElement("div");
  element.className = "files-tab";
  const tab: FileTab = {
    id,
    cid,
    key: id.slice(FILES_TAB.length),
    element,
    shown: null,
  };
  tabs.set(id, tab);
  installBoxComments(element);
  element.addEventListener("recurse:pdf-pages", () =>
    syncComments(element, cid, tab.shown),
  );
  paint(tab);
  return {
    element,
    dispose() {
      if (tabs.get(id) === tab) tabs.delete(id);
      if (tab.loading) cancelAnimationFrame(tab.loading);
      tab.observer?.disconnect();
      element._markdownAbort?.abort();
      releasePdfs(element);
      if (commentMount.current === element) commentMount.current = null;
      render(nothing, element);
    },
  };
});
