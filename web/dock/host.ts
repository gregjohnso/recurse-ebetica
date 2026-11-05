// Desktop docking for side panels, built on dockview. Tabs, close buttons,
// drag and drop with edge snapping, split sizing, group headers and layout
// serialization are dockview's own; this module only adapts its API: panels
// show elements panes.ts supplies, and a layout can be saved and restored so
// each conversation keeps its own. Loaded lazily; phones never load it.
import {
  createDockview,
  type AddPanelPositionOptions,
  type IDockviewPanel,
  type SerializedDockview,
} from "dockview";

export type DockLayout = SerializedDockview;

export interface DockPanelSpec {
  id: string;
  title: string;
  tooltip?: string;
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
  save(): DockLayout;
  restore(layout: DockLayout | null): void;
  dispose(): void;
}

const stylesheet = (): void => {
  if (document.getElementById("dockview-css")) return;
  const link = document.createElement("link");
  link.id = "dockview-css";
  link.rel = "stylesheet";
  link.href = "/static/dockview.css";
  document.head.append(link);
};

export function createDockHost(
  container: HTMLElement,
  callbacks: DockCallbacks,
): DockHost {
  stylesheet();
  let quiet = 0;
  const tooltips = new Map<string, string>();
  const api = createDockview(container, {
    theme: { name: "recurse", className: "dockview-theme-recurse" },
    disableFloatingGroups: true,
    defaultRenderer: "always",
    createComponent: () => {
      const element = document.createElement("div");
      element.className = "dock-panel";
      return {
        element,
        init: (parameters) => {
          const content = callbacks.element(parameters.api.id);
          if (content) element.append(content);
        },
      };
    },
  });
  const label = (panel: IDockviewPanel): void => {
    const tooltip = tooltips.get(panel.id);
    if (tooltip) panel.view.tab.element.title = tooltip;
  };
  api.onDidAddPanel(label);
  api.onDidRemovePanel((panel) => {
    tooltips.delete(panel.id);
    if (!quiet) callbacks.closed(panel.id);
  });
  api.onDidActivePanelChange(() => callbacks.changed());
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
      const near = placement.withPanel && api.getPanel(placement.withPanel);
      const beside = placement.beside && api.getPanel(placement.beside.id);
      const position: AddPanelPositionOptions | undefined = near
        ? { referenceGroup: near.group }
        : beside
          ? { referencePanel: beside, direction: placement.beside!.direction }
          : undefined;
      api.addPanel({
        id: spec.id,
        component: "panel",
        title: spec.title,
        inactive: placement.background && !!position,
        ...(position ? { position } : {}),
      });
    },
    remove(id) {
      const panel = api.getPanel(id);
      if (panel) silently(() => api.removePanel(panel));
    },
    has: (id) => !!api.getPanel(id),
    visible: (id) => !!api.getPanel(id)?.api.isVisible,
    ids: () => api.panels.map((panel) => panel.id),
    save: () => api.toJSON(),
    restore(layout) {
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
    },
    dispose() {
      silently(() => api.dispose());
    },
  };
}
