import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUpload,
  registerFile,
  registeredFile,
  removeFile,
} from "../../src/agents/runtime/attachments/publish";
import {
  MAX_FILE_BYTES,
  MAX_UPLOAD_BYTES,
  readRelatedFiles,
} from "../../src/agents/runtime/attachments/base";
import { registerDocumentFile } from "../../src/agents/runtime/attachments/document";
import { readDownload } from "../../src/agents/runtime/attachments/preview";
import { publishedFiles } from "../../src/agents/runtime/attachments/published";

async function withCollection(fn: (collection: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "publish-"));
  const collection = join(root, "collection");
  await mkdir(collection);
  try {
    await fn(collection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("published Markdown pins direct local references without changing its bytes", () =>
  withCollection(async (collection) => {
    const workspace = join(collection, "..", "workspace");
    await mkdir(join(workspace, "a"), { recursive: true });
    await mkdir(join(workspace, "b"));
    for (const [path, bytes] of Object.entries({
      "a/chart.png": "first image",
      "b/chart.png": "second image",
      "a/fenced.png": "not referenced",
      "data.csv": "x,y\n1,2\n",
      "notes.md": "# Notes\n",
      "output.html": "<p>Download only</p>",
      "analysis.ipynb": '{"cells":[]}',
      ".env": "private",
    }))
      await writeFile(join(workspace, path), bytes);
    await writeFile(join(workspace, "..", "outside.txt"), "outside");
    await symlink("../outside.txt", join(workspace, "escape.txt"));
    await symlink("a", join(workspace, "linked"));
    expect(Bun.spawnSync(["mkfifo", join(workspace, "pipe")]).exitCode).toBe(0);
    await writeFile(join(workspace, "large.bin"), "x");
    await truncate(join(workspace, "large.bin"), MAX_FILE_BYTES);
    const source = join(workspace, "README.md");
    const text =
      '# Results\n\n![First](a/chart.png)\n\n<img src="b/chart.png">\n\n[Data](data.csv?download=1#row) [Notes][notes] <a href="output.html">HTML</a> [Notebook](analysis.ipynb)\n\n[notes]: notes.md\n\n[Hidden](.env) [Outside](../outside.txt) [Encoded](%2e%2e/outside.txt) [Absolute](/etc/passwd) [Remote](https://example.com/a) [File link](escape.txt) [Directory link](linked/chart.png) [Directory](a/) [Large](large.bin) [Pipe](pipe)\n\n```md\n![Ignored](a/fenced.png)\n```\n';
    await writeFile(source, text);
    const run = "c".repeat(32);
    const first = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-call",
      source,
      workspace,
    );
    expect(first.included).toBe(6);
    expect(first.warnings).toHaveLength(9);
    const manifest = await registeredFile(
      collection,
      "owner",
      run,
      "doc-call",
      source,
      { manyPerCall: true },
    );
    const related = readRelatedFiles(manifest?.related_files)!;
    expect(Object.keys(related).sort()).toEqual([
      "a/chart.png",
      "analysis.ipynb",
      "b/chart.png",
      "data.csv?download=1#row",
      "notes.md",
      "output.html",
    ]);
    expect(related["a/chart.png"]).not.toBe(related["b/chart.png"]);
    expect(
      Buffer.from(
        (await readDownload(collection, "owner", String(first.item.id)))[1],
      ).toString(),
    ).toBe(text);
    expect(
      Buffer.from(
        (await readDownload(collection, "owner", related["a/chart.png"]!))[1],
      ).toString(),
    ).toBe("first image");
    await writeFile(join(workspace, "a", "chart.png"), "new image");
    const second = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-next",
      source,
      workspace,
      { name: "renamed.md" },
    );
    expect(second.item.id).not.toBe(first.item.id);
    const secondManifest = await registeredFile(
      collection,
      "owner",
      run,
      "doc-next",
      source,
      { name: "renamed.md", manyPerCall: true },
    );
    const secondRelated = readRelatedFiles(secondManifest?.related_files)!;
    expect(secondRelated["a/chart.png"]).not.toBe(related["a/chart.png"]);
    expect(
      Buffer.from(
        (await readDownload(collection, "owner", related["a/chart.png"]!))[1],
      ).toString(),
    ).toBe("first image");
    await unlink(source);
    await unlink(join(workspace, "a", "chart.png"));
    const replay = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-call",
      source,
      workspace,
    );
    expect(replay.item.id).toBe(first.item.id);
    expect(replay.included).toBe(6);
    const unchanged = await registeredFile(
      collection,
      "owner",
      run,
      "doc-call",
      source,
      { manyPerCall: true },
    );
    expect(unchanged!.related_files).toBe(manifest!.related_files);
    await writeFile(
      source,
      [
        ...Array.from(
          { length: 110 },
          (_, n) => `[Remote ${n}](https://example.com/${n})`,
        ),
        ...Array.from({ length: 101 }, (_, n) => `[${n}](missing-${n}.csv)`),
      ].join("\n"),
    );
    const capped = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-capped",
      source,
      workspace,
    );
    expect(capped.included).toBe(0);
    expect(capped.warnings).toHaveLength(101);
    const empty = await registeredFile(
      collection,
      "owner",
      run,
      "doc-capped",
      source,
      { manyPerCall: true },
    );
    expect(empty?.related_files).toBe("{}");
    await writeFile(
      source,
      Array.from(
        { length: 80 },
        (_, n) => `[${n}](b/chart.png?v=${n}&padding=${"x".repeat(80)})`,
      ).join("\n"),
    );
    const metadataCapped = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-metadata",
      source,
      workspace,
    );
    expect(metadataCapped.included).toBe(1);
    expect(
      metadataCapped.warnings.some((warning) =>
        warning.includes("metadata limit"),
      ),
    ).toBe(true);
    const bounded = await registeredFile(
      collection,
      "owner",
      run,
      "doc-metadata",
      source,
      { manyPerCall: true },
    );
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(
      8192,
    );
    const boundedReferences = readRelatedFiles(bounded?.related_files)!;
    expect(Object.keys(boundedReferences).length).toBeLessThan(80);
    expect(new Set(Object.values(boundedReferences)).size).toBe(1);
    await writeFile(source, "![Chart](b/chart.png)\n");
    const rateLimited = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-rate",
      source,
      workspace,
      {
        now: Date.now() / 1000 + 120,
        limits: { maxFileBytes: MAX_FILE_BYTES, publishesPerMinute: 1 },
      },
    );
    expect(rateLimited.included).toBe(0);
    expect(
      rateLimited.warnings.some((warning) =>
        warning.includes("publish limit reached"),
      ),
    ).toBe(true);
    expect(rateLimited.item.name).toBe("README.md");
    const scratch = join(workspace, "scratch");
    await writeFile(scratch, "![Chart](b/chart.png)\n");
    const namedMarkdown = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-named",
      scratch,
      workspace,
      { name: "named.md" },
    );
    expect(namedMarkdown.included).toBe(1);
    const namedText = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-text",
      source,
      workspace,
      { name: "plain.txt" },
    );
    expect(namedText.included).toBe(0);
    const textManifest = await registeredFile(
      collection,
      "owner",
      run,
      "doc-text",
      source,
      { name: "plain.txt", manyPerCall: true },
    );
    expect(textManifest!.related_files).toBeUndefined();
    expect(namedMarkdown.item.related_files).toBeUndefined();
    // Explicitly chosen symlinks are followed; dependency symlinks stay refused.
    await writeFile(join(workspace, "a", "report.md"), "![F](fenced.png)\n");
    await symlink("a/report.md", join(workspace, "report-link.md"));
    const linkedFile = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-link-file",
      join(workspace, "report-link.md"),
      workspace,
    );
    expect(linkedFile.item.name).toBe("report-link.md");
    const linkedDirectory = await registerDocumentFile(
      collection,
      "owner",
      run,
      "doc-link-dir",
      join(workspace, "linked", "report.md"),
      workspace,
    );
    expect(linkedDirectory.included).toBe(1);
    // A dependency that grows after its size check cannot exceed the 100 MB total.
    await writeFile(join(workspace, "big.bin"), "x");
    await truncate(join(workspace, "big.bin"), 30 * 1024 * 1024);
    const growing = join(workspace, "grow.bin");
    await writeFile(growing, "x");
    await writeFile(source, "[Big](big.bin) [Grow](grow.bin)\n");
    const probe = await open(growing, "r");
    const target = await probe.stat();
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const stat = proto.stat;
    let seen = 0;
    proto.stat = async function (this: unknown, ...args: unknown[]) {
      const info = await stat.apply(this, args);
      if (info.dev === target.dev && info.ino === target.ino && ++seen === 2)
        await truncate(growing, 80 * 1024 * 1024);
      return info;
    };
    let raced;
    try {
      raced = await registerDocumentFile(
        collection,
        "owner",
        run,
        "doc-race",
        source,
        workspace,
      );
    } finally {
      proto.stat = stat;
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(raced.included).toBe(1);
    expect(raced.warnings).toEqual([
      'Skipped reference "grow.bin": file is too large (max 69 MB).',
    ]);
    const racedManifest = await registeredFile(
      collection,
      "owner",
      run,
      "doc-race",
      source,
      { manyPerCall: true },
    );
    expect(
      Object.keys(readRelatedFiles(racedManifest?.related_files)!),
    ).toEqual(["big.bin"]);
  }));

