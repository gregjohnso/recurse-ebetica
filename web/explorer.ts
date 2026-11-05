// The left activity bar switches the sidebar between Agents and a read-only
// Explorer of the open conversation's working directory; the choice persists.
// Folders load lazily on expand and re-read on Refresh, a settled turn or a
// changed cwd (no watcher). Phones switch views from the agent list header.
import { html, nothing, render, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { $ } from "./dom.js";
import {
  AGENTS_ICON,
  DISCLOSURE_ICON,
  EXPLORER_ICON,
  REFRESH_ICON,
} from "./icons.js";
import { DRAFT, state } from "./state.js";
import { focusAgentTree } from "./sidebar.js";
import { UI_REFRESH_EVENT } from "./ui-events.js";
import { onPaneSync, openPreview } from "./explorer/preview.js";
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

type View = "agents" | "explorer";
const VIEW_KEY = "recurse.sidebarView";

interface Row {
  path: string;
  depth: number;
  entry?: ExplorerEntry;
  note?: string;
}

const sidebar = $("#sidebar")!;
const agentList = $("#agent-list")!;
const bar = document.createElement("nav");
bar.id = "activity-bar";
bar.setAttribute("aria-label", "Sidebar views");
sidebar.before(bar);
const view = document.createElement("section");
view.id = "explorer";
view.setAttribute("aria-label", "Explorer");
agentList.after(view);
const phoneToggle = document.createElement("button");
phoneToggle.id = "explorer-toggle";
phoneToggle.className = "icon-btn lg";
phoneToggle.type = "button";
$("#agent-list-actions")?.prepend(phoneToggle);
const menu = document.createElement("div");
menu.id = "explorer-menu";
menu.className = "menu";
menu.setAttribute("role", "menu");
menu.hidden = true;
document.body.append(menu);

let current: View = "agents";
try {
  if (localStorage.getItem(VIEW_KEY) === "explorer") current = "explorer";
} catch {}
let shownCid: string | null = null;
let rows: Row[] = [];

/** The conversation the Explorer shows, or null for the draft or none. */
function explorerCid(): string | null {
  const id = state.selectedId;
  return id && id !== DRAFT ? id : null;
}

export function explorerVisible(): boolean {
  return current === "explorer";
}

function setView(next: View): void {
  current = next;
  try {
    localStorage.setItem(VIEW_KEY, next);
  } catch {}
  const cid = explorerCid();
  if (next === "explorer" && cid && treeFor(cid).listings.has(""))
    void refreshTree(treeFor(cid));
  paint();
}

/** E: switch views, showing the sidebar and focusing the chosen view. */
export function toggleExplorer(): void {
  setView(current === "explorer" ? "agents" : "explorer");
  if (sidebar.classList.contains("desktop-hidden"))
    $<HTMLButtonElement>("#menu-btn")?.click();
  if (current === "explorer") focusExplorer();
  else focusAgentTree();
}

function focusExplorer(): void {
  requestAnimationFrame(() =>
    view.querySelector<HTMLElement>(".explorer-row[tabindex='0']")?.focus(),
  );
}

function activate(next: View): void {
  const hidden = sidebar.classList.contains("desktop-hidden");
  if (next === current && !hidden) {
    $<HTMLButtonElement>("#menu-btn")?.click();
    return;
  }
  setView(next);
  if (hidden) $<HTMLButtonElement>("#menu-btn")?.click();
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
        note: `+${listing.more} more not shown`,
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
  const explorer = current === "explorer";
  sidebar.dataset.view = current;
  render(
    html`${(
      [
        ["agents", "Agents", AGENTS_ICON],
        ["explorer", "Explorer", EXPLORER_ICON],
      ] as const
    ).map(
      ([id, label, svg]) =>
        html`<button
          type="button"
          class="activity-btn"
          title=${`${label} (E switches)`}
          aria-label=${label}
          aria-pressed=${String(current === id)}
          @click=${() => activate(id)}
        >
          ${unsafeHTML(svg)}
        </button>`,
    )}`,
    bar,
  );
  phoneToggle.innerHTML = explorer ? AGENTS_ICON : EXPLORER_ICON;
  phoneToggle.title = explorer ? "Show agents" : "Show files";
  phoneToggle.setAttribute("aria-label", phoneToggle.title);
  phoneToggle.onclick = () => setView(explorer ? "agents" : "explorer");
  view.hidden = !explorer;
  if (!explorer) return;
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
      </div>`,
    view,
  );
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
  } else if (entry.type === "file") void openPreview(tree.cid, row.path);
  else paint();
  focusCursor();
}

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

onExplorerChange(() => {
  if (current === "explorer") paint();
});
onPaneSync(() => {
  if (current === "explorer") paint();
});
window.addEventListener(UI_REFRESH_EVENT, (event: Event) => {
  const id = (event as CustomEvent<{ agentId?: unknown }>).detail?.agentId;
  if (typeof id === "string" && id === explorerCid() && current === "explorer")
    void refreshTree(treeFor(id));
});
paint();
