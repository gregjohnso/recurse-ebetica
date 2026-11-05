// Desktop docking for the chat and side panels, built on dockview, which owns
// tabs, close buttons, drag and drop, split sizing and serialization. This
// adapts it: panels show elements panes.ts supplies, moved keeping focus and
// scroll; layouts save and restore per conversation. Phones never load it.
import {
  createDockview,
  type AddPanelPositionOptions,
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
  /** Join the group showing this panel. */
  withPanel?: string;
  /** Otherwise split beside this panel, on the given side. */
  beside?: { id: string; direction: "left" | "right" };
}

export interface DockCallbacks {
  /** The element panel `id` shows; called when dockview creates the panel. */
  element(id: string): HTMLElement | null;
  /** The user closed panel `id` from its tab. */
  closed(id: string): void;
  /** Which panels are visible changed. */
  changed(): void;
}

export interface DockHost {
  show(spec: DockPanelSpec, placement?: DockPlacement): void;
  remove(id: string): void;
  has(id: string): boolean;
  visible(id: string): boolean;
  ids(): string[];
  /** The most recently active panel that passes `test`. */
  lastActive(test: (id: string) => boolean): string | undefined;
  save(): DockLayout;
  restore(layout: DockLayout | null): void;
  dispose(): void;
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

/** The theme's gap between windows (--content-inset), in pixels. */
function insetPx(container: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;width:var(--content-inset)";
  container.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
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
  const api = createDockview(container, {
    theme: { ...themeAbyssSpaced, gap: insetPx(container) },
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
      const beside = placement.beside && api.getPanel(placement.beside.id);
      const position: AddPanelPositionOptions | undefined = near
        ? { referenceGroup: near.group }
        : beside
          ? {
              referenceGroup: beside.group,
              direction: placement.beside!.direction,
            }
          : undefined;
      // Invariant: A new split takes space only from the group it splits;
      // every other group keeps its width.
      const widths =
        !near && beside
          ? api.groups
              .filter((group) => group !== beside.group)
              .map((group) => [group, group.api.width] as const)
          : [];
      const shared =
        !near && beside ? Math.round(beside.group.api.width / 2) : 0;
      api.addPanel({
        id: spec.id,
        component: "panel",
        title: spec.title,
        inactive: placement.background && !!position,
        ...(shared ? { initialWidth: shared } : {}),
        ...(position ? { position } : {}),
      });
      const added = !near && beside ? api.getPanel(spec.id)?.group : undefined;
      if (added)
        for (let pass = 0; pass < 2; pass++) {
          for (const [group, width] of widths)
            if (api.groups.includes(group)) group.api.setSize({ width });
          added.api.setSize({ width: shared });
        }
      place();
    },
    remove(id) {
      const panel = api.getPanel(id);
      if (panel) silently(() => api.removePanel(panel));
    },
    has: (id) => !!api.getPanel(id),
    visible: (id) => !!api.getPanel(id)?.api.isVisible,
    ids: () => api.panels.map((panel) => panel.id),
    lastActive: (test) => recent.filter(test).at(-1),
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
