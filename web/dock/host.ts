// Desktop docking for the chat and side panels, built on dockview, which owns
// tabs, close buttons, drag and drop, split sizing and serialization. This
// adapts it: panels show elements panes.ts supplies, moved keeping focus and
// scroll; layouts save and restore per conversation. Phones never load it.
import {
  createDockview,
  type DockviewApi,
  type IDockviewPanel,
  type SerializedDockview,
  themeAbyssSpaced,
} from "dockview";

export type DockLayout = SerializedDockview;

export interface DockPanelSpec {
  id: string;
  title: string;
  tooltip?: string;
  /** Its content stays in the page while layouts are swapped. */
  keep?: boolean;
}

export interface DockPlacement {
  /** Add without making it the visible tab of its group. */
  background?: boolean;
  /** Join the group showing this panel, as a new tab. */
  withPanel?: string;
}

export interface DockCallbacks {
  /** The element panel `id` shows; called when dockview creates the panel. */
  element(id: string): HTMLElement | null;
  /** The user closed panel `id` from its tab. */
  closed(id: string): void;
  /** Which panels are visible changed. */
  changed(): void;
  /** SVG markup shown before panel `id`'s tab title. */
  icon(id: string): string;
}

export interface DockHost {
  show(spec: DockPanelSpec, placement?: DockPlacement): void;
  remove(id: string): void;
  has(id: string): boolean;
  visible(id: string): boolean;
  ids(): string[];
  /** The most recently active panel that passes `test`. */
  lastActive(test: (id: string) => boolean): string | undefined;
  /** Active panel of the right-most (then top-most) window passing `test`. */
  rightmost(test: (id: string) => boolean): string | undefined;
  save(): DockLayout;
  restore(layout: DockLayout | null): void;
  dispose(): void;
}

type DockGroup = DockviewApi["groups"][number];

/** The windows touching `gone` on each side: [before, after, vertical]. It
 * was stacked in a column when a window of exactly its width sits above or
 * below it; otherwise its neighbours are the windows to its left and right. */
function adjacent(
  gone: DOMRect,
  sizes: Map<DockGroup, DOMRect>,
  removed: DockGroup,
  gap: number,
): [DockGroup[], DockGroup[], boolean] {
  const near = (a: number, b: number) => Math.abs(a - b) < 2;
  const meets = (end: number, start: number) => near(start - end, gap);
  const rects = [...sizes].filter(([group]) => group !== removed);
  const touching = (test: (rect: DOMRect) => boolean) =>
    rects.filter(([, rect]) => test(rect)).map(([group]) => group);
  const column = (rect: DOMRect) =>
    near(rect.left, gone.left) && near(rect.right, gone.right);
  const row = (rect: DOMRect) =>
    rect.top < gone.bottom - 1 && rect.bottom > gone.top + 1;
  const above = touching((r) => meets(r.bottom, gone.top) && column(r));
  const below = touching((r) => meets(gone.bottom, r.top) && column(r));
  if (above.length || below.length) return [above, below, true];
  return [
    touching((r) => meets(r.right, gone.left) && row(r)),
    touching((r) => meets(gone.right, r.left) && row(r)),
    false,
  ];
}

/** The gutter between windows (style.css's --dock-gutter), in pixels. */
function gutterPx(container: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;width:var(--dock-gutter)";
  container.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/** Move `child` into `parent`, keeping its focus, caret and scroll offsets. */
function adopt(parent: HTMLElement, child: HTMLElement): void {
  if (child.parentElement === parent) return;
  const scrollers = [child, ...child.querySelectorAll<HTMLElement>("*")]
    .filter((element) => element.scrollTop || element.scrollLeft)
    .map(
      (element) => [element, element.scrollTop, element.scrollLeft] as const,
    );
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && child.contains(active) ? active : null;
  const field =
    focused instanceof HTMLTextAreaElement ||
    focused instanceof HTMLInputElement
      ? focused
      : null;
  const caret = field ? [field.selectionStart, field.selectionEnd] : null;
  const move = (parent as { moveBefore?: (node: Node, next: null) => void })
    .moveBefore;
  try {
    if (!move || !child.isConnected || !parent.isConnected) throw Error();
    move.call(parent, child, null);
  } catch {
    parent.append(child);
  }
  for (const [element, top, left] of scrollers) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }
  if (focused && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
    if (field && caret && caret[0] !== null)
      field.setSelectionRange(caret[0], caret[1]);
  }
}

