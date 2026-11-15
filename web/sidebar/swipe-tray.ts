// Phone row-swipe trays: Mail-style round actions beside a row slid aside.
// One tray at a time, fixed over the row's untransformed place; sidebar.ts owns
// the gesture, the row's transform and the repaint after the tray closes.
import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { HoldItem } from "./hold.js";

export type TraySide = "left" | "right";
/** Horizontal room each round action takes, in CSS pixels. */
export const TRAY_ACTION_WIDTH = 72;

let host: HTMLElement | null = null;
let open = false;

export const trayWidth = (items: readonly HoldItem[]): number =>
  items.length * TRAY_ACTION_WIDTH;

/** Whether a tray is held open (not merely shown during a drag). */
export const trayOpen = (): boolean => open;

export const trayContains = (node: EventTarget | null): boolean =>
  !!host && node instanceof Node && host.contains(node);

/** Show `items` on `side` of `rect` (the row's place), `width` px revealed;
 * `held` keeps it open after lifting; `close` runs before an action. */
export function paintTray(
  rect: DOMRect,
  side: TraySide,
  items: readonly HoldItem[],
  width: number,
  held: boolean,
  close: () => void,
  full: HoldItem | null = null,
): void {
  if (!host) {
    host = document.createElement("div");
    host.className = "swipe-tray";
    document.body.append(host);
  }
  open = held;
  host.dataset.side = side;
  host.classList.toggle("full", !!full);
  host.hidden = false;
  Object.assign(host.style, {
    top: `${rect.top}px`,
    height: `${rect.height}px`,
    width: `${Math.max(0, width)}px`,
    left: `${side === "left" ? rect.left : rect.right - width}px`,
  });
  render(
    html`${items.map(
      (item) =>
        html`<button
          type="button"
          class=${item === full ? "swipe-action armed" : "swipe-action"}
          data-action=${item.label}
          aria-label=${item.label}
          @click=${(event: Event) => {
            const anchor = (
              event.currentTarget as HTMLElement
            ).getBoundingClientRect();
            close();
            item.run(anchor);
          }}
        >
          <span class="swipe-action-icon" aria-hidden="true"
            >${unsafeHTML(item.icon)}</span
          >
          <span class="swipe-action-label">${item.label}</span>
        </button>`,
    )}`,
    host,
  );
}

export function hideTray(): void {
  open = false;
  if (!host) return;
  host.hidden = true;
  host.classList.remove("full");
  render(nothing, host);
}
