// Settings > Agent status: what each sidebar mark and badge means. Marks are
// drawn with the sidebar's own classes, so the legend always matches the list.
import { MESSAGE_ICON, NEEDS_INPUT_ICON, SAFETY_OFF_ICON } from "../icons.js";
import { kidsBadge } from "../util.js";

interface Entry {
  /** Classes on the mark, or badge markup when `badge` is set. */
  mark: string;
  badge?: boolean;
  name: string;
  text: string;
}

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: "Activity",
    entries: [
      {
        mark: "running",
        name: "Working",
        text: "Running its own turn.",
      },
      {
        mark: "working",
        name: "Subagent working",
        text: "Its own turn is done, but a subagent below it is working.",
      },
      {
        mark: "waiting",
        name: "Background work",
        text: "Its turn is done, but a background shell it started is still running, or one below it has one.",
      },
      {
        mark: "needs-input",
        name: "Needs input",
        text: "Finished a turn you haven't looked at yet. It clears when you open the conversation. Only for conversations you've messaged.",
      },
      {
        mark: "idle",
        name: "Idle",
        text: "Nothing running.",
      },
    ],
  },
  {
    title: "Taken over",
    entries: [
      {
        mark: "taken-over held",
        name: "Taken over, idle",
        text: "You took control of it. It answers only you and doesn't report to its parent; agents can't delete it.",
      },
      {
        mark: "running held",
        name: "Taken over, working",
        text: "The same spinners in orange: thick for its own turn, thin for a subagent below it.",
      },
    ],
  },
  {
    title: "Problems",
    entries: [
      {
        mark: "interrupting",
        name: "Stopping",
        text: "You pressed Stop; the turn is shutting down.",
      },
      {
        mark: "interrupted",
        name: "Interrupted",
        text: "The last turn was stopped, by you or by a server restart. Send a message to continue.",
      },
      {
        mark: "error",
        name: "Error",
        text: "The last turn failed. Open it to see the error.",
      },
      {
        mark: "deleting",
        name: "Deleting",
        text: "Being deleted.",
      },
      {
        mark: "unknown",
        name: "Unknown",
        text: "The server reported a state this page doesn't recognize. Reloading usually fixes it.",
      },
    ],
  },
  {
    title: "Badges",
    entries: [
      {
        mark: `<span class="badge accent kids">${kidsBadge(3)}</span>`,
        badge: true,
        name: "Subagents",
        text: "How many subagents it has.",
      },
      {
        mark: `<span class="badge warn queue-badge"><span>2</span>${MESSAGE_ICON}</span>`,
        badge: true,
        name: "Queued messages",
        text: "Messages waiting to be read at its next step.",
      },
      {
        mark: `<span class="safety-off-tag">${SAFETY_OFF_ICON}</span>`,
        badge: true,
        name: "Safety review off",
        text: "Its tool calls run without the safety reviewer.",
      },
    ],
  },
];

export function buildStatusLegend(body: HTMLElement): void {
  const host = document.createElement("div");
  host.id = "status-legend";
  for (const group of GROUPS) {
    const section = document.createElement("section");
    section.className = "shortcut-group";
    const title = document.createElement("div");
    title.className = "shortcut-title";
    title.textContent = group.title;
    section.append(title);
    for (const entry of group.entries) {
      const row = document.createElement("div");
      row.className = "agent status-legend-row";
      const mark = document.createElement("span");
      mark.className = "status-legend-mark";
      if (entry.badge) mark.innerHTML = entry.mark;
      else {
        const state = document.createElement("span");
        state.className = `agent-state ${entry.mark}`;
        const inner = document.createElement("span");
        inner.className = "state-mark";
        if (entry.mark === "needs-input") inner.innerHTML = NEEDS_INPUT_ICON;
        state.append(inner);
        mark.append(state);
      }
      const name = document.createElement("span");
      name.className = "status-legend-name";
      name.textContent = entry.name;
      const text = document.createElement("span");
      text.className = "status-legend-text";
      text.textContent = entry.text;
      row.append(mark, name, text);
      section.append(row);
    }
    host.append(section);
  }
  body.append(host);
}
