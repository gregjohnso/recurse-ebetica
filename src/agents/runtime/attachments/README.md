# Agent files

An agent's **files** are the operator's uploads and the files the agent publishes
with the native `publish` tool. Both live in one private collection at
`<data dir>/agent_files/<agent temp key leaf>/uploads`, separate from disposable
scratch, with the same quotas, listing, download and deletion. They last as
long as the agent: they survive restarts and disappear when the agent is deleted.
Missing bytes are reported as missing, never rebuilt. Artifacts are a separate,
versioned product ([src/artifacts/README.md](../../../artifacts/README.md)).

**Source files:** [store.ts](store.ts) (locks and bounded scans) ·
[publish.ts](publish.ts) (adding and removing files) ·
[document.ts](document.ts) (Markdown references) · [published.ts](published.ts)
(listings and download headers) · [preview.ts](preview.ts) (downloads) ·
[base.ts](base.ts) · [../agent_temp.ts](../agent_temp.ts) (directory lifetime) ·
[../attachment_drafts.ts](../attachment_drafts.ts) (uploads before a conversation exists)

## How it works

The store works only on directories and open handles it is given. It never works
out owners, reads transcripts, or recreates a deleted agent's directory.
`agent_temp.ts` owns the directory's lifetime; the agent's node and the
supervisor decide who may write and pass explicit quotas on each call. Deleting
an agent fences new writes first, so a late write cannot bring its directory back.

Each file gets an opaque storage ID, with its display name kept separately. A
file is published atomically, and only after its bytes and metadata validate. Listings come in
bounded pages, and deleting a file needs no proof that no message refers to it.

Publishing Markdown also snapshots direct relative images and file links beneath
its directory. Markdown syntax and HTML `img src` / `a href` are supported;
linked files do not trigger recursive scans. The original document bytes stay
unchanged. Its manifest records an immutable `related_files` JSON-string map
from authored relative URLs to ordinary attachment IDs, including an empty map
when nothing qualifies. Listings and tool metadata omit the map; the text preview
returns its decoded references. Old publications without a map retain their
legacy same-name resolution.

Reference scans read at most 256 KiB of Markdown and inspect at most 100 distinct
URLs. The document and captured files total at most 100 MiB. The encoded map
uses at most 6.5 KiB within the existing 8 KiB manifest limit. Skipped references
produce tool warnings. Hidden path components, traversal, absolute and remote
URLs, symlinks, directories and non-regular files are not captured. Directory
links do not publish a directory tree. Descriptor-relative no-follow opens keep
the captured files beneath the opened document directory.

Dependencies commit first and the document commits last. A checksum binds the
saved Markdown to the bytes scanned for references. Replaying a committed
publication returns its original document and map before opening source files,
so source edits and deletion do not change that publication. Dependencies remain
ordinary files with the same download checks, quotas and agent lifetime; deleting
one makes its reference unavailable rather than rebuilding it from the workspace.

## Rules for changes

- One collection per agent lifetime key: no second registry, file manager or index.
- Startup moves surviving legacy scratch uploads once, including drafts, and
  records completion in `<data dir>/.agent-files-v1`. Cross-filesystem moves copy
  into staging with a completion marker before atomic publication; the old copy
  retires only afterward. Migration errors keep the instance unready. Conflicting
  old and new collections without a completion marker are preserved for repair.
- The browser never sends paths. Reads take a conversation ID and an opaque file
  ID, resolved through checked directory handles that do not follow symlinks.
- Draft uploads stay private until a new conversation adopts them; a failed
  adoption keeps the bytes and never deletes the only copy.
