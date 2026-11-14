import { expect } from "bun:test";
import type { Page } from "playwright";
import {
  captureErrors,
  postFixture,
  runBrowserTests,
  showAgentList,
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

const conversationReads = (page: Page, cid: string): string[] => {
  const reads: string[] = [];
  page.on("request", (request) => {
    if (
      request.headers()["x-recurse-trace"] &&
      request.url().includes(`/api/conversations/${cid}`)
    )
      reads.push(request.url());
  });
  return reads;
};

export const tests: BrowserTest[] = [
  // Feature: #0 Explorer HTML files render in the offline sandbox, with their source a toggle away
  async function test_explorer_html_page(browser, base) {
    const { cid } = await postFixture(base, "seed-explorer");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${cid}`, { waitUntil: "domcontentloaded" });
    await page.locator("#conv-title", { hasText: "Explorer demo" }).waitFor();
    await page.locator('#pane-rail-panels [data-pane="explorer"]').click();
    const tree = page.locator("#explorer .explorer-tree");
    await tree.locator('[role="treeitem"][data-path="docs"]').click();
    await tree.locator('[data-path="docs/page.html"]').click();
    const tab = page.locator(".dock-panel", {
      has: page.locator(".explorer-view-toggle"),
    });
    const frame = tab.locator("iframe.report-embed");
    await frame.waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await frame.getAttribute("srcdoc")).toStartWith(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';',
    );
    await page
      .frameLocator(".dock-panel iframe.report-embed")
      .locator("h1", { hasText: "Rendered page" })
      .waitFor();
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_SCREENSHOT_DIR}/explorer-html.png`,
      });
    await tab.getByRole("button", { name: "Source" }).click();
    expect(await frame.count()).toBe(0);
    await tab
      .locator("pre.report-doc", { hasText: '<h1 id="t">Static page</h1>' })
      .waitFor();
    await tab.getByRole("button", { name: "Preview" }).click();
    await frame.waitFor();
    await page.locator(".dv-tab", { hasText: "Explorer" }).click();
    await tree.locator('[data-path="docs/plot.md"]').click();
    const figure = page.locator(
      '.dock-panel .files-markdown img[alt="Plot"]:not([hidden])',
    );
    await figure.waitFor();
    const wide = page.locator(
      '.dock-panel .files-markdown img[alt="Wide"]:not([hidden])',
    );
    await wide.waitFor();
    const share = await wide.evaluate((image) => {
      const column = image.closest(".files-markdown")!;
      const style = (globalThis as any).getComputedStyle(column);
      const inner =
        column.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      return image.getBoundingClientRect().width / inner;
    });
    expect(share).toBeCloseTo(0.5, 2);
    await figure.dblclick();
    const viewer = page.locator("dialog.image-popout");
    const shown = viewer.locator(".files-detail img.files-image");
    await shown.waitFor();
    expect(await viewer.locator(".files-name").innerText()).toBe("plot.png");
    expect(await shown.getAttribute("src")).toContain("/tree/raw");
    expect(
      await viewer.getByRole("button", { name: "Open in Files" }).count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    expect(
      errors.filter((error) => !error.includes("directive 'navigate-to'")),
    ).toEqual([]);
    await context.close();
  },
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
    expect(rail.indexOf("share-link-btn")).toBe(rail.length - 2);
    expect(rail.slice(-1)).toEqual(["pane-rail-panels"]);
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
    const groups = page.locator(".dv-groupview");
    const tabs = page.locator(".dv-tab");
    expect(await dockLayout(page)).toEqual([["Chat"], ["Explorer"]]);
    const chatGroup = (await groups.first().boundingBox())!;
    await tabs.filter({ hasText: "Explorer" }).dragTo(page.locator("body"), {
      targetPosition: {
        x: chatGroup.x + chatGroup.width / 2,
        y: chatGroup.y + chatGroup.height / 2,
      },
    });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelectorAll(".dv-groupview")
          .length === 1,
    );
    expect(await dockLayout(page)).toEqual([["Chat", "Explorer"]]);
    await guide.press("Enter");
    const pane = page.locator('.pane-col[data-pane="explorer"]');
    const guideTab = tabs.filter({ hasText: "guide.md" });
    const guideDoc = page.locator(".dock-panel h1", {
      hasText: "Explorer guide",
    });
    await guideDoc.waitFor();
    expect(await dockLayout(page)).toEqual([["Chat", "Explorer", "guide.md"]]);
    expect(
      await guideTab
        .locator(
          'xpath=self::*[@title="docs/guide.md"] | .//*[@title="docs/guide.md"]',
        )
        .count(),
    ).toBe(1);
    expect(await guideDoc.locator("xpath=..").locator("li").count()).toBe(2);
    const explorerTab = tabs.filter({ hasText: "Explorer" });
    await explorerTab.click();
    await docs.waitFor();
    const edgeDrop = async (tab: typeof tabs, x: number, y: number) => {
      const count = await groups.count();
      await tab.dragTo(page.locator("body"), { targetPosition: { x, y } });
      await page.waitForFunction(
        (count) =>
          (globalThis as any).document.querySelectorAll(".dv-groupview")
            .length ===
          count + 1,
        count,
      );
    };
    const whole = (await groups.first().boundingBox())!;
    await edgeDrop(explorerTab, whole.x + 12, whole.y + whole.height / 2);
    expect(await dockLayout(page)).toEqual([
      ["Chat", "guide.md"],
      ["Explorer"],
    ]);
    expect(await pane.isVisible()).toBe(true);
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
    expect(await dockLayout(page)).toEqual([
      ["Chat", "guide.md", "README.md"],
      ["Explorer"],
    ]);
    await guideTab.click();
    await guideDoc.waitFor();
    expect(await readmeDoc.isVisible()).toBe(false);
    await readme.click();
    await readmeDoc.waitFor();
    expect(await tabs.count()).toBe(4);
    const reloads = conversationReads(page, cid);
    await page.locator(".agent.selected", { hasText: "Explorer demo" }).click();
    await page.waitForFunction(
      () => (globalThis as any).document.activeElement?.id === "input",
    );
    expect(await page.locator("#input").isVisible()).toBe(true);
    expect(await readmeDoc.isVisible()).toBe(false);
    expect(
      await page.locator(".dv-tab.dv-active-tab", { hasText: "Chat" }).count(),
    ).toBe(1);
    expect(reloads).toEqual([]);
    await tabs.filter({ hasText: "README.md" }).click();
    await readmeDoc.waitFor();
    await panels.first().click();
    await page.locator("#explorer").waitFor({ state: "detached" });
    expect(await dockLayout(page)).toEqual([["Chat", "guide.md", "README.md"]]);
    await panels.first().click();
    await docs.waitFor();
    expect(await dockLayout(page)).toEqual([
      ["Chat", "guide.md", "README.md"],
      ["Explorer"],
    ]);
    const files = (await groups.first().boundingBox())!;
    await explorerTab.dragTo(page.locator("body"), {
      targetPosition: { x: files.x + 12, y: files.y + files.height / 2 },
    });
    await page.waitForFunction(
      (left) =>
        [...(globalThis as any).document.querySelectorAll(".dv-groupview")]
          .find((group: any) => group.textContent.includes("Explorer"))
          ?.getBoundingClientRect().left <
        left + 20,
      files.x,
    );
    const readmeBox = (await readmeDoc.boundingBox())!;
    const filesGroup = (await groups
      .filter({ has: tabs.filter({ hasText: "README.md" }) })
      .boundingBox())!;
    await guideTab.click();
    await guideDoc.waitFor();
    await edgeDrop(
      guideTab,
      filesGroup.x + filesGroup.width / 2,
      filesGroup.y + filesGroup.height - 30,
    );
    expect(await guideDoc.isVisible()).toBe(true);
    await readmeDoc.waitFor();
    await tree.locator('[data-path=".gitignore"]').click();
    const ignoreTab = tabs.filter({ hasText: ".gitignore" });
    await ignoreTab.waitFor();
    expect(await groups.count()).toBe(3);
    expect(
      await groups
        .filter({ has: tabs.filter({ hasText: "README.md" }) })
        .filter({ has: ignoreTab })
        .count(),
    ).toBe(1);
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_SCREENSHOT_DIR}/dock-split.png`,
      });
    const heights = await page.evaluate(() => {
      const document = (globalThis as any).document;
      const height = (selector: string) =>
        document.querySelector(selector).getBoundingClientRect().height;
      return [height("#agent-list .agent.selected"), height("#dock .dv-tab")];
    });
    expect(Math.abs(heights[0] - heights[1])).toBeLessThan(0.5);
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
    await chatTab.click();
    await input.fill("draft survives the move");
    await input.press("ArrowLeft");
    await edgeDrop(
      chatTab,
      readmeBox.x + readmeBox.width - 12,
      readmeBox.y + readmeBox.height / 2,
    );
    expect(await input.inputValue()).toBe("draft survives the move");
    expect(await input.isVisible()).toBe(true);
    expect(
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        return [doc.activeElement?.id, doc.activeElement?.selectionStart];
      }),
    ).toEqual(["input", 22]);
    expect(await readmeDoc.isVisible()).toBe(true);
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
    await page.addInitScript(() => {
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
    await mobile.locator("#menu-btn").click();
    await phonePane.waitFor({ state: "hidden" });
    await showAgentList(mobile);
    const phoneReloads = conversationReads(mobile, cid);
    await mobile
      .locator(".agent.selected", { hasText: "Explorer demo" })
      .click();
    await mobile.locator("html:not(.phone-list) #sidebar[inert]").waitFor({
      state: "attached",
    });
    expect(
      await mobile
        .locator("#conv-title", { hasText: "Explorer demo" })
        .isVisible(),
    ).toBe(true);
    expect(await phonePane.isVisible()).toBe(false);
    expect(phoneReloads).toEqual([]);
    expect(phoneErrors).toEqual([]);
    await phone.close();
  },

  // Feature: #0 a closed window reopens where it was, by its tab or the rail
  async function test_dock_reopens_where_closed(browser, base) {
    const { cid } = await postFixture(base, "seed-explorer");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${cid}`, { waitUntil: "domcontentloaded" });
    const button = page.locator('#pane-rail-panels [data-pane="explorer"]');
    await button.click();
    const explorer = page.locator(".dv-tab", { hasText: "Explorer" });
    await explorer.waitFor();
    const left = (name: string) =>
      page.evaluate(
        (name) =>
          [...(globalThis as any).document.querySelectorAll(".dv-groupview")]
            .find((group: any) => group.textContent.includes(name))
            .getBoundingClientRect().left,
        name,
      );
    const chat = (await page.locator(".dv-groupview").first().boundingBox())!;
    await explorer.dragTo(page.locator("body"), {
      targetPosition: { x: chat.x + 12, y: chat.y + chat.height / 2 },
    });
    await page.waitForFunction(() => {
      const groups = [
        ...(globalThis as any).document.querySelectorAll(".dv-groupview"),
      ];
      const at = (name: string) =>
        groups
          .find((group: any) => group.textContent.includes(name))
          ?.getBoundingClientRect().left;
      return at("Explorer") < at("Chat");
    });
    const placed = await left("Explorer");
    expect(placed).toBeLessThan(await left("Chat"));
    await explorer.hover();
    await explorer.locator(".dv-default-tab-action").click();
    await explorer.waitFor({ state: "detached" });
    await button.click();
    await explorer.waitFor();
    expect(await dockLayout(page)).toEqual([["Chat"], ["Explorer"]]);
    expect(await left("Explorer")).toBeCloseTo(placed, 0);
    await button.click();
    await explorer.waitFor({ state: "detached" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".dv-tab", { hasText: "Chat" }).waitFor();
    await button.click();
    await explorer.waitFor();
    expect(await left("Explorer")).toBeCloseTo(placed, 0);
    expect(await left("Explorer")).toBeLessThan(await left("Chat"));
    expect(errors).toEqual([]);
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["explorer", tests]]);
