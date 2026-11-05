// The Explorer pane shows a read-only tree of the conversation's work folder.
// A clicked file opens in a dock tab on desktop, else previews below the tree.
// Folders load lazily on expand and re-read on Refresh, opening the pane, a
// settled turn or a changed cwd (no watcher).
import { html, nothing, render, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { DISCLOSURE_ICON, EXPLORER_ICON, REFRESH_ICON } from "./icons.js";
import {
  closeDockPanel,
  openDockPanel,
  registerDockPanelKind,
  registerPane,
  togglePane,
} from "./panes.js";
import { DRAFT, state } from "./state.js";
import { UI_REFRESH_EVENT } from "./ui-events.js";
import {
  closePreview,
  createFilePreview,
  openPreview,
  previewHost,
  previewShown,
} from "./explorer/preview.js";
import {
  absolutePath,
  baseName,
  changedFolders,
  changeMarks,
  copyPath,
  insertPath,
  joinPath,
  loadListing,
  onExplorerChange,
  parentPath,
  refreshTree,
  setExpanded,
  showChanges,
  treeFor,
  type ChangeMark,
  type ExplorerEntry,
  type ExplorerTree,
} from "./explorer/state.js";

const PANE_ID = "explorer";

interface Row {
  path: string;
  depth: number;
  entry?: ExplorerEntry;
  note?: string;
}

const view = document.createElement("section");
view.id = "explorer";
view.setAttribute("aria-label", "Explorer");
const menu = document.createElement("div");
menu.id = "explorer-menu";
menu.className = "menu";
menu.setAttribute("role", "menu");
menu.hidden = true;
document.body.append(menu);

let shownCid: string | null = null;
let rows: Row[] = [];

/** The conversation the Explorer shows, or null for the draft or none. */
function explorerCid(): string | null {
  const id = state.selectedId;
  return id && id !== DRAFT ? id : null;
}

/** E: open or close the Explorer pane, focusing its tree when opened. */
export function toggleExplorer(): void {
  if (togglePane(PANE_ID))
    requestAnimationFrame(() =>
      view.querySelector<HTMLElement>(".explorer-row[tabindex='0']")?.focus(),
    );
}

function flatten(tree: ExplorerTree): Row[] {
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = tree.listings.get(dir);
    if (!listing || listing.status === "loading") {
      out.push({ path: `${dir}\0loading`, depth, note: "Loading…" });
      return;
    }
    if (listing.status === "error") {
      out.push({ path: `${dir}\0error`, depth, note: listing.detail });
      return;
    }
    if (!listing.entries.length && !listing.more && depth === 0)
      out.push({ path: `${dir}\0empty`, depth, note: "This folder is empty." });
    for (const entry of listing.entries) {
      const path = joinPath(dir, entry.name);
      out.push({ path, depth, entry });
      if (entry.type === "directory" && tree.expanded.has(path))
        walk(path, depth + 1);
    }
    if (listing.more)
      out.push({
        path: `${dir}\0more`,
        depth,
        note: listing.moreExact
          ? `+${listing.more} more not shown`
          : `+${listing.more} or more not shown`,
      });
  };
  walk("", 0);
  return out;
}

