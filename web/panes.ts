// Registers optional panes; owns visibility, selection, body caches and layout.
// Desktop panes are dockview tabs (dock/host.ts), one layout per conversation;
// phones show one pane at a time in #panes, content and header sharing a
// scroller. Unavailable panes hide their rail button and close on refresh.
import { currentUiOwnerId, embedded, state } from "./state.js";
import { phoneListEntry } from "./phone-nav.js";
import {
  AGENTS_ICON,
  DELETE_ICON,
  MESSAGE_ICON,
  SHARE_ICON,
  TAKE_CONTROL_ICON,
  UP_ICON,
  NEW_ICON,
  MORE_ICON,
  PANE_ICON,
  ATTACHMENT_FILE_ICON,
  PANE_COMPRESS_ICON,
  PANE_EXPAND_ICON,
} from "./icons.js";
import { installPaneChrome } from "./panes/chrome.js";
import { createPanePowerbar, retainPanePowerbar } from "./panes/powerbar.js";
import { $, inputEl } from "./dom.js";
import { pendingCommentCount } from "./comments.js";
import { handleCommentShortcut } from "./artifacts/selection-comments.js";
import {
  ArtifactPaneAutoOpenPolicy,
  type ArtifactAutoOpenObservation,
} from "./panes/autoopen.js";
import { storedPanesWidth, ensurePanesGrip } from "./resize.js";
import { guardLeaveComments } from "./comments.js";
import { mobileSidebarOpen, restoreAgentFocus } from "./sidebar.js";
import {
  cyclePane,
  paneFocusIndicatorId,
  paneIsActionable,
  paneVisibilityAfterUserAction,
  resolvePaneActivation,
} from "./panes/focus.js";
import { backgroundWork } from "./background-work.js";
import { conversationUiState } from "./conversation-ui-state/store.js";
import type { PaneVisibility } from "./conversation-ui-state/schema.js";
import {
  capturePaneViewState,
  PaneViewStateLifecycle,
  validPaneViewStateDef,
} from "./panes/view-state.js";
import { PaneInstanceCache, validPaneCacheDef } from "./panes/cache.js";
import type { PaneContext, PaneDef } from "./types.js";
import type { DockHost, DockLayout, DockPlacement } from "./dock/host.js";
import { validDockLayout } from "./dock/layout.js";
export { setPaneLoading } from "./panes/loading.js";

for (const [id, icon] of [
  ["trash-btn", DELETE_ICON],
  ["takeover-btn", TAKE_CONTROL_ICON],
  ["share-link-btn", SHARE_ICON],
  ["up-top", UP_ICON],
  ["new-top", NEW_ICON],
  ["new-side", NEW_ICON],
  ["pane-fab", MORE_ICON],
])
  $("#" + id)!.insertAdjacentHTML("afterbegin", icon);

const registry: PaneDef[] = [];
const open = new Set<string>();
const bodies = new Map<string, HTMLElement>();
const cachedPaneScroll = new WeakMap<HTMLElement, number>();
let mobileActive: string | null = null;
let railHash = "";
let fullId: string | null = null;
const focusOrigins = new Map<string, HTMLElement>();
const ARTIFACTS_PANE_ID = "report";
const artifactAutoOpen = new ArtifactPaneAutoOpenPolicy(true);
window.addEventListener("recurse:tree-authoritative", () => {
  artifactAutoOpen.retainAgents(new Set(Object.keys(state.nodes)));
});
// The same policy opens Files for a file a settled turn published.
const FILES_PANE_ID = "files";
const filesAutoOpen = new ArtifactPaneAutoOpenPolicy();
let artifactsAttention = false;
let announcementTimer = 0;
const paneOwners = new Map<string, string>();
const paneAgents = new Map<string, string>();
const paneViewState = new PaneViewStateLifecycle();
const paneInstances = new PaneInstanceCache();
const columns = new Map<string, HTMLElement>();
let dock: DockHost | null = null;
let dockLoading = false;
/** The incoming conversation's layout, restored once it renders. */
let pendingDockLayout: DockLayout | null | undefined;
interface DockOnlyPanel {
  element: HTMLElement;
  dispose(): void;
}
type DockPanelFactory = (id: string, agentId: string) => DockOnlyPanel | null;
const dockKinds = new Map<string, DockPanelFactory>();
const dockOnly = new Map<string, DockOnlyPanel>();
let paneParking: HTMLElement | null = null;
let paneVisitAgentId: string | null = null;
let paneVisitOwnerId: string | null = null;
let paneRenderedAgentId: string | null = null;
let paneVisitVisibility: PaneVisibility = { kind: "default" };

const panesEl = $("#panes")!,
  railEl = $("#pane-rail")!,
  topbarEl = $("#topbar")!;
const fabEl = $("#pane-fab")!,
  menuEl = $("#pane-menu")!,
  backdropEl = $("#pane-backdrop")!;
// Optional across bundle generations; absence cannot abort core rendering.
const announcerEl = $("#pane-announcer");

installPaneChrome(panesEl);
panesEl.addEventListener("keydown", (event) => {
  const pane = (event.target as Element).closest<HTMLElement>(".pane-col");
  if (pane) handleCommentShortcut(event, pane);
});
panesEl.addEventListener("comments-submitting", (event) => {
  const pane = (event.target as Element).closest<HTMLElement>(".pane-col");
  if (pane?.dataset.pane) closePane(pane.dataset.pane, false, true);
});

const mq = matchMedia("(max-width: 700px)");
const isMobile = (): boolean => mq.matches;

// A conversation switch restores only that conversation's explicit visibility
// choice. A first visit starts from the product default instead of inheriting a
// pane from the previous conversation; Artifacts may still auto-open by policy.
export function beginPaneVisit(
  agentId: string,
  ownerId = currentUiOwnerId(),
): void {
  artifactAutoOpen.beginVisit(agentId);
  filesAutoOpen.beginVisit(agentId);
  for (const def of registry) def.visit?.(agentId);
  clearArtifactAnnouncement();
  if (artifactsAttention) {
    artifactsAttention = false;
    railHash = "";
  }
  if (paneVisitAgentId === agentId && paneVisitOwnerId === ownerId) return;

  const held =
    document.activeElement instanceof HTMLElement &&
    !!document.activeElement.closest(".pane-col");
  const outgoingOwnerId = paneVisitOwnerId;
  if (outgoingOwnerId) saveDockLayout(outgoingOwnerId);
  for (const id of [...open]) closePane(id);
  clearDockOnly();
  pendingDockLayout = storedDockLayout(ownerId) ?? undefined;
  if (outgoingOwnerId) conversationUiState.flush(outgoingOwnerId);
  if (held) restoreAgentFocus();

  paneVisitAgentId = agentId;
  paneVisitOwnerId = ownerId;
  paneRenderedAgentId = null;
  paneVisitVisibility = conversationUiState.pane(ownerId);
  if (paneVisitVisibility.kind !== "default") {
    artifactAutoOpen.noteUserPaneChoice(agentId);
    filesAutoOpen.noteUserPaneChoice(agentId);
  }
}

