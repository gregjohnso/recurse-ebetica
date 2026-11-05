// Which agents list their subagents, remembered on this device. l/Right
// unfolds until h/Left folds (on the open agent, until the selection changes).
// Stored ids are untrusted: loading keeps at most MAX_OPEN well-formed ids, and
// home tree reads drop ids of home agents that are gone.
import { parseConversationId } from "../backends/backend.js";
import { sharedTrees } from "../shared-trees.js";
import { embedded, state } from "../state.js";

const KEY = "recurse.sidebarAgentFolds";
const MAX_OPEN = 500;
const MAX_ID_LENGTH = 512;

const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

function load(): { open: string[]; collapsed: string | null } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") {
      const { open, collapsed } = saved as Record<string, unknown>;
      return {
        open: Array.isArray(open) ? open.filter(isId).slice(-MAX_OPEN) : [],
        collapsed: isId(collapsed) ? collapsed : null,
      };
    }
  } catch {}
  return { open: [], collapsed: null };
}

const saved = load();
/** Agents opened with l/Right, least recently opened first. */
export const keptOpen: ReadonlySet<string> = new Set(saved.open);
const kept = keptOpen as Set<string>;
let collapsed = saved.collapsed;
let restoring = true;

function save(): void {
  if (embedded) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ open: [...kept], collapsed }));
  } catch {}
}

/** The open agent folded with h/Left, if any. */
export const collapsedAgent = (): string | null => collapsed;

/** The folded open agent as a projection set. */
export function foldedAgents(): Set<string> | undefined {
  return collapsed ? new Set([collapsed]) : undefined;
}

export function keepSubagentsOpen(id: string): void {
  if (!Object.values(state.nodes).some((node) => node.parent === id)) return;
  kept.delete(id);
  kept.add(id);
  for (const old of kept) {
    if (kept.size <= MAX_OPEN) break;
    kept.delete(old);
  }
  save();
}

export function foldAgent(id: string): void {
  collapsed = id;
  kept.delete(id);
  save();
}

export function unfoldAgent(): void {
  if (collapsed === null) return;
  collapsed = null;
  save();
}

/** Selecting unfolds the folded agent, except the open one restored at boot. */
export function noteSelection(id: string): void {
  const keep = restoring && collapsed === id;
  restoring = false;
  if (!keep) unfoldAgent();
}

addEventListener("recurse:tree-authoritative", () => {
  // Invariant: Only an unfiltered home tree proves a home agent is gone;
  // remote ids stay until the cap drops them.
  if (sharedTrees !== null || embedded) return;
  const gone = (id: string) =>
    !parseConversationId(id).label && !state.nodes[id];
  const before = kept.size + (collapsed ? 1 : 0);
  for (const id of kept) if (gone(id)) kept.delete(id);
  if (collapsed && gone(collapsed)) collapsed = null;
  if (kept.size + (collapsed ? 1 : 0) !== before) save();
});
