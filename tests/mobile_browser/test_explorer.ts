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

const dockLayout = (page: Page) =>
  page.evaluate(() =>
    [...(globalThis as any).document.querySelectorAll(".dv-groupview")]
      .map((group: any) =>
        [...group.querySelectorAll(".dv-tab")].map((tab: any) =>
          tab.textContent.trim(),
        ),
      )
      .sort(),
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
    const explorerGroup = page
      .locator(".dv-groupview")
      .filter({ has: page.locator(".dv-tab", { hasText: "Explorer" }) });
    const explorerWidth = (await explorerGroup.boundingBox())!.width;
    await guide.press("Enter");
    const pane = page.locator('.pane-col[data-pane="explorer"]');
    const guideTab = page.locator(".dv-tab", { hasText: "guide.md" });
    const guideDoc = page.locator(".dock-panel h1", {
      hasText: "Explorer guide",
    });
    await guideDoc.waitFor();
    expect(
      Math.abs((await explorerGroup.boundingBox())!.width - explorerWidth),
    ).toBeLessThanOrEqual(2);
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
    expect(await tabs.count()).toBe(4);
    expect(await page.locator(".dv-groupview").count()).toBe(3);
    await guideTab.click();
    await guideDoc.waitFor();
    expect(await readmeDoc.isVisible()).toBe(false);
    await readme.click();
    await readmeDoc.waitFor();
    expect(await tabs.count()).toBe(4);
    const groups = page.locator(".dv-groupview");
    const readmeBox = (await readmeDoc.boundingBox())!;
    const filesGroup = (await groups
      .filter({ has: tabs.filter({ hasText: "README.md" }) })
      .boundingBox())!;
    await guideTab.dragTo(page.locator("body"), {
      targetPosition: {
        x: filesGroup.x + filesGroup.width / 2,
        y: filesGroup.y + filesGroup.height - 30,
      },
    });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelectorAll(".dv-groupview")
          .length === 4,
    );
    expect(await guideDoc.isVisible()).toBe(true);
    await readmeDoc.waitFor();
    await tree.locator('[data-path=".gitignore"]').click();
    const ignoreTab = tabs.filter({ hasText: ".gitignore" });
    await ignoreTab.waitFor();
    expect(await groups.count()).toBe(4);
    expect(
      await groups.filter({ has: guideTab }).filter({ has: ignoreTab }).count(),
    ).toBe(1);
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_SCREENSHOT_DIR}/dock-split.png`,
      });
    const arranged = await dockLayout(page);
    await page.waitForFunction(() =>
      Object.values((globalThis as any).localStorage).some((value) =>
        String(value).includes("file:.gitignore"),
      ),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await ignoreTab.waitFor();
    expect(await dockLayout(page)).toEqual(arranged);
    await page.locator(".agent", { hasText: "Agent" }).first().click();
    await ignoreTab.waitFor({ state: "detached" });
    expect(await dockLayout(page)).toEqual([["Chat"]]);
    await page.locator(".agent", { hasText: "Explorer demo" }).click();
    await ignoreTab.waitFor();
    expect(await dockLayout(page)).toEqual(arranged);
    await ignoreTab.hover();
    await ignoreTab.locator(".dv-default-tab-action").click();
    await guideTab.hover();
    await guideTab.locator(".dv-default-tab-action").click();
    await guideTab.waitFor({ state: "detached" });
    expect(await tabs.count()).toBe(3);
    const chatTab = tabs.filter({ hasText: "Chat" });
    const input = page.locator("#input");
    await input.fill("draft survives the move");
    await input.press("ArrowLeft");
    await chatTab.dragTo(page.locator("body"), {
      targetPosition: {
        x: readmeBox.x + readmeBox.width / 2,
        y: readmeBox.y + 120,
      },
    });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelectorAll(".dv-groupview")
          .length === 2,
    );
    expect(await input.inputValue()).toBe("draft survives the move");
    expect(await input.isVisible()).toBe(true);
    expect(
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return [doc.activeElement?.id, doc.activeElement?.selectionStart];
      }),
    ).toEqual(["input", 22]);
    expect(await readmeDoc.isVisible()).toBe(false);
    await tabs.filter({ hasText: "README.md" }).click();
    await readmeDoc.waitFor();
    expect(await input.isVisible()).toBe(false);
    await chatTab.click();
    await input.waitFor();
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_SCREENSHOT_DIR}/dock-chat.png`,
      });
    await chatTab.hover();
    await chatTab.locator(".dv-default-tab-action").click();
    await chatTab.waitFor({ state: "detached" });
    expect(await input.isVisible()).toBe(false);
    const chatButton = page.locator("#chat-btn");
    expect(await chatButton.getAttribute("aria-pressed")).toBe("false");
    await page.locator("body").press("i");
    await chatTab.waitFor();
    await page.waitForFunction(
      () => (globalThis as any).document.activeElement?.id === "input",
    );
    expect(await input.inputValue()).toBe("draft survives the move");
    await chatTab.hover();
    await chatTab.locator(".dv-default-tab-action").click();
    await chatTab.waitFor({ state: "detached" });
    await chatButton.click();
    await chatTab.waitFor();
    await input.waitFor();
    await page.waitForFunction(
      () => (globalThis as any).document.activeElement?.id === "input",
    );
    await panels.first().click();
    await page.locator("#explorer").waitFor({ state: "detached" });
    await page.locator("body").press("E");
    await docs.waitFor();
    await tree.locator('[data-path=".gitignore"]').click();
    await ignoreTab.waitFor();
    const ignoreText = page.locator(".dock-panel pre.report-doc", {
      hasText: "*.log",
    });
    await ignoreText.waitFor();
    const span = await ignoreText.evaluate((pre: any) => {
      const node = pre.ownerDocument.createTreeWalker(pre, 4).nextNode();
      const range = pre.ownerDocument.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 5);
      const rect = range.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        y: (rect.top + rect.bottom) / 2,
      };
    });
    await page.mouse.move(span.left + 1, span.y);
    await page.mouse.down();
    await page.mouse.move(span.right - 1, span.y, { steps: 8 });
    await page.mouse.up();
    const popover = page.locator(".report-comment-popover");
    await popover.waitFor();
    await popover.locator("textarea").fill("Why ignore logs?");
    await popover.getByRole("button", { name: "Comment" }).click();
    const filePanel = page.locator(".dock-panel", {
      has: page.locator("pre.report-doc", { hasText: "*.log" }),
    });
    await filePanel.locator(".report-comment").waitFor();
    const delivered = page.waitForRequest((request) =>
      request.url().endsWith(`/api/conversations/${cid}/deliver`),
    );
    await filePanel.getByRole("button", { name: "Submit comments" }).click();
    expect((await delivered).postDataJSON().content).toMatch(
      /^Comments on file "\.gitignore" \(path: \/\S+\/\.gitignore\):\n\n- line 1, chars 0-5:\n> \*\.log\nWhy ignore logs\?$/,
    );
    await page.evaluate(() => {
      const storage = (globalThis as any).localStorage;
      for (const key of Object.keys(storage)) {
        const raw = String(storage.getItem(key));
        if (raw.includes('"grid"'))
          storage.setItem(key, raw.replaceAll('"grid"', '"grip"'));
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".dv-tab", { hasText: "Chat" }).waitFor();
    await page.locator(".dv-tab", { hasText: "Explorer" }).waitFor();
    expect(await dockLayout(page)).toEqual([["Chat"], ["Explorer"]]);
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