// Open/remembered-visible panes read immediately; closed probes queue behind
// focus. Probes record real errors without auto-opening; cancellation stays
// silent. Record invalidation before queueing, because capped queues can drop
// probes.
export function fetchPaneData(
  paneId: string,
  agentId: string,
  run: (signal?: AbortSignal) => Promise<unknown> | void,
): void {
  // Invariant: Priority promotion checks owner and agent together. Unlike
  // restoration, it may read unavailable panes; a wrong priority only warms
  // cache and cannot restore the wrong owner's selection.
  const restoring =
    paneVisitVisibility.kind === "open" &&
    paneVisitVisibility.id === paneId &&
    paneVisitAgentId === agentId &&
    paneVisitOwnerId === currentUiOwnerId();
  if (open.has(paneId) || (restoring && paneRenderedAgentId === agentId)) {
    void run();
    return;
  }
  backgroundWork.enqueue(`pane:${paneId}:${agentId}`, (signal) =>
    Promise.resolve(run(signal)),
  );
}

function noteUserPaneAction(
  id: string,
  opening: boolean,
  preserveLastId = false,
): void {
  const ownerId = paneVisitOwnerId || currentUiOwnerId();
  const prior = conversationUiState.pane(ownerId);
  paneVisitVisibility = paneVisibilityAfterUserAction(
    prior,
    id,
    opening,
    preserveLastId,
  );
  conversationUiState.setPane(ownerId, paneVisitVisibility);
  if (id === ARTIFACTS_PANE_ID && opening)
    artifactAutoOpen.noteArtifactsOpened(state.selectedId);
  else artifactAutoOpen.noteUserPaneChoice(state.selectedId);
  if (id === FILES_PANE_ID && opening)
    filesAutoOpen.noteArtifactsOpened(state.selectedId);
  else filesAutoOpen.noteUserPaneChoice(state.selectedId);
  clearArtifactAnnouncement();
  if (artifactsAttention) {
    artifactsAttention = false;
    railHash = "";
  }
}

function isTextEntry(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable ||
    !!element.closest('[contenteditable="true"], [role="textbox"]')
  );
}

function artifactAutoOpenGuards(): Pick<
  ArtifactAutoOpenObservation,
  "typing" | "modalOpen" | "unsentComments" | "mobileKeyboardOpen" | "mobile"
> {
  const active = document.activeElement;
  const textEntry = isTextEntry(active);
  const mobile = isMobile();
  // Invariant: Avoid viewport layout flush on desktop or focused input;
  // neither needs a visual keyboard check.
  const visualKeyboard =
    mobile &&
    !textEntry &&
    !!window.visualViewport &&
    window.innerHeight - window.visualViewport.height > 120;
  return {
    typing: textEntry || !!inputEl.value,
    modalOpen:
      Array.from(document.getElementsByTagName("dialog")).some(
        (dialog) => dialog.open,
      ) ||
      ["settings-overlay", "prompt-overlay", "pane-menu"].some((id) =>
        document.getElementById(id)?.classList.contains("on"),
      ) ||
      !!document.getElementById("sidebar")?.classList.contains("open"),
    unsentComments: pendingCommentCount() > 0,
    mobileKeyboardOpen: mobile && (textEntry || visualKeyboard),
    mobile,
  };
}

function clearArtifactAnnouncement(): void {
  clearTimeout(announcementTimer);
  announcementTimer = 0;
  if (announcerEl) announcerEl.textContent = "";
}

function announceArtifacts(
  kind: "opened" | "available",
  title = "Artifacts",
): void {
  clearArtifactAnnouncement();
  const agentId = state.selectedId;
  announcementTimer = setTimeout(() => {
    announcementTimer = 0;
    if (state.selectedId !== agentId) return;
    if (announcerEl)
      announcerEl.textContent =
        kind === "opened" ? `${title} opened.` : `${title} available.`;
  }, 0) as unknown as number;
}

export function registerPane(def: PaneDef): void {
  if (!def || !def.id || registry.some((p) => p.id === def.id)) return;
  if (paneVisitAgentId !== null) def.visit?.(paneVisitAgentId);
  // Invariant: Invalid or colliding plugin state must not block the pane itself
  // or let one pane read/write another pane's bounded namespace.
  const viewState = def.viewState;
  if (
    viewState &&
    (!validPaneViewStateDef(viewState) ||
      registry.some((p) => p.viewState?.key === viewState.key) ||
      registry.some(
        (p) =>
          p.viewState?.storageSlot === viewState.storageSlot &&
          (p.viewState.retention || "session") ===
            (viewState.retention || "session"),
      ))
  )
    def = { ...def, viewState: undefined };
  if (def.cache && !validPaneCacheDef(def.cache))
    def = { ...def, cache: undefined };
  registry.push(def);
  registry.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  railHash = "";
  syncPanes();
}

function buildCtxFor(id: string): PaneContext {
  // Invariant: Selection changes before a cold conversation fetch completes.
  // Never hand an old agent's conversation to panels already being retargeted
  // to the new id; the next cache/fetch repaint supplies the matching record.
  const conv = state.currentConv?.id === id ? state.currentConv : null;
  return {
    agentId: id,
    node: state.nodes[id] || null,
    conv,
    nodes: state.nodes,
  };
}

function buildCtx(): PaneContext {
  return buildCtxFor(state.selectedId);
}

function capturePaneState(id: string): void {
  const body = bodies.get(id),
    definition = registry.find((p) => p.id === id);
  const ownerId = paneOwners.get(id),
    agentId = paneAgents.get(id);
  if (!body || !definition || !ownerId || !agentId) return;
  capturePaneViewState(
    conversationUiState,
    ownerId,
    definition.viewState,
    body,
    buildCtxFor(agentId),
  );
}

function paneCacheScope(
  id: string,
  ownerId: string,
  context: PaneContext,
  definition: PaneDef,
) {
  if (!definition.cache) return null;
  try {
    const instanceKey = definition.cache.key(context);
    return typeof instanceKey === "string" &&
      instanceKey.length > 0 &&
      instanceKey.length <= 256
      ? { paneId: id, ownerId, instanceKey }
      : null;
  } catch {
    return null;
  }
}

function parkPaneBody(body: HTMLElement): void {
  if (!("moveBefore" in Element.prototype)) return;
  if (!paneParking) {
    const host = document.createElement("div");
    host.hidden = true;
    paneParking = document.createElement("div");
    host.attachShadow({ mode: "closed" }).append(paneParking);
    document.body.append(host);
  }
  try {
    (
      paneParking as HTMLElement & {
        moveBefore(node: Node, child: Node | null): void;
      }
    ).moveBefore(body, null);
    body.dataset.paneParked = "true";
  } catch {}
}

