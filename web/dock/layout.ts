// Checks a saved dock layout before dockview restores it. Stored layouts are
// untrusted browser data: only bounded, well-formed grids whose windows are
// the chat, known panels or at most MAX_FILE_TABS `file:<path>` tabs pass;
// anything else falls back to the default layout.
import type { DockLayout, DockSpot, DockSpots } from "./host.js";

/** Largest stored layout, in JSON characters. */
export const MAX_DOCK_LAYOUT_CHARS = 32_000;
export const MAX_FILE_TABS = 20;
export const MAX_FILE_PATH_CHARS = 1024;
const MAX_DEPTH = 8;
const MAX_GROUPS = 32;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** `value` as a layout to restore, or null when it fails any check. */
export function validDockLayout(
  value: unknown,
  known: (id: string) => boolean,
): DockLayout | null {
  try {
    if (
      !isObject(value) ||
      JSON.stringify(value).length > MAX_DOCK_LAYOUT_CHARS
    )
      return null;
    const { grid, panels } = value;
    if (!isObject(grid) || !isObject(panels) || !isObject(grid.root))
      return null;
    if (value.floatingGroups || value.popoutGroups || value.edgeGroups)
      return null;
    let files = 0;
    for (const [id, panel] of Object.entries(panels)) {
      if (!isObject(panel) || panel.id !== id) return null;
      if (id.startsWith("file:")) {
        if (id.length - 5 < 1 || id.length - 5 > MAX_FILE_PATH_CHARS)
          return null;
        if (++files > MAX_FILE_TABS) return null;
      } else if (!known(id)) return null;
    }
    let groups = 0;
    const seen = new Set<string>();
    const walk = (node: unknown, depth: number): boolean => {
      if (!isObject(node) || depth > MAX_DEPTH) return false;
      if (node.type === "branch")
        return (
          Array.isArray(node.data) &&
          node.data.every((child) => walk(child, depth + 1))
        );
      if (node.type !== "leaf" || !isObject(node.data)) return false;
      const views = node.data.views;
      if (++groups > MAX_GROUPS || !Array.isArray(views)) return false;
      for (const view of views) {
        if (typeof view !== "string" || !(view in panels) || seen.has(view))
          return false;
        seen.add(view);
      }
      return true;
    };
    if (!walk(grid.root, 0) || seen.size !== Object.keys(panels).length)
      return null;
    return value as unknown as DockLayout;
  } catch {
    return null;
  }
}

const SPOT_DIRECTIONS = new Set(["left", "right", "above", "below", "within"]);
/** Most closed windows whose place is remembered, newest kept. */
export const MAX_DOCK_SPOTS = 40;

/** `value` as remembered panel spots, dropping any malformed entry. */
export function validDockSpots(
  value: unknown,
  known: (id: string) => boolean,
): DockSpots {
  const spots: DockSpots = {};
  if (!isObject(value)) return spots;
  const allowed = (id: string) =>
    id.startsWith("file:")
      ? id.length > 5 && id.length - 5 <= MAX_FILE_PATH_CHARS
      : known(id);
  for (const [id, spot] of Object.entries(value).slice(-MAX_DOCK_SPOTS)) {
    if (!allowed(id) || !isObject(spot)) continue;
    const { ref, direction, index, size } = spot;
    if (typeof ref !== "string" || !allowed(ref) || ref === id) continue;
    if (typeof direction !== "string" || !SPOT_DIRECTIONS.has(direction))
      continue;
    const count = (n: unknown, max: number) =>
      typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
    spots[id] = {
      ref,
      direction: direction as DockSpot["direction"],
      ...(count(index, 100) ? { index: index as number } : {}),
      ...(count(size, 10_000) ? { size: size as number } : {}),
    };
  }
  return spots;
}
