// Settings > Keyboard shortcuts: the sole shortcuts reference, rendered from
// the keymap's dispatch metadata with the live platform modifier spelling.
import { SHORTCUT_GROUPS, formatShortcutKey } from "../keymap.js";
import { chordLabel } from "../state.js";

export function buildShortcutsSection(body: HTMLElement): void {
  const host = document.createElement("div");
  host.id = "shortcut-groups";
  for (const group of SHORTCUT_GROUPS) {
    const section = document.createElement("section");
    section.className = "shortcut-group";
    const title = document.createElement("div");
    title.className = "shortcut-title";
    title.textContent = group.title;
    const keys = document.createElement("div");
    keys.className = "keys";
    for (const item of group.items) {
      const row = document.createElement("span");
      row.className = "k";
      item.keys.forEach((raw, index) => {
        const key = document.createElement("kbd");
        if (item.platform) {
          const shifted = !!item.shift && index === 0;
          key.textContent = chordLabel(raw, shifted, shifted);
        } else key.textContent = formatShortcutKey(raw);
        row.appendChild(key);
      });
      row.append(document.createTextNode(item.description));
      keys.appendChild(row);
    }
    section.append(title, keys);
    host.appendChild(section);
  }
  body.append(host);
}