function forgetPaneState(id: string): void {
  const body = bodies.get(id),
    ownerId = paneOwners.get(id),
    agentId = paneAgents.get(id);
  const definition = registry.find((p) => p.id === id);
  bodies.delete(id);
  paneOwners.delete(id);
  paneAgents.delete(id);
  if (body)
    try {
      definition?.leave?.(body);
    } catch {}
  if (!body || !ownerId || !agentId || !definition?.cache) return;
  delete body.dataset.paneFocusWhenReady;
  cachedPaneScroll.set(
    body,
    isMobile() ? (body.parentElement?.scrollTop ?? 0) : body.scrollTop,
  );
  const context = buildCtxFor(agentId);
  const scope = paneCacheScope(id, ownerId, context, definition);
  if (scope) {
    if (definition.cache.keepConnected) parkPaneBody(body);
    paneInstances.put(scope, body, context, definition.cache);
  } else
    try {
      definition.cache.dispose?.(body, context);
    } catch {}
}

// A plugin mutation can discard only its detached rendered instances. Active
// bodies refresh normally and will be cached from their new state when closed.
export function invalidatePaneCache(id: string, instanceKey?: string): void {
  paneInstances.invalidate(id, instanceKey);
}

function availableFor(ctx: PaneContext): PaneDef[] {
  return registry.filter((p) => {
    try {
      return p.available ? !!p.available(ctx) : true;
    } catch {
      return false;
    }
  });
}

interface OpenPaneOptions {
  focusHeading?: boolean;
  userInitiated?: boolean;
  // Temporary p fallback preserves the remembered pane until explicit choice.
  preserveLastId?: boolean;
  // Keyboard opens focus the body; mobile modal opens focus the heading.
  focusTarget?: "heading" | "body";
  // Docked: add as a tab without showing it (automatic opens).
  background?: boolean;
}
let nextBackground = false;

function usableFocusOrigin(
  element: HTMLElement | null | undefined,
): element is HTMLElement {
  if (
    !element?.isConnected ||
    element === document.body ||
    element === document.documentElement
  )
    return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

export function openPane(id: string, options: OpenPaneOptions = {}): boolean {
  if (!registry.some((p) => p.id === id)) return false;
  const focusHeading = options.focusHeading !== false;
  const entrySel =
    options.focusTarget === "body" ? ".pane-body" : ".pane-title";
  const userInitiated = options.userInitiated !== false;
  // Invariant: Replacing a comment-capable pane is a leave action just like
  // closing it. Do not clear its attention/visit state until the operator
  // accepts the existing shared comment guard.
  const replacing = !dock || isMobile();
  if (
    replacing &&
    userInitiated &&
    [...open].some((openId) => openId !== id) &&
    !guardLeaveComments()
  ) {
    const current = [...open][0];
    if (isMobile() && current)
      requestAnimationFrame(() =>
        panesEl
          .querySelector<HTMLElement>(
            `.pane-col[data-pane="${CSS.escape(current)}"] .pane-title`,
          )
          ?.focus(),
      );
    return false;
  }
  if (replacing)
    for (const openId of open) if (openId !== id) capturePaneState(openId);
  const active = document.activeElement;
  focusOrigins.clear();
  // Invariant: A keyboard menu choice is hidden immediately before openPane
  // runs. Restore to the persistent Panels button rather than that
  // now-invisible menu item.
  const origin =
    active instanceof HTMLElement
      ? menuEl.contains(active)
        ? fabEl
        : active
      : null;
  if (usableFocusOrigin(origin)) focusOrigins.set(id, origin);
  // Invariant: Without the dock at most one panel is open; opening another
  // replaces it. Layout owns removal/reattachment of columns and grips.
  if (replacing) open.clear();
  else if (open.has(id) && !options.background)
    dock?.show({ id, title: titleOf(id) });
  nextBackground = !!options.background;
  if (isMobile()) {
    for (const paneId of [...bodies.keys()]) forgetPaneState(paneId);
    panesEl.innerHTML = "";
    columns.clear();
    mobileActive = id;
  }
  open.add(id);
  if (userInitiated) noteUserPaneAction(id, true, options.preserveLastId);
  layout();
  syncPanes();
  if (focusHeading)
    requestAnimationFrame(() => {
      const col = panesEl.querySelector<HTMLElement>(
        `.pane-col[data-pane="${CSS.escape(id)}"]`,
      );
      const target = col?.querySelector<HTMLElement>(entrySel);
      if (target?.inert && options.focusTarget === "body")
        target.dataset.paneFocusWhenReady = "true";
      (target?.inert
        ? col?.querySelector<HTMLElement>(".pane-title")
        : target
      )?.focus({ preventScroll: true });
    });
  return true;
}
function closePane(
  id: string,
  userInitiated = false,
  restoreFocus = userInitiated,
  preserveComments = false,
): boolean {
  if (
    !open.has(id) ||
    (userInitiated && !preserveComments && !guardLeaveComments())
  )
    return false;
  capturePaneState(id);
  if (userInitiated) noteUserPaneAction(id, false);
  const origin = focusOrigins.get(id);
  open.delete(id);
  forgetPaneState(id);
  focusOrigins.delete(id);
  if (mobileActive === id) mobileActive = null;
  if (fullId === id) fullId = null;
  layout();
  renderRail(availableFor(buildCtx()));
  if (restoreFocus)
    requestAnimationFrame(() => {
      const fallback = isMobile()
        ? fabEl
        : railEl.querySelector<HTMLElement>(
            `.rail-btn[data-pane="${CSS.escape(id)}"]`,
          );
      // Invariant: The opener can remain connected while a breakpoint moves it
      // offscreen; body is likewise connected but is not a meaningful restored
      // target.
      const target = usableFocusOrigin(origin) ? origin : fallback;
      target?.focus();
    });
  return true;
}
/** Open or close pane `id` as its rail button does; true when it opened. */
export function togglePane(id: string): boolean {
  if (open.has(id) && dock && !isMobile() && !dock.visible(id)) {
    dock.show({ id, title: titleOf(id) });
    return true;
  }
  if (open.has(id)) {
    closePane(id, true, true);
    return false;
  }
  return openPane(id, { userInitiated: true });
}

// ---- temporary fullscreen -------------------------------------------------
// A panel can expand to cover the whole viewport; toggling fullscreen or
// closing the panel drops back to the normal column layout.
function toggleFull(id: string): void {
  fullId = fullId === id ? null : id;
  syncFull();
}
function syncFull(): void {
  const mobile = isMobile();
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col")) {
    const on = col.dataset.pane === fullId;
    const modal = on || (mobile && col.dataset.pane === mobileActive);
    col.classList.toggle("fullscreen", on);
    col.setAttribute("role", modal ? "dialog" : "region");
    if (modal) col.setAttribute("aria-modal", "true");
    else col.removeAttribute("aria-modal");
    const fs = col.querySelector<HTMLElement>(".pane-head .fs");
    if (fs) {
      fs.innerHTML = on ? PANE_COMPRESS_ICON : PANE_EXPAND_ICON;
      fs.title = on ? "Exit fullscreen" : "Fullscreen";
      fs.setAttribute("aria-label", on ? "Exit fullscreen" : "Open fullscreen");
      fs.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (element) =>
      !element.hidden && getComputedStyle(element).display !== "none",
  );
}
addEventListener("keydown", (event: KeyboardEvent) => {
  if (mobileSidebarOpen()) return;
  if (menuEl.classList.contains("on")) {
    const items = focusables(menuEl);
    if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      items.length
    ) {
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (index + 1 + items.length) % items.length
              : (index - 1 + items.length) % items.length;
      event.preventDefault();
      items[next].focus();
      return;
    }
    if (event.key === "Tab") {
      if (!items.length) {
        event.preventDefault();
        fabEl.focus();
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && (index < 0 || index === items.length - 1)) {
        event.preventDefault();
        items[0].focus();
      }
    }
    return;
  }
  const activeId = fullId || (isMobile() ? mobileActive : null);
  const modal = activeId
    ? panesEl.querySelector<HTMLElement>(
        `.pane-col[data-pane="${CSS.escape(activeId)}"]`,
      )
    : null;
  if (event.key === "Tab" && modal) {
    const items = focusables(modal);
    if (!items.length) {
      event.preventDefault();
      modal.querySelector<HTMLElement>(".pane-title")?.focus();
      return;
    }
    const first = items[0],
      last = items[items.length - 1];
    const index = items.indexOf(document.activeElement as HTMLElement);
    // Invariant: Heading focus is scheduled after a programmatic mobile open.
    // Pull an earlier Tab (or focus restored unexpectedly outside) into the
    // full-screen dialog before it can reach covered chrome, then keep the
    // focus trap.
    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && index <= 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && index === items.length - 1) {
      event.preventDefault();
      first.focus();
    }
  }
});

