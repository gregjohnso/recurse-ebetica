// Conversations needing the operator: idle ones they messaged whose latest turn
// finished after they last looked, or ones marked unread by hand until opened.
// Per-browser seen marks hold the `replied_at` last seen while open and
// visible; replies from before this browser first ran never count.
import type { TreeNode } from "./types.js";

const KEY = "recurse.seenReplies";
const UNREAD_KEY = "recurse.markedUnread";
const MAX_SEEN = 2000;
const MAX_UNREAD = 500;

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

const unread = new Set<string>();
try {
  const stored: unknown = JSON.parse(localStorage.getItem(UNREAD_KEY) || "[]");
  if (Array.isArray(stored))
    for (const id of stored.slice(-MAX_UNREAD))
      if (typeof id === "string") unread.add(id);
} catch {}
function saveUnread(): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify([...unread]));
  } catch {}
}

/** Whether `node` finished a turn its operator has not looked at yet, or
 * the operator marked it unread. */
export function needsInput(node: TreeNode): boolean {
  const replied = node.replied_at ?? 0;
  return (
    unread.has(node.id) ||
    (node.status === "idle" &&
      !!node.operator_message_at &&
      replied > Math.max(seen.since, seen.at[node.id] ?? 0))
  );
}

/** Show `id` as needing the operator until they open it. */
export function markUnread(id: string): void {
  unread.delete(id);
  unread.add(id);
  for (const old of unread) {
    if (unread.size <= MAX_UNREAD) break;
    unread.delete(old);
  }
  saveUnread();
}

/** Clear `node`'s unread state without opening it. */
export function markRead(node: TreeNode): void {
  if (unread.delete(node.id)) saveUnread();
  recordSeen(node);
}

/** Opening a conversation clears a hand-set unread mark. */
export function noteOpened(id: string): void {
  if (unread.delete(id)) saveUnread();
}

/** Record that the operator is looking at `node` now. */
export function markSeen(node: TreeNode): void {
  if (!document.hidden) recordSeen(node);
}

function recordSeen(node: TreeNode): void {
  const replied = node.replied_at ?? 0;
  if (!replied || seen.at[node.id] === replied) return;
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
