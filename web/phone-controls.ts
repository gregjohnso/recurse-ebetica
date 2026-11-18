// Phones show the conversation controls (safety, tokens, model) under the
// title bar instead of above the composer. Scrolling the thread down by hand
// slides them away; scrolling up brings them back.
import { $ } from "./dom.js";

const phone = matchMedia("(max-width: 700px)");
const controls = $("#conv-controls")!;
const home = controls.parentElement!;
const next = controls.nextElementSibling;
const scroll = $("#scroll")!;
let touched = -Infinity;
let last = 0;

function place(): void {
  if (phone.matches) scroll.before(controls);
  else home.insertBefore(controls, next);
  controls.classList.remove("away");
}
place();
phone.addEventListener("change", place);
new ResizeObserver(() =>
  document.documentElement.style.setProperty(
    "--conv-controls-height",
    `${Math.ceil(controls.getBoundingClientRect().height)}px`,
  ),
).observe(controls);
scroll.addEventListener("touchmove", () => (touched = performance.now()), {
  passive: true,
});
scroll.addEventListener(
  "scroll",
  () => {
    // Spec: iOS rubber-banding scrolls past either end and springs back;
    // measuring within the real range keeps that bounce from moving them.
    const end = scroll.scrollHeight - scroll.clientHeight;
    const top = Math.min(Math.max(scroll.scrollTop, 0), end);
    const delta = top - last;
    last = top;
    // Spec: Only the reader's own scrolling (and its momentum) moves them;
    // the thread following a reply does not.
    if (!phone.matches || performance.now() - touched > 1000) return;
    if (Math.abs(delta) < 4) return;
    controls.classList.toggle("away", delta > 0 && top > 0);
  },
  { passive: true },
);