// The centralized keymap calls this for Escape outside focused pane content
// (for example, from the panel menu). Focused panes dispatch their own close
// command; this fallback still peels fullscreen before another local layer.
export function closePaneKeyboardLayer(): boolean {
  if (fullId) {
    const id = fullId;
    fullId = null;
    syncFull();
    panesEl
      .querySelector<HTMLElement>(
        `.pane-col[data-pane="${CSS.escape(id)}"] .fs`,
      )
      ?.focus();
    return true;
  }
  if (menuEl.classList.contains("on")) {
    closeMenu();
    fabEl.focus();
    return true;
  }
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const focusedCol = activeElement?.closest<HTMLElement>(".pane-col");
  const id = (isMobile() ? mobileActive : focusedCol?.dataset.pane) || null;
  if (!id || !open.has(id)) return false;
  const before = open.has(id);
  closePane(id, true, true, true);
  return before && !open.has(id);
}
// Only fullscreen/mobile/menu panes are modal; desktop columns preserve tree
// navigation, with Pane mode/native editor keys only while focus is inside.
export function paneKeyboardLayerOpen(): boolean {
  return (
    !!fullId || menuEl.classList.contains("on") || (isMobile() && open.size > 0)
  );
}

function activePaneId(fallback = false): string | null {
  if (fullId && open.has(fullId)) return fullId;
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const focused = active?.closest<HTMLElement>(".pane-col")?.dataset.pane;
  if (focused && open.has(focused)) return focused;
  if (mobileActive && open.has(mobileActive)) return mobileActive;
  return fallback ? [...open][0] || null : null;
}

// Pane keyboard actions are available when a pane is open or can be opened.
export function paneActionable(): boolean {
  // Invariant: Runs on every keydown; short-circuit on an open pane before the
  // availableFor() scan, whose predicates are side-effectful (TTL-guarded)
  // fetches.
  return (
    open.size > 0 ||
    paneIsActionable(
      [...open],
      availableFor(buildCtx()).map((p) => p.id),
    )
  );
}

// The `o` key toggles pane visibility from either the conversation or pane
// focus context. Opening moves focus into the labelled, scrollable pane body;
// closing moves it to the agent tree so focus never remains on removed content.
export function togglePaneFromKeyboard(): boolean {
  const availableIds = availableFor(buildCtx()).map((p) => p.id);
  const preferredId =
    paneVisitVisibility.kind === "default"
      ? undefined
      : paneVisitVisibility.lastId;
  const decision = resolvePaneActivation([...open], availableIds, preferredId);
  if (!decision) return false;
  if (decision.kind === "open")
    return openPane(decision.id, {
      userInitiated: true,
      focusHeading: true,
      focusTarget: "body",
      preserveLastId: !!preferredId && preferredId !== decision.id,
    });
  return closeFocusedPaneFromKeyboard(decision.id);
}

// Focus an open pane without reopening it or changing fullscreen/visibility.
export function focusPaneFromKeyboard(): boolean {
  const id = activePaneId(true);
  if (!id) return togglePaneFromKeyboard();
  const body = panesEl.querySelector<HTMLElement>(
    `.pane-col[data-pane="${CSS.escape(id)}"] .pane-body`,
  );
  body?.focus({ preventScroll: true });
  return document.activeElement === body;
}

export function closeFocusedPaneFromKeyboard(
  preferredId?: string,
  restoreVisibleOrigin = false,
  preserveComments = false,
): boolean {
  const id = preferredId || activePaneId(true);
  if (!id) return false;
  const closed = closePane(id, true, restoreVisibleOrigin, preserveComments);
  if (closed && !restoreVisibleOrigin) restoreAgentFocus();
  return closed;
}

// Tracks pane focus rings through focusin, clearing them on tree/composer
// focus.
function syncPaneFocusIndicator(): void {
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const columnId =
    active?.closest<HTMLElement>(".pane-col")?.dataset.pane ?? null;
  const focusedId = paneFocusIndicatorId(columnId, [...open]);
  for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
    col.classList.toggle("kb-focused", col.dataset.pane === focusedId);
}
document.addEventListener("focusin", syncPaneFocusIndicator);

// Pane mode j/k: switch to the next/previous pane available for this agent and
// focus it (its content stays scrollable via the mouse/trackpad/native arrows).
export function switchPane(delta: -1 | 1): boolean {
  const availableIds = availableFor(buildCtx()).map((p) => p.id);
  const current = activePaneId(true);
  const nextId = cyclePane(availableIds, current, delta);
  if (!nextId || nextId === current) return false;
  return openPane(nextId, {
    userInitiated: true,
    focusHeading: true,
    focusTarget: "body",
  });
}

export function toggleFocusedPaneFullscreen(): boolean {
  const id = activePaneId(true);
  if (!id) return false;
  toggleFull(id);
  return true;
}