test("rejects one file above the per-file limit", () =>
  withCollection(async (collection) => {
    await expect(
      addUpload(collection, "owner", new Uint8Array(5), "large.bin", {
        limits: { maxFileBytes: 4 },
      }),
    ).rejects.toThrow("file is too large");
  }));

test("a conversation can hold more than the former 100 MB cap", () =>
  withCollection(async (collection) => {
    const ids = (() => {
      let n = 0;
      return () => (++n).toString(16).padStart(32, "0");
    })();
    const items = [];
    const payload = new Uint8Array(MAX_UPLOAD_BYTES);
    for (let n = 0; n < 5; n++)
      items.push(
        await addUpload(collection, "owner", payload, `f${n}.bin`, {
          ids,
          limits: { maxFileBytes: MAX_FILE_BYTES },
        }),
      );
    expect(items).toHaveLength(5);
    expect(await publishedFiles(collection, "owner")).toHaveLength(5);
    expect(await removeFile(collection, "owner", String(items[0]!.id))).toBe(
      true,
    );
  }));

test("an agent publishes up to 100 MB; uploads stay at 25 MB", () =>
  withCollection(async (collection) => {
    const source = join(collection, "..", "big.bin");
    await writeFile(source, "x");
    await truncate(source, MAX_UPLOAD_BYTES + 1);
    const run = "a".repeat(32);
    const published = await registerFile(
      collection,
      "owner",
      run,
      "call-1",
      source,
      "/",
    );
    expect(published.size).toBe(MAX_UPLOAD_BYTES + 1);
    const second = join(collection, "..", "second.txt");
    await writeFile(second, "second published file");
    const other = await registerFile(
      collection,
      "owner",
      run,
      "call-1",
      second,
      "/",
      { manyPerCall: true },
    );
    for (const [path, id] of [
      [source, published.id],
      [second, other.id],
    ]) {
      const replayed = await registerFile(
        collection,
        "owner",
        run,
        "call-1",
        String(path),
        "/",
        { manyPerCall: true },
      );
      expect(replayed.id).toBe(id);
    }
    expect(await publishedFiles(collection, "owner")).toHaveLength(2);
    const version = await registerFile(
      collection,
      "owner",
      run,
      "new-call",
      second,
      "/",
      { manyPerCall: true },
    );
    expect(version.id).not.toBe(other.id);
    await expect(
      addUpload(
        collection,
        "owner",
        new Uint8Array(MAX_UPLOAD_BYTES + 1),
        "big.bin",
      ),
    ).rejects.toThrow("file is too large (max 25 MB)");
    await truncate(source, MAX_FILE_BYTES + 1);
    await expect(
      registerFile(collection, "owner", run, "call-2", source, "/"),
    ).rejects.toThrow("file is too large (max 100 MB)");
  }));