let styles: Promise<void> | null = null;
/** Load dockview's stylesheet; the dock is built once it applies. */
export function loadDockStyles(): Promise<void> {
  styles ??= new Promise((resolve) => {
    const link = document.createElement("link");
    link.id = "dockview-css";
    link.rel = "stylesheet";
    link.href = "/static/dockview.css";
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  });
  return styles;
}

export function createDockHost(
  container: HTMLElement,
  callbacks: DockCallbacks,
): DockHost {
  let quiet = 0;
  const tooltips = new Map<string, string>();
  const kept = new Set<string>();
  let recent: string[] = [];
  // Invariant: Content is placed once dockview has put a panel in the page,
  // so moves keep focus and scroll; kept content parks in the page meanwhile.
  const pending = new Map<HTMLElement, string>();
  let placing = 0;
  let waited = 0;
  const place = (): void => {
    for (const [element, id] of pending) {
      if (!element.isConnected) continue;
      // Invariant: Kept content (the chat) moves once its panel is laid out,
      // so it never shows squeezed; a panel that stays hidden gets it anyway.
      if (kept.has(id) && !element.getBoundingClientRect().width && waited < 30)
        continue;
      pending.delete(element);
      const content = callbacks.element(id);
      if (content) adopt(element, content);
    }
    if (!pending.size) waited = 0;
    else if (!placing)
      placing = requestAnimationFrame(() => {
        placing = 0;
        waited++;
        place();
      });
  };
  const parking = document.createElement("div");
  parking.className = "dock-parking";
  container.after(parking);
  const gutter = (): number => gutterPx(container);
  const api = createDockview(container, {
    theme: { ...themeAbyssSpaced, gap: 0 },
    disableFloatingGroups: true,
    defaultRenderer: "always",
    createComponent: () => {
      const element = document.createElement("div");
      element.className = "dock-panel";
      return {
        element,
        init: (parameters) => {
          pending.set(element, parameters.api.id);
          place();
        },
      };
    },
  });
  // Invariant: The grid follows its container in the same frame, so tab
  // strips and panel contents never show different sizes.
  const sizer = new ResizeObserver(() =>
    api.layout(container.clientWidth, container.clientHeight, true),
  );
  sizer.observe(container);
  const label = (panel: IDockviewPanel): void => {
    const tooltip = tooltips.get(panel.id);
    if (tooltip) panel.view.tab.element.title = tooltip;
    const strip = panel.view.tab.element;
    const tab = strip.matches(".dv-default-tab")
      ? strip
      : strip.querySelector(".dv-default-tab");
    if (tab && !tab.querySelector(".dock-tab-icon")) {
      const icon = document.createElement("span");
      icon.className = "dock-tab-icon";
      icon.dataset.ext = /\.([a-z0-9]+)$/i.exec(panel.id)?.[1]?.toLowerCase();
      icon.innerHTML = callbacks.icon(panel.id);
      tab.prepend(icon);
    }
    place();
  };
  api.onDidAddPanel(label);
  api.onDidRemovePanel((panel) => {
    tooltips.delete(panel.id);
    recent = recent.filter((id) => id !== panel.id);
    for (const [element, id] of pending)
      if (id === panel.id) pending.delete(element);
    if (!quiet) callbacks.closed(panel.id);
  });
  // Invariant: Dragging a tab must not take focus from the panel that had
  // it (the composer keeps its caret and draft while the chat moves).
  let held: HTMLElement | null = null;
  container.addEventListener(
    "pointerdown",
    (event) => {
      const active = document.activeElement;
      held =
        (event.target as Element).closest?.(".dv-tab") &&
        active instanceof HTMLElement &&
        container.contains(active)
          ? active
          : null;
    },
    true,
  );
  const refocus = (): void => {
    const element = held;
    held = null;
    const active = document.activeElement;
    if (element?.isConnected && (!active || active === document.body))
      element.focus({ preventScroll: true });
  };
  api.onDidMovePanel(refocus);
  container.addEventListener("dragend", refocus);
  const fit = (
    targets: [DockGroup, number][],
    axis: "width" | "height",
  ): void => {
    // Invariant: targets are card sizes; a slot also holds the gutter.
    const slot = gutter();
    for (let pass = 0; pass < 2; pass++)
      for (const [group, target] of targets)
        if (api.groups.includes(group))
          group.api.setSize({ [axis]: target + slot });
  };
  // Invariant: When a window closes, only its neighbour toward the chat (or
  // its only neighbour) takes the freed space; every other window keeps its
  // size. Sizes are recorded before any close a pointer or panes.ts starts.
  let sizes = new Map<DockGroup, DOMRect>();
  const record = (): void => {
    sizes = new Map(
      api.groups.map((group) => [group, group.element.getBoundingClientRect()]),
    );
  };
  container.addEventListener("pointerdown", record, true);
  api.onDidRemoveGroup((removed) => {
    const gone = sizes.get(removed);
    if (!gone) return;
    const chat = api.groups.find((group) =>
      group.panels.some((panel) => kept.has(panel.id)),
    );
    const neighbours = adjacent(gone, sizes, removed, gutter());
    const towardChat = chat && sizes.get(chat);
    const pick = (side: DockGroup[][]): DockGroup[] =>
      side.find((groups) => groups.length) ?? [];
    const [before, after, vertical] = neighbours;
    const chatAfter = towardChat
      ? vertical
        ? towardChat.top >= gone.bottom
        : towardChat.left >= gone.right
      : false;
    const growing = pick(chatAfter ? [after, before] : [before, after]);
    if (!growing.length) return;
    const keep = [...sizes].filter(
      ([group]) => group !== removed && api.groups.includes(group),
    );
    const axis = vertical ? "height" : "width";
    const freed = gone[axis] + gutter();
    queueMicrotask(() =>
      fit(
        keep.map(([group, rect]) => [
          group,
          rect[axis] + (growing.includes(group) ? freed : 0),
        ]),
        axis,
      ),
    );
  });
  api.onDidActivePanelChange(({ panel }) => {
    if (panel) recent = [...recent.filter((id) => id !== panel.id), panel.id];
    callbacks.changed();
  });
  api.onDidLayoutChange(() => callbacks.changed());
  const silently = (run: () => void): void => {
    quiet++;
    try {
      run();
    } finally {
      quiet--;
    }
  };
  return {
    show(spec, placement = {}) {
      const existing = api.getPanel(spec.id);
      if (existing) {
        if (!placement.background) existing.api.setActive();
        return;
      }
      if (spec.tooltip) tooltips.set(spec.id, spec.tooltip);
      if (spec.keep) kept.add(spec.id);
      const near = placement.withPanel && api.getPanel(placement.withPanel);
      api.addPanel({
        id: spec.id,
        component: "panel",
        title: spec.title,
        inactive: placement.background && !!near,
        ...(near ? { position: { referenceGroup: near.group } } : {}),
      });
      const added = api.getPanel(spec.id);
      if (added && !added.api.isVisible) {
        // Invariant: A tab added out of sight is marked new until it shows.
        const tab = added.view.tab.element;
        tab.classList.add("dock-new");
        const seen = added.api.onDidVisibilityChange(({ isVisible }) => {
          if (!isVisible) return;
          tab.classList.remove("dock-new");
          seen.dispose();
        });
      }
      place();
    },
    remove(id) {
      record();
      const panel = api.getPanel(id);
      if (panel) silently(() => api.removePanel(panel));
    },
    has: (id) => !!api.getPanel(id),
    visible: (id) => {
      const panel = api.getPanel(id);
      return !!panel?.api.isVisible && panel.group.activePanel === panel;
    },
    ids: () => api.panels.map((panel) => panel.id),
    lastActive: (test) => recent.filter(test).at(-1),
    rightmost(test) {
      let best: { id: string; right: number; top: number } | undefined;
      for (const group of api.groups) {
        const id = group.activePanel?.id;
        if (!id || !group.panels.every((panel) => test(panel.id))) continue;
        const { right, top } = group.element.getBoundingClientRect();
        if (
          !best ||
          right > best.right + 1 ||
          (right > best.right - 1 && top < best.top)
        )
          best = { id, right, top };
      }
      return best?.id;
    },
    save: () => api.toJSON(),
    restore(layout) {
      for (const id of kept) {
        const content = callbacks.element(id);
        if (content?.isConnected) adopt(parking, content);
      }
      pending.clear();
      silently(() => {
        api.clear();
        if (!layout) return;
        try {
          api.fromJSON(layout);
        } catch {
          api.clear();
        }
      });
      for (const panel of api.panels) label(panel);
      place();
    },
    dispose() {
      sizer.disconnect();
      silently(() => api.dispose());
      parking.remove();
    },
  };
}