// ---- column layout --------------------------------------------------------
function ensureColumn(id: string, ctx: PaneContext): HTMLElement | undefined {
  const existing = bodies.get(id);
  if (existing) return existing;
  const p = registry.find((x) => x.id === id);
  if (!p) return undefined;
  const ownerId = paneVisitOwnerId || currentUiOwnerId();
  const col = document.createElement("div");
  col.className = "pane-col";
  col.dataset.pane = id;
  const head = createPanePowerbar(
    id,
    p.title || id,
    () => toggleFull(id),
    () => closePane(id, true, true),
  );
  col.setAttribute("aria-labelledby", `pane-title-${id}`);
  columns.set(id, col);
  const scope = paneCacheScope(id, ownerId, ctx, p);
  const cached =
    scope && p.cache ? paneInstances.take(scope, ctx, p.cache) : null;
  const body = cached || document.createElement("div");
  if (!cached) {
    body.className = "pane-body";
    body.tabIndex = -1;
  }
  body.dataset.pane = id;
  col.append(retainPanePowerbar(body, head));
  attachColumn(id, col);
  if (body.dataset.paneParked === "true") {
    try {
      const move = (
        col as { moveBefore?: (node: Node, child: Node | null) => void }
      ).moveBefore;
      if (move) move.call(col, body, null);
      else col.appendChild(body);
    } catch {
      col.appendChild(body);
    }
    delete body.dataset.paneParked;
  } else col.appendChild(body);
  bodies.set(id, body);
  paneOwners.set(id, ownerId);
  paneAgents.set(id, ctx.agentId);
  if (!cached) {
    try {
      p.render && p.render(body, ctx);
    } catch {}
    paneViewState.restoreOnce(
      conversationUiState,
      ownerId,
      p.viewState,
      body,
      ctx,
    );
  }
  return body;
}

function layout(): void {
  // Invariant: Desktop panes render only once the dock has loaded, so no
  // body (or its frames) is rendered twice or reparented into the dock.
  if (!isMobile() && !dock && !embedded) {
    loadDock();
    return;
  }
  const ctx = buildCtx();
  ensurePanesGrip();
  if (fullId && !open.has(fullId)) fullId = null;
  for (const [pid, col] of [...columns]) {
    if (open.has(pid)) continue;
    forgetPaneState(pid);
    columns.delete(pid);
    col.remove();
  }
  for (const id of dock?.ids() ?? [])
    if (registry.some((p) => p.id === id) && !open.has(id)) dock!.remove(id);
  for (const p of registry)
    if (open.has(p.id)) {
      const col = columns.get(p.id);
      if (col && !col.isConnected) attachColumn(p.id, col);
      else ensureColumn(p.id, ctx);
    }
  nextBackground = false;

  const mobile = isMobile();
  const docked = !!dock && !mobile;
  panesEl.classList.toggle(
    "on",
    docked ? dock!.ids().length > 0 : open.size > 0,
  );
  panesEl.classList.toggle("docked", docked);
  const w = mobile || docked ? null : storedPanesWidth();
  if (w != null) {
    panesEl.style.flex = "none";
    panesEl.style.width = w + "px";
  } else {
    panesEl.style.flex = mobile ? "" : docked ? "1" : String(open.size);
    panesEl.style.width = "";
  }

  if (mobile) {
    if (mobileActive && !open.has(mobileActive)) mobileActive = null;
    if (!mobileActive && open.size) mobileActive = [...open][0];
    for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
      col.classList.toggle("mobile-active", col.dataset.pane === mobileActive);
    const overlay = open.size > 0 && !!mobileActive;
    panesEl.classList.toggle("overlay", overlay);
    backdropEl.classList.toggle(
      "on",
      overlay || menuEl.classList.contains("on"),
    );
  } else {
    panesEl.classList.remove("overlay");
    backdropEl.classList.remove("on");
    for (const col of panesEl.querySelectorAll<HTMLElement>(".pane-col"))
      col.classList.remove("mobile-active");
  }
  topbarEl.classList.toggle(
    "pane-overlay",
    panesEl.classList.contains("overlay"),
  );
  syncFull();
  for (const body of bodies.values()) {
    const top = cachedPaneScroll.get(body);
    if (top === undefined) continue;
    (mobile ? body.parentElement! : body).scrollTop = top;
    cachedPaneScroll.delete(body);
  }
}

// ---- rail + mobile menu ---------------------------------------------------
function paneBadge(pane: PaneDef, ctx: PaneContext): string {
  try {
    const value = pane.badge?.(ctx);
    if (Number(/^(\d+)\+?$/.exec(String(value))?.[1]) > 999) return "999+";
    return value === null || value === undefined || value === ""
      ? ""
      : String(value).slice(0, 6);
  } catch {
    return "";
  }
}

/** The rail's Agents button: shows the agent list, or hides it when shown. */
function agentsButton(): HTMLButtonElement {
  const shown = !$("#sidebar")!.classList.contains("desktop-hidden");
  const b = document.createElement("button");
  b.className = "rail-btn" + (shown ? " active" : "");
  b.id = "agents-btn";
  b.title = "Agents";
  b.setAttribute("aria-label", "Agents");
  b.setAttribute("aria-pressed", String(shown));
  b.innerHTML = AGENTS_ICON;
  b.onclick = () => $<HTMLButtonElement>("#menu-btn")?.click();
  return b;
}

