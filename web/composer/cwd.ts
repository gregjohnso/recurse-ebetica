// The line under the composer names the shown agent's working directory. It
// reads best-effort after the conversation paints and never delays it.
import { backendFor } from "../backends/backend.js";
import { shortCwd } from "../diff/model.js";
import { $ } from "../dom.js";
import type { Conversation } from "../types.js";

const line = $("#composer-cwd");
let shownId: string | null = null;
let shownKey: string | null = null;
let request = 0;

/** Show the agent's directory; drafts and empty views pass null. */
export function showConversationCwd(conv: Conversation | null): void {
  if (!line) return;
  if (!conv) {
    shownId = shownKey = null;
    request++;
    line.hidden = true;
    line.textContent = "";
    return;
  }
  // Invariant: An agent can change directory during a turn; reread when its
  // message count, run or status moves, and keep the last path meanwhile.
  const key = `${conv.msg_count}:${conv.active_run ?? ""}:${conv.status}`;
  if (conv.id === shownId && key === shownKey) return;
  if (conv.id !== shownId) {
    line.hidden = true;
    line.textContent = "";
  }
  shownId = conv.id;
  shownKey = key;
  const mine = ++request;
  void backendFor(conv.id)
    .api(`/api/conversations/${conv.id}/cwd`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((body: { cwd?: unknown } | null) => {
      if (mine !== request) return;
      const cwd = typeof body?.cwd === "string" ? body.cwd : "";
      if (!cwd && !line.hidden) return;
      line.textContent = shortCwd(cwd);
      line.title = cwd;
      line.hidden = !cwd;
    });
}
