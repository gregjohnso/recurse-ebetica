// Pure re-parent (move) validity for the sidebar drag gesture. Kept DOM-free so
// the invariants (no self, no cycle into a descendant) are tested
// directly. The backend re-validates on apply, so this is for immediate UI
// feedback and highlighting, not authority.
import type { TreeNode } from "./types.js";
import { descendantIds } from "./selection.js";

export type ReparentReason =
  | "ok"
  | "noop"
  | "missing-source"
  | "missing-target"
  | "self"
  | "descendant";

export function reparentValidity(
  nodes: Record<string, TreeNode>,
  sourceId: string,
  targetId: string,
): ReparentReason {
  if (!sourceId || !nodes[sourceId]) return "missing-source";
  if (!targetId || !nodes[targetId]) return "missing-target";
  if (targetId === sourceId) return "self";
  if (descendantIds(nodes, sourceId).includes(targetId)) return "descendant";
  if (nodes[sourceId].parent === targetId) return "noop";
  return "ok";
}

export type DropZone = "into" | "before" | "after";

/** New parent for a drop into (child) or before/after (sibling) a row. */
export function dropParent(
  nodes: Record<string, TreeNode>,
  rowId: string,
  zone: DropZone,
): string | null {
  return zone === "into" ? rowId : (nodes[rowId]?.parent ?? null);
}

/** Validity of moving `sourceId` under `parent` (null: the top level). */
export function moveValidity(
  nodes: Record<string, TreeNode>,
  sourceId: string,
  parent: string | null,
): ReparentReason {
  if (parent !== null) return reparentValidity(nodes, sourceId, parent);
  if (!sourceId || !nodes[sourceId]) return "missing-source";
  return nodes[sourceId].parent ? "ok" : "noop";
}
