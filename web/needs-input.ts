// Which conversations need the operator: idle ones they messaged whose latest
// turn finished after they last looked. Seen marks are per browser, keyed by
// conversation id, and hold the `replied_at` last seen while it was open and
// visible. Replies from before this browser first ran never count.
import type { TreeNode } from "./types.js";

const KEY = "recurse.seenReplies";
const MAX_SEEN = 2000;

interface Seen {
  since: number;
  at: Record<string, number>;
}

let seen: Seen = { since: Date.now() / 1000, at: {} };
try {
  const stored = JSON.parse(localStorage.getItem(KEY) || "null");
  if (stored && typeof stored.since === "number" && stored.at)
    seen = { since: stored.since, at: { ...stored.at } };
  else localStorage.setItem(KEY, JSON.stringify(seen));
} catch {}
addEventListener("storage", (event: StorageEvent) => {
  if (event.key !== KEY) return;
  try {
    const stored = JSON.parse(event.newValue || "null");
    if (stored?.at)
      seen = { since: seen.since, at: { ...seen.at, ...stored.at } };
  } catch {}
});

/** Whether `node` finished a turn its operator has not looked at yet. */
export function needsInput(node: TreeNode): boolean {
  const replied = node.replied_at ?? 0;
  return (
    node.status === "idle" &&
    !!node.operator_message_at &&
    replied > Math.max(seen.since, seen.at[node.id] ?? 0)
  );
}

/** Record that the operator is looking at `node` now. */
export function markSeen(node: TreeNode): void {
  const replied = node.replied_at ?? 0;
  if (document.hidden || !replied || seen.at[node.id] === replied) return;
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "null");
    if (stored?.at) seen.at = { ...stored.at, ...seen.at };
  } catch {}
  seen.at[node.id] = replied;
  const ids = Object.keys(seen.at);
  if (ids.length > MAX_SEEN)
    for (const id of ids
      .sort((a, b) => seen.at[a]! - seen.at[b]!)
      .slice(0, ids.length - MAX_SEEN))
      delete seen.at[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {}
}