function rowTemplate(
  tree: ExplorerTree,
  row: Row,
  marks: Map<string, ChangeMark>,
  folders: Set<string>,
): TemplateResult {
  const indent = styleMap({ "--explorer-depth": String(row.depth) });
  if (!row.entry)
    return html`<div
      class="explorer-row explorer-note"
      role="none"
      style=${indent}
    >
      ${row.note}
    </div>`;
  const entry = row.entry;
  const directory = entry.type === "directory";
  const open = directory && tree.expanded.has(row.path);
  const mark = marks.get(row.path);
  const title = [
    row.path,
    entry.symlink ? "symbolic link (not followed)" : "",
    entry.ignored ? "ignored by Git" : "",
    entry.credential ? "contents not shown" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return html`<div
    class="explorer-row ${entry.ignored ? "ignored" : ""} ${entry.symlink
      ? "symlink"
      : ""} ${tree.selected === row.path ? "selected" : ""}"
    role="treeitem"
    data-path=${row.path}
    aria-level=${row.depth + 1}
    aria-expanded=${directory ? String(open) : nothing}
    aria-selected=${String(tree.cursor === row.path)}
    tabindex=${tree.cursor === row.path ? "0" : "-1"}
    title=${title}
    style=${indent}
    @click=${() => activateRow(tree, row)}
    @contextmenu=${(event: MouseEvent) => {
      event.preventDefault();
      tree.cursor = row.path;
      openMenu(tree, row, event.clientX, event.clientY);
    }}
  >
    <span class="explorer-twisty ${open ? "open" : ""}" aria-hidden="true"
      >${directory ? unsafeHTML(DISCLOSURE_ICON) : nothing}</span
    >
    <span class="explorer-name">${entry.name}${entry.symlink ? " ↗" : ""}</span>
    ${mark
      ? html`<span class="explorer-badge mark-${mark.mark}">${mark.mark}</span>`
      : directory && folders.has(row.path)
        ? html`<span class="explorer-badge folder-dot" aria-hidden="true"
            >•</span
          >`
        : nothing}
  </div>`;
}

function paint(): void {
  if (!view.isConnected) return;
  const cid = explorerCid();
  if (!cid) {
    rows = [];
    render(
      html`<div class="explorer-head">
          <span class="explorer-title">Explorer</span>
        </div>
        <p class="explorer-empty">
          Open an agent to browse its working folder.
        </p>`,
      view,
    );
    return;
  }
  const tree = treeFor(cid);
  if (shownCid !== cid) {
    shownCid = cid;
    if (!tree.listings.has("")) void loadListing(tree, "");
  }
  rows = flatten(tree);
  if (!rows.some((row) => row.entry && row.path === tree.cursor))
    tree.cursor = rows.find((row) => row.entry)?.path ?? "";
  const marks = changeMarks(cid, tree.prefix);
  const folders = changedFolders(marks);
  render(
    html`<div class="explorer-head">
        <span class="explorer-title" title=${tree.root ?? ""}
          >${tree.root ? baseName(tree.root) || tree.root : "Explorer"}</span
        >
        <button
          class="icon-btn explorer-refresh"
          type="button"
          title="Refresh"
          aria-label="Refresh files"
          @click=${() => void refreshTree(tree)}
        >
          ${unsafeHTML(REFRESH_ICON)}
        </button>
      </div>
      <div
        class="explorer-tree"
        role="tree"
        aria-label=${`Files in ${tree.root ?? "the working folder"}`}
        @keydown=${(event: KeyboardEvent) => handleExplorerKey(event)}
      >
        ${repeat(
          rows,
          (row) => row.path,
          (row) => rowTemplate(tree, row, marks, folders),
        )}
      </div>
      ${previewShown(cid) ? previewHost() : nothing}`,
    view,
  );
  view.classList.toggle("previewing", previewShown(cid));
}

function activateRow(tree: ExplorerTree, row: Row, toChild = false): void {
  const entry = row.entry;
  if (!entry) return;
  tree.cursor = row.path;
  if (entry.type === "directory") {
    const open = tree.expanded.has(row.path);
    if (toChild && open) {
      const index = rows.indexOf(row);
      const child = rows[index + 1];
      if (child?.entry && child.depth > row.depth) tree.cursor = child.path;
      paint();
    } else setExpanded(tree, row.path, toChild || !open);
  } else if (entry.type === "file") openFile(tree.cid, row.path);
  else paint();
  focusCursor();
}

const FILE_TAB = "file:";

/** Open `path` in a dock tab (focusing an open one), else preview it inline. */
function openFile(cid: string, path: string): void {
  treeFor(cid).selected = path;
  if (openDockPanel(FILE_TAB + path, baseName(path), path)) {
    closePreview();
    paint();
  } else void openPreview(cid, path);
}

registerDockPanelKind(FILE_TAB, (id, agentId) => {
  if (agentId === DRAFT) return null;
  const path = id.slice(FILE_TAB.length);
  const preview = createFilePreview(agentId, {
    close: () => closeDockPanel(id),
    link: (next) => openFile(agentId, next),
    comments: true,
  });
  void preview.open(path);
  return preview;
});

function focusCursor(): void {
  requestAnimationFrame(() => {
    const cid = explorerCid();
    if (!cid) return;
    view
      .querySelector<HTMLElement>(
        `.explorer-row[data-path="${CSS.escape(treeFor(cid).cursor)}"]`,
      )
      ?.focus({ preventScroll: false });
  });
}

/** Explorer keys while focus is in its tree; true when the key was used. */
export function handleExplorerKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
    return false;
  const cid = explorerCid();
  if (!cid || !view.contains(event.target as Node)) return false;
  const tree = treeFor(cid);
  const navigable = rows.filter((row) => row.entry);
  const index = navigable.findIndex((row) => row.path === tree.cursor);
  const row = navigable[index];
  const move = (delta: number) => {
    const next =
      navigable[Math.max(0, Math.min(navigable.length - 1, index + delta))];
    if (next) tree.cursor = next.path;
    paint();
    focusCursor();
  };
  switch (event.key) {
    case "ArrowDown":
    case "j":
      move(1);
      break;
    case "ArrowUp":
    case "k":
      move(-1);
      break;
    case "Enter":
    case "l":
    case "ArrowRight":
      if (row) activateRow(tree, row, event.key !== "Enter");
      break;
    case "h":
    case "ArrowLeft":
      if (row?.entry?.type === "directory" && tree.expanded.has(row.path))
        setExpanded(tree, row.path, false);
      else if (row && parentPath(row.path)) tree.cursor = parentPath(row.path);
      paint();
      focusCursor();
      break;
    case "ContextMenu":
    case "F10": {
      if (event.key === "F10" && !event.shiftKey) return false;
      const element = view.querySelector<HTMLElement>(
        ".explorer-row[tabindex='0']",
      );
      const box = element?.getBoundingClientRect();
      if (row && box) openMenu(tree, row, box.left + 24, box.bottom);
      break;
    }
    default:
      return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function closeMenu(): void {
  if (menu.hidden) return;
  menu.hidden = true;
  focusCursor();
}

function openMenu(tree: ExplorerTree, row: Row, x: number, y: number): void {
  const path = row.path;
  const mark = changeMarks(tree.cid, tree.prefix).get(path);
  const item = (label: string, run: () => void) =>
    html`<button
      class="menu-item"
      role="menuitem"
      type="button"
      @click=${() => {
        menu.hidden = true;
        run();
      }}
    >
      ${label}
    </button>`;
  render(
    html`${item("Copy path", () => void copyPath(absolutePath(tree, path)))}
    ${item("Copy relative path", () => void copyPath(path))}
    ${item("Insert path into message", () => insertPath(path))}
    ${mark ? item("Show changes", () => showChanges(mark.diffPath)) : nothing}`,
    menu,
  );
  menu.hidden = false;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - height))}px`;
  menu.querySelector<HTMLElement>("button")?.focus();
  paint();
}

menu.addEventListener("keydown", (event) => {
  const items = [...menu.querySelectorAll<HTMLElement>("button")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Escape") closeMenu();
  else if (event.key === "ArrowDown" || event.key === "j")
    items[(at + 1) % items.length]?.focus();
  else if (event.key === "ArrowUp" || event.key === "k")
    items[(at - 1 + items.length) % items.length]?.focus();
  else return;
  event.preventDefault();
  event.stopPropagation();
});
document.addEventListener("pointerdown", (event) => {
  if (!menu.contains(event.target as Node)) menu.hidden = true;
});

function mount(element: HTMLElement): void {
  if (view.parentElement !== element) element.replaceChildren(view);
  paint();
}

onExplorerChange(paint);
window.addEventListener(UI_REFRESH_EVENT, (event: Event) => {
  const id = (event as CustomEvent<{ agentId?: unknown }>).detail?.agentId;
  if (typeof id === "string" && id === explorerCid() && view.isConnected)
    void refreshTree(treeFor(id));
});

registerPane({
  id: PANE_ID,
  title: "Explorer",
  icon: EXPLORER_ICON,
  order: -1,
  available: (ctx) => ctx.agentId !== DRAFT && !!ctx.node,
  visit: (agentId) => closePreview(agentId),
  render(element) {
    const cid = explorerCid();
    const tree = cid ? treeFor(cid) : null;
    if (tree?.listings.has("")) void refreshTree(tree);
    mount(element);
  },
  refresh: mount,
  leave() {
    menu.hidden = true;
  },
});
