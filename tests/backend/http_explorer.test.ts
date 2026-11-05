import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost, until } from "./fixtures/durable_host/host";
import { captureFixture } from "./fixture_subprocess";
import { buildConversationsApp } from "./http_conversations_app";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52,
]);

test("explorer lists and previews the conversation cwd without leaving it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-"));
  dirs.push(dir);
  const { host, faux, records } = fauxHost(dir);
  const built = await buildConversationsApp(dir, {
    patch: (deps, world) => {
      const conv = { ...world.load("conv-a")!, backend: "durable" };
      world.convs.set("conv-a", conv);
      records["conv-a"] = conv;
      Object.assign(deps, { durable: host });
    },
  });
  const repo = String(records["conv-a"]!.workdir);
  const outside = join(dir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside the root\n");
  await writeFile(join(repo, ".gitignore"), "*.log\n");
  await writeFile(join(repo, "app.log"), "ignored\n");
  await writeFile(join(repo, "notes.md"), "# Notes\n\nhello\n");
  await writeFile(join(repo, ".env.local"), "TOKEN=secret\n");
  await writeFile(join(repo, "server.pem"), "-----BEGIN-----\n");
  await writeFile(join(repo, "big.txt"), "a".repeat(1024 * 1024 + 10));
  await writeFile(join(repo, "blob.bin"), new Uint8Array([1, 0, 2, 3]));
  await writeFile(join(repo, "pic.png"), PNG);
  await writeFile(join(repo, "fake.png"), "<svg onload=alert(1)>");
  await mkdir(join(repo, "many"));
  for (let index = 0; index < 1005; index++)
    await writeFile(join(repo, "many", `f${index}.txt`), "");
  await mkdir(join(repo, "Zdir"));
  await symlink(join(outside, "secret.txt"), join(repo, "link-file"));
  await symlink(outside, join(repo, "link-dir"));
  expect(
    (await captureFixture(["mkfifo", join(repo, "pipe")], { cwd: repo }))
      .exitCode,
  ).toBe(0);
  const base = `http://127.0.0.1:${built.running.port}/api/conversations/conv-a`;
  const get = (suffix: string, headers: Record<string, string> = {}) =>
    fetch(base + suffix, { headers });
  const json = async (suffix: string) => {
    const response = await get(suffix);
    return { status: response.status, body: (await response.json()) as any };
  };
  try {
    const root = await json("/tree");
    expect(root.status).toBe(200);
    expect(root.body.root).toBe(repo);
    expect(root.body.git_prefix).toBe("");
    const names = root.body.entries.map((entry: any) => entry.name);
    expect(names.slice(0, 5)).toEqual([
      ".git",
      "many",
      "src",
      "Zdir",
      ".env.local",
    ]);
    expect(names.indexOf("app.log")).toBeLessThan(names.indexOf("big.txt"));
    const byName = Object.fromEntries(
      root.body.entries.map((entry: any) => [entry.name, entry]),
    );
    expect(byName["app.log"].ignored).toBe(true);
    expect(byName["notes.md"].ignored).toBe(false);
    expect(byName["link-file"]).toMatchObject({
      type: "symlink",
      symlink: true,
    });
    expect(byName["link-dir"]).toMatchObject({
      type: "symlink",
      symlink: true,
    });
    expect(byName.pipe.type).toBe("other");
    expect(byName[".env.local"].credential).toBe(true);
    expect(byName["server.pem"].credential).toBe(true);
    expect(byName["big.txt"].size).toBe(1024 * 1024 + 10);

    const many = await json("/tree?path=many");
    expect(many.body.entries.length).toBe(1000);
    expect(many.body.more).toBe(5);

    for (const path of [
      "..",
      "../outside",
      "/etc",
      "many//f1.txt",
      "./many",
      "many/\0",
    ])
      expect((await get(`/tree?path=${encodeURIComponent(path)}`)).status).toBe(
        422,
      );
    expect((await get("/tree?path=link-dir")).status).toBe(422);
    expect((await get("/tree/file?path=link-file")).status).toBe(422);
    expect((await get("/tree/file?path=link-dir/secret.txt")).status).toBe(422);
    expect((await get("/tree/raw?path=link-file")).status).toBe(422);
    const started = performance.now();
    expect((await get("/tree/file?path=pipe")).status).toBe(422);
    expect(performance.now() - started).toBeLessThan(2000);
    for (const path of [".env.local", "server.pem"]) {
      expect((await get(`/tree/file?path=${path}`)).status).toBe(403);
      expect((await get(`/tree/raw?path=${path}`)).status).toBe(403);
    }
    expect((await get("/tree", { "x-recurse-agent": "conv-b" })).status).toBe(
      403,
    );

    const notes = await json("/tree/file?path=notes.md");
    expect(notes.body).toMatchObject({
      kind: "text",
      text: "# Notes\n\nhello\n",
      truncated: false,
    });
    const big = await json("/tree/file?path=big.txt");
    expect(big.body.kind).toBe("text");
    expect(big.body.truncated).toBe(true);
    expect(big.body.text.length).toBe(1024 * 1024);
    expect((await json("/tree/file?path=blob.bin")).body.kind).toBe("binary");
    expect((await json("/tree/file?path=pic.png")).body.kind).toBe("image");
    expect((await json("/tree/file?path=fake.png")).body.kind).toBe("text");
    const image = await get("/tree/raw?path=pic.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toStartWith("inline");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    const fake = await get("/tree/raw?path=fake.png");
    expect(fake.headers.get("content-type")).toBe("application/octet-stream");
    expect(fake.headers.get("content-disposition")).toStartWith("attachment");
    expect(fake.headers.get("content-security-policy")).toContain("sandbox");

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("chdir", { directory: join(repo, "src") }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("changed directory"),
    ]);
    await host.send("conv-a", "Change into src", "explorer-chdir");
    await until(
      () =>
        host.runningCount() === 0 &&
        host.metadata("conv-a").pending.length === 0,
    );
    const moved = await json("/tree");
    expect(moved.body.root).toBe(join(repo, "src"));
    expect(moved.body.git_prefix).toBe("src/");
    expect(moved.body.entries.map((entry: any) => entry.name)).toEqual([
      "app.txt",
    ]);
    expect((await get("/tree/file?path=..%2Fnotes.md")).status).toBe(422);
  } finally {
    await built.running.close();
    await host.close();
  }
});
