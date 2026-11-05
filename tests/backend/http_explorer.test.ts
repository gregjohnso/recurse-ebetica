import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost, until } from "./fixtures/durable_host/host";
import { captureFixture } from "./fixture_subprocess";
import { buildConversationsApp } from "./http_conversations_app";
import { exchange, normalise, requestBytes } from "./http_corpus";
import { buildAuthApp } from "./http_auth_app";
import { BackendKeys } from "../../src/auth/backend_keys";
import { registerExplorerRoutes } from "../../src/web/explorer";

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
  await mkdir(join(repo, "huge"));
  for (let index = 0; index < 10_050; index++)
    await writeFile(join(repo, "huge", `h${index}`), "");
  await writeFile(join(repo, ":(exclude)b"), "pathspec-shaped name\n");
  await writeFile(join(repo, "doc.pdf"), "%PDF-1.4\n");
  const secrets = [
    ".git/config",
    ".ssh/known_hosts",
    ".kube/config",
    ".docker/config.json",
    ".config/gh/hosts.yml",
    ".vault-token",
    "terraform.tfstate.backup",
    ".htpasswd",
  ];
  for (const path of secrets.slice(1)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), "secret\n");
  }
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
    expect(names.slice(0, 9)).toEqual([
      ".config",
      ".docker",
      ".git",
      ".kube",
      ".ssh",
      "huge",
      "many",
      "src",
      "Zdir",
    ]);
    expect(names[9]).toBe(".env.local");
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
    expect(byName[":(exclude)b"].ignored).toBe(false);
    expect(byName[".vault-token"].credential).toBe(true);
    expect(byName["big.txt"].size).toBe(1024 * 1024 + 10);

    const many = await json("/tree?path=many");
    expect(many.body.entries.length).toBe(1000);
    expect(many.body.more).toBe(5);
    expect(many.body.more_exact).toBe(true);
    const huge = await json("/tree?path=huge");
    expect(huge.body.entries.length).toBe(1000);
    expect(huge.body.more).toBe(9000);
    expect(huge.body.more_exact).toBe(false);
    expect((await json("/tree?path=.ssh")).body.entries[0].credential).toBe(
      true,
    );
    for (const path of secrets) {
      expect((await get(`/tree/file?path=${path}`)).status).toBe(403);
      expect((await get(`/tree/raw?path=${path}`)).status).toBe(403);
    }

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
    expect((await get("/tree/file?path=pipe")).status).toBe(422);
    expect((await get("/tree/raw?path=pipe")).status).toBe(422);
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
    for (const [path, kind] of [
      ["pic.png", "image"],
      ["doc.pdf", "pdf"],
    ]) {
      const response = await get(`/tree/file?path=${path}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(((await response.json()) as any).kind).toBe(kind);
    }
    const head = normalise(
      await exchange(
        built.running.port,
        requestBytes({
          method: "HEAD",
          path: "/api/conversations/conv-a/tree/raw?path=notes.md",
        }),
      ),
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("15");
    const range = await get("/tree/raw?path=notes.md", { range: "bytes=2-6" });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-6/15");
    expect(await range.text()).toBe("Notes");
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

test("explorer refuses relayed agents and Recurse's data directory under the root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-auth-"));
  dirs.push(dir);
  const root = join(dir, "project");
  const data = join(root, "recurse-data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "server.json"), '{"token":"secret"}');
  await writeFile(join(root, "readme.txt"), "hello\n");
  const app = await buildAuthApp(join(dir, "auth"), {
    backendKeys: true,
    extraRoutes: (router) =>
      registerExplorerRoutes(router, {
        store: {
          load: (cid) => (cid === "c1" ? { id: cid } : null),
          effectiveWorkdir: () => root,
        },
        env: process.env,
        dataDir: data,
      }),
  });
  const { key } = await new BackendKeys(join(dir, "auth")).mint("home");
  const call = (path: string, agent?: string) =>
    fetch(`http://127.0.0.1:${app.running.port}/api/conversations/c1${path}`, {
      headers: {
        authorization: `Bearer ${key}`,
        ...(agent ? { "x-recurse-agent-caller": agent } : {}),
      },
    });
  try {
    expect((await call("/tree/file?path=readme.txt")).status).toBe(200);
    const relayed = await call("/tree/file?path=readme.txt", "worker-1");
    expect(relayed.status).toBe(403);
    expect(((await relayed.json()) as any).detail).toBe(
      "only the operator can browse files",
    );
    expect((await call("/tree", "worker-1")).status).toBe(403);
    const listing = (await (
      await call("/tree?path=recurse-data")
    ).json()) as any;
    expect(listing.entries[0]).toMatchObject({
      name: "server.json",
      credential: true,
    });
    expect(
      (await call("/tree/file?path=recurse-data/server.json")).status,
    ).toBe(403);
    expect((await call("/tree/raw?path=recurse-data/server.json")).status).toBe(
      403,
    );
  } finally {
    await app.running.close();
  }
});

test("explorer previews managed worktrees but not the rest of Recurse's data directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "explorer-data-"));
  dirs.push(dir);
  const data = join(dir, "data");
  const tree = join(data, "worktrees", "x");
  await mkdir(join(tree, "src"), { recursive: true });
  await mkdir(join(data, "worktrees", ".markers"), { recursive: true });
  await writeFile(join(tree, "src", "app.ts"), "export {};\n");
  await writeFile(join(data, "worktrees", ".markers", "x.json"), "{}");
  await writeFile(join(data, "server.json"), '{"token":"secret"}');
  let root = tree;
  const app = await buildAuthApp(join(dir, "auth"), {
    backendKeys: true,
    extraRoutes: (router) =>
      registerExplorerRoutes(router, {
        store: {
          load: (cid) => ({ id: cid }),
          effectiveWorkdir: () => root,
        },
        env: process.env,
        dataDir: data,
      }),
  });
  const { key } = await new BackendKeys(join(dir, "auth")).mint("home");
  const status = async (path: string) =>
    (
      await fetch(
        `http://127.0.0.1:${app.running.port}/api/conversations/c1/tree/file?path=${path}`,
        { headers: { authorization: `Bearer ${key}` } },
      )
    ).status;
  try {
    expect(await status("src/app.ts")).toBe(200);
    root = data;
    expect(await status("server.json")).toBe(403);
    expect(await status("worktrees/x/src/app.ts")).toBe(200);
    expect(await status("worktrees/.markers/x.json")).toBe(403);
    root = dir;
    expect(await status("data/server.json")).toBe(403);
    expect(await status("data/worktrees/x/src/app.ts")).toBe(200);
    await symlink(data, join(data, "worktrees", "y"));
    root = join(data, "worktrees", "y");
    expect(await status("server.json")).toBe(403);
  } finally {
    await app.running.close();
  }
});