function renderRail(avail: PaneDef[], ctx = buildCtx()): void {
  const mobile = isMobile();
  // Invariant: Reparent shared controls, retaining their owners and handlers.
  const actions = [
    $("#trash-btn")!,
    $("#takeover-btn")!,
    $("#share-link-btn")!,
  ];
  // Spec: Phone menu order: Delete, Take control, divider, Share.
  const actionHost = mobile ? menuEl : railEl;
  if (actions[0].parentElement !== actionHost) {
    if (mobile) {
      $("#pane-menu-divider")!.before(actions[0], actions[1]);
      $("#pane-menu-divider")!.after(actions[2]);
    } else railEl.prepend(...actions);
    for (const action of actions) {
      if (mobile) action.setAttribute("role", "menuitem");
      else action.removeAttribute("role");
    }
  }
  const badges = new Map(avail.map((p) => [p.id, paneBadge(p, ctx)]));
  const hash =
    avail.map((p) => `${p.id}:${badges.get(p.id) || ""}`).join(",") +
    "|" +
    [...open].join(",") +
    "|" +
    (artifactsAttention ? "a" : "") +
    "|" +
    (mobile ? "m" : "d") +
    "|" +
    state.selectedId +
    "|" +
    $("#sidebar")!.classList.contains("desktop-hidden") +
    "|" +
    !!dock?.visible(CHAT);
  if (hash === railHash) return;
  railHash = hash;
  // Spec: The desktop rail always shows; it holds Agents and Settings.
  railEl.classList.toggle("on", !mobile);
  fabEl.classList.toggle("on", mobile);
  const mobileAttention =
    artifactsAttention && avail.some((p) => p.id === ARTIFACTS_PANE_ID);
  fabEl.classList.toggle("attention", mobileAttention);
  // Spec: Pane counts appear in the menu, not on More.
  const fabLabel =
    "More actions" + (mobileAttention ? " — Artifacts available" : "");
  fabEl.title = fabLabel;
  fabEl.setAttribute("aria-label", fabLabel);

  const railPanels = $("#pane-rail-panels")!;
  railPanels.innerHTML = "";
  railPanels.appendChild(agentsButton());
  if (dock && !mobile) railPanels.appendChild(chatButton());
  for (const p of avail) {
    const b = document.createElement("button");
    const attention = artifactsAttention && p.id === ARTIFACTS_PANE_ID;
    b.className =
      "rail-btn" +
      (open.has(p.id) ? " active" : "") +
      (attention ? " attention" : "");
    b.dataset.pane = p.id;
    const badge = badges.get(p.id) || "";
    const baseLabel = p.title || p.id;
    const counted = badge ? `${baseLabel} (${badge})` : baseLabel;
    const label = attention ? `${counted} available` : counted;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-expanded", open.has(p.id) ? "true" : "false");
    b.innerHTML = p.icon || `<span>${(p.title || "?").slice(0, 1)}</span>`;
    if (badge) {
      const count = document.createElement("span");
      count.className = "badge rail-count";
      count.textContent = badge;
      count.setAttribute("aria-hidden", "true");
      b.appendChild(count);
    }
    b.onclick = () => togglePane(p.id);
    railPanels.appendChild(b);
  }

  const panelItems = $("#pane-menu-panels")!;
  panelItems.innerHTML = "";
  for (const p of avail) {
    const b = document.createElement("button");
    const attention = artifactsAttention && p.id === ARTIFACTS_PANE_ID;
    b.className =
      "menu-item pane-menu-item" +
      (open.has(p.id) ? " active" : "") +
      (attention ? " attention" : "");
    b.dataset.pane = p.id;
    b.setAttribute("role", "menuitem");
    const badge = badges.get(p.id) || "";
    const label = badge ? `${p.title || p.id} (${badge})` : p.title || p.id;
    if (attention) b.setAttribute("aria-label", `${label} available`);
    b.innerHTML = p.icon || PANE_ICON;
    b.querySelector("svg")?.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    b.appendChild(text);
    b.onclick = () => openPane(p.id);
    panelItems.appendChild(b);
  }
}

menuEl.addEventListener(
  "click",
  (event) => {
    const item = (event.target as Element | null)?.closest<HTMLButtonElement>(
      ".pane-menu-item",
    );
    if (!item || item.disabled) return;
    // Invariant: Delete's first tap is an inline confirmation, not an action.
    if (item.id === "trash-btn" && !item.classList.contains("armed")) return;
    closeMenu();
    fabEl.focus({ preventScroll: true });
  },
  true,
);

function openMenu(focusFirst = false): void {
  menuEl.classList.add("on");
  backdropEl.classList.add("on");
  fabEl.setAttribute("aria-expanded", "true");
  if (focusFirst) requestAnimationFrame(() => focusables(menuEl)[0]?.focus());
}
function closeMenu(): void {
  menuEl.classList.remove("on");
  fabEl.setAttribute("aria-expanded", "false");
  clearHot();
  if (!(isMobile() && mobileActive && open.size))
    backdropEl.classList.remove("on");
}

addEventListener("popstate", () => {
  if (phoneListEntry()) closeMenu();
});

// Phone FAB press/slide/release picks a panel; plain taps toggle the menu.
let hotItem: HTMLElement | null = null;
function clearHot(): void {
  if (hotItem) {
    hotItem.classList.remove("hot");
    hotItem = null;
  }
}
function setHot(el: HTMLElement | null): void {
  if (el === hotItem) return;
  clearHot();
  if (el) {
    el.classList.add("hot");
    hotItem = el;
  }
}
function inRect(x: number, y: number, el: HTMLElement | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function menuItemAt(x: number, y: number): HTMLElement | null {
  for (const el of menuEl.querySelectorAll<HTMLButtonElement>(
    ".pane-menu-item:not(:disabled)",
  ))
    if (inRect(x, y, el)) return el;
  return null;
}

let fabActive = false,
  fabWasOpen = false;
fabEl.addEventListener("pointerdown", (e: PointerEvent) => {
  fabActive = true;
  fabWasOpen = menuEl.classList.contains("on");
  try {
    fabEl.setPointerCapture(e.pointerId);
  } catch {}
  openMenu();
  e.preventDefault();
});
fabEl.addEventListener("pointermove", (e: PointerEvent) => {
  if (fabActive) setHot(menuItemAt(e.clientX, e.clientY));
});
const fabFinish = (commit: boolean) => (e: PointerEvent) => {
  if (!fabActive) return;
  fabActive = false;
  try {
    fabEl.releasePointerCapture(e.pointerId);
  } catch {}
  const item = menuItemAt(e.clientX, e.clientY);
  const overBtn = inRect(e.clientX, e.clientY, fabEl);
  clearHot();
  // Spec: Slide-release activates one item via pointer confirmation.
  if (commit && item) {
    item.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
        clientX: e.clientX,
        clientY: e.clientY,
      }),
    );
  } else if (overBtn) {
    if (fabWasOpen) closeMenu();
  } else closeMenu();
};
fabEl.addEventListener("pointerup", fabFinish(true));
fabEl.addEventListener("pointercancel", fabFinish(false));
fabEl.addEventListener("click", (e: MouseEvent) => {
  // Spec: Detail-0 keyboard clicks toggle; pointer gestures already handled
  // their own generated clicks and must not activate twice.
  if (e.detail === 0) {
    menuEl.classList.contains("on") ? closeMenu() : openMenu(true);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
});
fabEl.addEventListener("contextmenu", (e) => e.preventDefault());
backdropEl.onclick = () => {
  closeMenu();
  if (isMobile() && mobileActive) closePane(mobileActive, true, true);
};
mq.addEventListener("change", () => {
  if (isMobile()) unloadDock();
  else loadDock();
  closeMenu();
  railHash = "";
  layout();
  syncPanes();
});
addEventListener("panes-relayout", () => layout());
/** Keeps the rail's Agents button in step with the agent list's visibility. */
const sidebarWatch = new MutationObserver(() =>
  renderRail(availableFor(buildCtx())),
);
sidebarWatch.observe($("#sidebar")!, {
  attributes: true,
  attributeFilter: ["class"],
});
queueMicrotask(() => {
  // Invariant: The dock loads at boot, beside the first conversation fetch,
  // so the chat moves into it before or as the thread first renders.
  loadDock();
});

// ---- the per-poll sync (called from the conversation refresh) -------------
let syncFailureAnnounced = false;

export function notePaneConversationRendered(agentId: string): void {
  if (paneVisitAgentId === agentId) paneRenderedAgentId = agentId;
  loadDock();
}

// ---- the desktop dock ------------------------------------------------------
const EDITOR_PANES = new Set([ARTIFACTS_PANE_ID, FILES_PANE_ID]);
const isEditorPanel = (id: string): boolean =>
  EDITOR_PANES.has(id) || [...dockKinds.keys()].some((k) => id.startsWith(k));

/** The chat's dock panel. Closing it parks the chat, hidden, at its home. */
const CHAT = "chat";
const chatEl = $("#main")!;
const chatHome = chatEl.nextElementSibling;
function parkChat(): void {
  chatHome?.before(chatEl);
  chatEl.style.display = dock && !isMobile() ? "none" : "";
}
/** Open the chat panel if closed, in the background unless `reveal`. */
function showChat(reveal = false): void {
  if (!dock || isMobile()) return;
  if (dock.has(CHAT)) {
    if (reveal && !dock.visible(CHAT)) dock.show({ id: CHAT, title: "Chat" });
    return;
  }
  const ids = dock.ids();
  const tool = ids.find((id) => !isEditorPanel(id));
  const editor = ids.find(isEditorPanel);
  dock.show(
    { id: CHAT, title: "Chat", keep: true },
    {
      background: !reveal,
      beside: tool
        ? { id: tool, direction: "right" }
        : editor
          ? { id: editor, direction: "left" }
          : undefined,
    },
  );
}
addEventListener("recurse:show-chat", (event) => {
  if (!dock || isMobile()) return;
  showChat(true);
  event.preventDefault();
});

/** The rail's Chat button: opens or brings forward the chat panel. */
function chatButton(): HTMLButtonElement {
  const shown = !!dock?.visible(CHAT);
  const b = document.createElement("button");
  b.className = "rail-btn" + (shown ? " active" : "");
  b.id = "chat-btn";
  b.title = "Chat";
  b.setAttribute("aria-label", "Chat");
  b.setAttribute("aria-pressed", String(shown));
  b.innerHTML = MESSAGE_ICON;
  b.onclick = () => {
    showChat(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => $<HTMLTextAreaElement>("#input")?.focus()),
    );
  };
  return b;
}

