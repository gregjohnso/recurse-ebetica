// Keeps every working spinner in phase. A CSS animation starts when its
// element appears, so rows rendered at different times would spin out of step;
// pinning each `state-spin` animation to the document timeline's zero aligns
// the sidebar marks, the conversation header and the live panel.
document.addEventListener("animationstart", (event) => {
  if (event.animationName !== "state-spin") return;
  for (const animation of (event.target as Element).getAnimations())
    if ((animation as CSSAnimation).animationName === "state-spin")
      animation.startTime = 0;
});
