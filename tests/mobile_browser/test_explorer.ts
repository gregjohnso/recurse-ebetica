import { expect } from "bun:test";
import type { Page } from "playwright";
import {
  captureErrors,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

const focused = (page: Page, path: string) =>
  page.waitForFunction(
    `document.activeElement?.getAttribute("data-path") === ${JSON.stringify(path)}`,
  );

export const tests: BrowserTest[] = [
  // Feature: #0 the Explorer browses and previews the conversation's working folder
  async function test_explorer_desktop_and_phone(browser, base) {
    const { cid } = await postFixture(base, "seed-explorer");
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await desktop.newPage();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${cid}`, { waitUntil: "domcontentloaded" });
    await page.locator("#conv-title", { hasText: "Explorer demo" }).waitFor();
    await page.locator('#pane-rail-panels [data-pane="explorer"]').waitFor();
    const rail = await page
      .locator("#pane-rail > *")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.id || node.getAttribute("data-pane") || ""),
      );
    expect(rail.indexOf("share-link-btn")).toBe(rail.length - 3);
    expect(rail.slice(-1)).toEqual(["settings-btn"]);
    const panels = page.locator("#pane-rail-panels .rail-btn[data-pane]");
    expect(await panels.first().getAttribute("data-pane")).toBe("explorer");
    await panels.first().click();
    expect(await page.locator("#agent-list").isVisible()).toBe(true);
    const tree = page.locator("#explorer .explorer-tree");
    const docs = tree.locator('[role="treeitem"][data-path="docs"]');
    await docs.waitFor();
    expect(
      await tree.locator('[data-path="build.log"]').getAttribute("class"),
    ).toContain("ignored");
    expect(
      await tree
        .locator('[role="treeitem"]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-path")),
        ),
    ).toEqual([".git", "docs", ".gitignore", "build.log", "README.md"]);
    await docs.click();
    const guide = tree.locator('[data-path="docs/guide.md"]');
    await guide.waitFor();
    await docs.press("ArrowRight");
    await focused(page, "docs/guide.md");
    await guide.press("Enter");
    const pane = page.locator('.pane-col[data-pane="explorer"]');
    const guideTab = page.locator(".dv-tab", { hasText: "guide.md" });
    const guideDoc = page.locator(".dock-panel h1", {
      hasText: "Explorer guide",
    });
    await guideDoc.waitFor();
    expect(
      await guideTab
        .locator(
          'xpath=self::*[@title="docs/guide.md"] | .//*[@title="docs/guide.md"]',
        )
        .count(),
    ).toBe(1);
    expect(await pane.isVisible()).toBe(true);
    await tree.locator('[data-path="README.md"]').waitFor();
    expect(await guideDoc.locator("xpath=..").locator("li").count()).toBe(2);
    await guide.press("h");
    await focused(page, "docs");
    await docs.press("h");
    expect(await guide.count()).toBe(0);
    const readme = tree.locator('[data-path="README.md"]');
    await readme.click();
    const readmeDoc = page.locator(".dock-panel h1", {
      hasText: "Demo project",
    });
    await readmeDoc.waitFor();
    const tabs = page.locator(".dv-tab");
    expect(await tabs.count()).toBe(3);
    expect(await page.locator(".dv-groupview").count()).toBe(2);
    await guideTab.click();
    await guideDoc.waitFor();
    expect(await readmeDoc.isVisible()).toBe(false);
    await readme.click();
    await readmeDoc.waitFor();
    expect(await tabs.count()).toBe(3);
    const box = (await pane.boundingBox())!;
    await guideTab.dragTo(pane, {
      targetPosition: { x: box.width / 2, y: box.height - 20 },
    });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelectorAll(".dv-groupview")
          .length === 3,
    );
    expect(await guideDoc.isVisible()).toBe(true);
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_SCREENSHOT_DIR}/dock-split.png`,
      });
    await guideTab.locator(".dv-default-tab-action").click();
    await guideTab.waitFor({ state: "detached" });
    expect(await tabs.count()).toBe(2);
    await panels.first().click();
    await page.locator("#explorer").waitFor({ state: "detached" });
    await page.locator("body").press("E");
    await docs.waitFor();
    expect(errors).toEqual([]);
    await desktop.close();

    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mobile = await phone.newPage();
    const phoneErrors = captureErrors(mobile);
    await mobile.goto(`${base}#agent=${cid}`, {
      waitUntil: "domcontentloaded",
    });
    await mobile.locator("#conv-title", { hasText: "Explorer demo" }).waitFor();
    await mobile.locator("#pane-fab").click();
    await mobile.locator('#pane-menu-panels [data-pane="explorer"]').click();
    const phoneReadme = mobile.locator('#explorer [data-path="README.md"]');
    await phoneReadme.click();
    const phonePane = mobile.locator('.pane-col[data-pane="explorer"]');
    await phonePane.locator("h1", { hasText: "Demo project" }).waitFor();
    await phonePane.locator("a", { hasText: "guide" }).click();
    await phonePane.locator("h1", { hasText: "Explorer guide" }).waitFor();
    expect(phoneErrors).toEqual([]);
    await phone.close();
  },
];

if (import.meta.main) await runBrowserTests([["explorer", tests]]);