const DOCK_STATE_KEY = "dock";
const DOCK_STATE_VERSION = 1;
const DOCK_STATE_SLOT = 15;
const knownDockPanel = (id: string): boolean =>
  id === CHAT || registry.some((p) => p.id === id);

/** The conversation's saved dock layout, if it is valid. */
function storedDockLayout(ownerId: string): DockLayout | null {
  return validDockLayout(
    conversationUiState.paneState(
      ownerId,
      DOCK_STATE_KEY,
      DOCK_STATE_VERSION,
      "local",
    ),
    knownDockPanel,
  );
}

/** Save the dock layout as `ownerId`'s, once any pending restore applied. */
function saveDockLayout(ownerId: string): void {
  if (!dock || isMobile() || pendingDockLayout !== undefined) return;
  conversationUiState.setPaneState(
    ownerId,
    DOCK_STATE_KEY,
    DOCK_STATE_VERSION,
    "local",
    dock.save(),
    DOCK_STATE_SLOT,
  );
}

function titleOf(id: string): string {
  return registry.find((p) => p.id === id)?.title || id;
}

/** Where a new dock panel goes: tools left, files and Artifacts right. */
function dockPlacement(id: string): DockPlacement {
  if (id === EXPLORER) {
    return {
      background: nextBackground,
      leftmost: true,
      width: explorerWidth(),
    };
  }
  const kind = dockKindOf(id);
  const ids = dock?.ids() ?? [];
  const same = (other: string) => dockKindOf(other) === kind;
  const anchor = ids.includes(CHAT)
    ? CHAT
    : ids.find((other) => other !== CHAT && !same(other));
  return {
    background: nextBackground,
    withPanel: dock?.lastActive(same) ?? ids.filter(same).at(-1),
    beside: anchor
      ? { id: anchor, direction: kind === "tool" ? "left" : "right" }
      : undefined,
  };
}

const EXPLORER = "explorer";
const EXPLORER_WIDTH_KEY = "recurse.explorerWidth";
const clampExplorer = (width: number): number =>
  Math.round(Math.max(180, Math.min(600, width)));

/** The Explorer's opening width: the user's last, or a default. */
function explorerWidth(): number {
  const saved = Number(localStorage.getItem(EXPLORER_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampExplorer(saved) : 280;
}

function rememberExplorerWidth(): void {
  const width = dock?.width(EXPLORER);
  if (width)
    localStorage.setItem(EXPLORER_WIDTH_KEY, String(clampExplorer(width)));
}

/** A tab's icon: the pane's rail icon, the chat's, or a file's. */
function dockIcon(id: string): string {
  if (id === CHAT) return MESSAGE_ICON;
  const pane = registry.find((p) => p.id === id);
  return pane ? pane.icon || PANE_ICON : ATTACHMENT_FILE_ICON;
}

/** Which windows share a group: chat, tools, Artifacts/Files, or a tab kind. */
function dockKindOf(id: string): string {
  if (id === CHAT) return CHAT;
  for (const prefix of dockKinds.keys())
    if (id.startsWith(prefix)) return prefix;
  return EDITOR_PANES.has(id) ? "editor" : "tool";
}

let attachingFromDock = false;
function attachColumn(id: string, col: HTMLElement): void {
  if (attachingFromDock) return;
  if (dock && !isMobile())
    dock.show({ id, title: titleOf(id) }, dockPlacement(id));
  else panesEl.appendChild(col);
}

function dockElement(id: string): HTMLElement | null {
  if (id === CHAT) {
    chatEl.style.display = "";
    return chatEl;
  }
  if (registry.some((p) => p.id === id)) {
    const existing = columns.get(id);
    if (existing) return existing;
    open.add(id);
    attachingFromDock = true;
    try {
      ensureColumn(id, buildCtx());
    } finally {
      attachingFromDock = false;
    }
    return columns.get(id) ?? null;
  }
  const existing = dockOnly.get(id);
  if (existing) return existing.element;
  for (const [prefix, create] of dockKinds)
    if (id.startsWith(prefix)) {
      const made = create(id, state.selectedId);
      if (made) dockOnly.set(id, made);
      return made?.element ?? null;
    }
  return null;
}

function dockClosed(id: string): void {
  if (id === CHAT) {
    parkChat();
    railHash = "";
    syncPanes();
    return;
  }
  const made = dockOnly.get(id);
  if (made) {
    dockOnly.delete(id);
    made.dispose();
  } else if (open.has(id)) closePane(id, true, false, true);
  layout();
}

function clearDockOnly(): void {
  for (const id of [...dockOnly.keys()]) {
    dock?.remove(id);
    dockOnly.get(id)?.dispose();
    dockOnly.delete(id);
  }
  dock?.restore(null);
  showChat();
  layout();
}

function loadDock(): void {
  if (dock || dockLoading || isMobile() || embedded) return;
  dockLoading = true;
  void import("./dock/host.js")
    .then(async (host) => {
      await host.loadDockStyles();
      return host;
    })
    .then(
      ({ createDockHost }) => {
        dockLoading = false;
        if (dock || isMobile()) return;
        const root = document.createElement("div");
        root.id = "dock";
        panesEl.append(root);
        dock = createDockHost(root, {
          element: dockElement,
          closed: dockClosed,
          icon: dockIcon,
          resized: rememberExplorerWidth,
          // Invariant: dockview reports changes while panes.ts is still
          // adding a panel; resync afterwards, never re-entrantly.
          changed: () =>
            queueMicrotask(() => {
              railHash = "";
              syncPanes();
              if (paneVisitOwnerId) saveDockLayout(paneVisitOwnerId);
            }),
        });
        showChat();
        layout();
        syncPanes();
      },
      () => {
        dockLoading = false;
      },
    );
}

function unloadDock(): void {
  if (!dock) return;
  const keep = [...open][0];
  for (const id of [...open]) if (id !== keep) closePane(id);
  for (const id of [...dockOnly.keys()]) {
    dockOnly.get(id)?.dispose();
    dockOnly.delete(id);
  }
  dock.dispose();
  dock = null;
  parkChat();
  $("#dock")?.remove();
}

/** Register a kind of dock-only panel whose ids start with `prefix`. */
export function registerDockPanelKind(
  prefix: string,
  create: DockPanelFactory,
): void {
  dockKinds.set(prefix, create);
}

/** Close dock-only panel `id`, as its tab's close button does. */
export function closeDockPanel(id: string): void {
  if (!dockOnly.has(id)) return;
  dock?.remove(id);
  dockClosed(id);
}

/** Open or focus dock-only panel `id`; false when the dock isn't showing. */
export function openDockPanel(
  id: string,
  title: string,
  tooltip?: string,
): boolean {
  if (!dock || isMobile()) return false;
  if (!dock.has(id) && !dockElement(id)) return false;
  dock.show({ id, title, tooltip }, dockPlacement(id));
  layout();
  return true;
}

function restorePanePreference(availableIds: ReadonlySet<string>): boolean {
  if (
    paneVisitAgentId !== state.selectedId ||
    paneRenderedAgentId !== state.selectedId ||
    paneVisitOwnerId !== currentUiOwnerId() ||
    paneVisitVisibility.kind !== "open" ||
    open.size > 0 ||
    !availableIds.has(paneVisitVisibility.id)
  )
    return false;
  return openPane(paneVisitVisibility.id, {
    // Invariant: A restored desktop column must not steal conversation/tree
    // focus. On a phone it covers the conversation as a modal, so focus enters
    // its heading.
    focusHeading: isMobile(),
    userInitiated: false,
  });
}

function syncPanesNow(): void {
  const ctx = buildCtx();
  const avail = availableFor(ctx);
  const availIds = new Set(avail.map((p) => p.id));
  for (const id of [...open])
    if (!availIds.has(id)) {
      // Invariant: If the pane being auto-closed currently holds keyboard
      // focus, hand focus back to the canonical tree/menu target so a Pane-mode
      // user is never dropped onto <body>.
      const held =
        document.activeElement instanceof HTMLElement &&
        !!document.activeElement.closest(
          `.pane-col[data-pane="${CSS.escape(id)}"]`,
        );
      closePane(id);
      if (held) restoreAgentFocus();
    }

  // Invariant: Explicit state wins over per-visit defaults and asynchronous
  // Artifact discovery. openPane() re-enters sync with the pane present, so
  // return after a successful restore rather than refreshing the same body
  // twice.
  if (
    dock &&
    !isMobile() &&
    pendingDockLayout !== undefined &&
    paneRenderedAgentId === state.selectedId &&
    paneVisitAgentId === state.selectedId
  ) {
    const saved = pendingDockLayout;
    pendingDockLayout = undefined;
    dock.restore(saved);
    showChat();
    layout();
  }
  if (restorePanePreference(availIds)) return;

  const artifacts = registry.find((p) => p.id === ARTIFACTS_PANE_ID);
  let generation: string | null | undefined;
  try {
    generation = artifacts?.autoOpenGeneration?.(ctx);
  } catch {
    generation = undefined;
  }
  const autoDecision = artifactAutoOpen.observe({
    agentId: ctx.agentId,
    generation,
    artifactsPaneOpen: open.has(ARTIFACTS_PANE_ID),
    otherPaneOpen: !dock && [...open].some((id) => id !== ARTIFACTS_PANE_ID),
    ...artifactAutoOpenGuards(),
  });
  if (artifactsAttention !== autoDecision.badged) {
    artifactsAttention = autoDecision.badged;
    railHash = "";
  }
  if (autoDecision.announcement) announceArtifacts(autoDecision.announcement);
  if (autoDecision.open && availIds.has(ARTIFACTS_PANE_ID)) {
    openPane(ARTIFACTS_PANE_ID, {
      // Invariant: A desktop side column can preserve conversation focus. The
      // full-screen phone surface is an ARIA modal, so focus must enter its
      // heading.
      focusHeading: isMobile() ? true : autoDecision.focusHeading,
      userInitiated: false,
      background: true,
    });
    return;
  }

  const files = registry.find((p) => p.id === FILES_PANE_ID);
  let fileGeneration: string | null | undefined;
  try {
    fileGeneration = files?.autoOpenGeneration?.(ctx);
  } catch {
    fileGeneration = undefined;
  }
  const filesDecision = filesAutoOpen.observe({
    agentId: ctx.agentId,
    generation: fileGeneration,
    artifactsPaneOpen: open.has(FILES_PANE_ID),
    otherPaneOpen: !dock && [...open].some((id) => id !== FILES_PANE_ID),
    ...artifactAutoOpenGuards(),
  });
  if (filesDecision.open && files && availIds.has(FILES_PANE_ID)) {
    files.autoOpened?.(ctx);
    announceArtifacts("opened", "Files");
    openPane(FILES_PANE_ID, {
      focusHeading: false,
      userInitiated: false,
      background: true,
    });
    return;
  }

  renderRail(avail);
  for (const id of open) {
    const p = registry.find((x) => x.id === id);
    const body = bodies.get(id);
    if (dock && !isMobile() && !dock.visible(id)) continue;
    if (p && body && p.refresh) {
      try {
        p.refresh(body, ctx);
      } catch {}
    }
  }
}

// Optional pane failures cannot block successful tree/thread rendering. Keep
// failures local, announce once, retry on ordinary sync, and allow generation
// recovery to replace stale shells.
export function syncPanes(): void {
  if (embedded) return;
  try {
    syncPanesNow();
    if (syncFailureAnnounced) {
      syncFailureAnnounced = false;
      if (announcerEl) announcerEl.textContent = "Panels available again.";
    }
  } catch {
    if (syncFailureAnnounced) return;
    syncFailureAnnounced = true;
    console.warn(
      "Panels could not update; the conversation remains available.",
    );
    if (announcerEl)
      announcerEl.textContent =
        "Panels could not update. The conversation remains available.";
  }
}

addEventListener("pagehide", () => {
  for (const id of open) capturePaneState(id);
  conversationUiState.flush();
});

beginPaneVisit(state.selectedId);
