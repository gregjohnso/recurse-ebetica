# Browser app

The browser app is strict TypeScript. The build bundles [app.ts](app.ts) and,
separately, [sidebar-worker.ts](sidebar-worker.ts), the worker that runs
sidebar scripts;
[index.html](index.html) loads the page shell and built assets. The server owns
durable conversation state; the browser holds view state and unsent drafts.
[conversation/poll.ts](conversation/poll.ts) reads the tree and the open
conversation and subscribes to its live updates.

**Source files:**

- [conversation/](conversation/) and [thread-render.ts](thread-render.ts)
  render conversations; [composer.ts](composer.ts), [composer/](composer/)
  and [attachments.ts](attachments.ts) send input and uploads.
- [sidebar.ts](sidebar.ts), [deep-link.ts](deep-link.ts) and
  [agent-finder.ts](agent-finder.ts) navigate the agent tree.
  [sidebar/](sidebar/) groups local and remote top-level rows into sections with row and
  section actions, using the instance's sidebar script
  ([sidebar/script.ts](sidebar/script.ts)) or the built-in
  [sidebar/default_sidebar.js](sidebar/default_sidebar.js) (Inbox, Active and
  Archive).
- [explorer.ts](explorer.ts) registers the Explorer panel and its file tabs; [explorer/](explorer/) holds its folder
  state and the File pane, which reuses the Files pane's preview renderers.
- [panes.ts](panes.ts), [artifacts/](artifacts/), [files.ts](files.ts) and
  [diff.ts](diff.ts) provide side panels. On desktop the icon rail sits at the
  left edge (Agents, the panels, then Settings and Delete at its foot), and
  [dock/](dock/) hosts the chat, open panels and Explorer file tabs in dockview, loaded
  after the first conversation renders: tabs, drag-and-drop splitting and
  layout serialization are dockview's; each conversation's layout is saved in this
  browser and checked by [dock/layout.ts](dock/layout.ts) before restore. Phones show one full-screen panel at a time. [side-pane.ts](side-pane.ts) displays
  read-only side conversations.
- [models.ts](models.ts), [settings.ts](settings.ts) and [settings/](settings/)
  configure the app; [keymap.ts](keymap.ts) handles keyboard controls.
- [api.ts](api.ts), [backends/](backends/) and [connection.ts](connection.ts)
  handle requests and connection state. [prompt.ts](prompt.ts) shows captured
  model requests.

## Views and connections

[theme.css](theme.css) holds the design tokens: colours, spacing, radii,
shadows, motion and layers, as CSS custom properties. Checks in `tests/check.sh web`
(`tests/checks/*_check.ts`) reject literal values elsewhere, so a theme can change them
in one place. A custom palette in `config/themes.json` may add a `tokens` object
that overrides generated colours, the layout colours in theme.css (inputs, rows,
rail buttons, the shell and frame), the `radius-*` scale, `focus-width`, and
`content-inset`/`content-radius`, which float the chat and panes as inset cards,
`icon-radius` for icon-only buttons, and the `font-sans`/`font-mono` stacks. The
build publishes Inter ([inter/](inter/), OFL) for stacks that name it;
[src/themes.ts](../src/themes.ts) validates the names and values. [icons.ts](icons.ts) holds every inline SVG icon; the server fills
`index.html`'s `<svg data-icon="NAME">` slots from it. Oxlint does not cover Lit
templates; do not add another lint stack just for that gap.

Conversation rendering uses server projections and pages older history as
needed. Live polls retain loaded history; a reset of the same resident view and
session replaces its served range while retaining settled rows before it. Navigation preserves the reader's position without letting work from
one conversation move another. Pending reads from a departed conversation never
replace a new draft or the newly selected conversation. Loading the open conversation is the critical
path; background work and caching must not delay it. Navigation cancels departed
background work before registering the new conversation's pane probes, including
warming its parked Side frame.
Foreground operator sends enter through
[conversation/operator-send.ts](conversation/operator-send.ts), which applies
the open thread's scroll policy before enqueueing or delivering. Composer jobs
and persisted comment attempts reuse its transport without scrolling on retries
or restoration. Stops use a separate typed transport without message content.
`tests/checks/operator_send_check.ts` rejects direct delivery elsewhere and
restricts transport calls and foreground outbox enqueueing to their owners.
A send to an idle agent, including image and Artifact comments, follows the
reply's bottom until the start of the sent message reaches the viewport top,
then holds there until the reader scrolls or
jumps. Short replies add no empty space or scrolling. Once the reader scrolls
away, repaints hold their visible row even when a new live reply temporarily
shortens the thread; a layout clamp never resumes bottom following. An explicit
jump to latest resumes following, including when a repaint lands during its
smooth scroll. The running
turn's live panel sits above the composer, outside the thread
([conversation/thread.ts](conversation/thread.ts)). It retains the current turn's
latest thinking title and expandable text while tools or the next model call
run, including after reload. A newer thinking block replaces it, even when the
provider supplies only encrypted or redacted thinking. The header says Thinking
only while the thought is live, then Waiting with its last readable title.
Expanded prose omits a repeated title and bold Markdown delimiters.
Server-compacted history shows a plain marker instead of a summary disclosure;
its earlier messages and jump-to-first-kept-message link remain available.
Prompt-cache refresh usage adds to the turn’s cost and token totals without
counting another assistant reply; it never replaces the turn’s existing usage.
The context footer reuses committed usage already included in tree snapshots.
Cold or older backends retain the selected-conversation usage read; the detailed
breakdown still loads when opened.

Visible main conversation streams report `viewing=true` so the server skips
agent-finished pushes while the operator is reading that conversation. Hidden
tabs and the phone agent list close their stream; embedded side conversations
never report a viewer. Received pushes always show a notification, avoiding
browsers' generic background-update notices.

[brand/](brand/) contains the ring logo. [logo.png](brand/logo.png) is the
transparent artwork, recoloured white with its own anti-aliased alpha. The
mark, favicon and wordmark use black in light mode and white in dark mode via
`prefers-color-scheme`, with no background tile. [mark.svg](brand/mark.svg)
is the small UI mark. The sidebar header holds the New button instead of a
logo; phones keep New in the topbar. [wordmark.svg](brand/wordmark.svg)
pairs it with the name in the same adaptive colour. The `-mono.svg` variants
mask `currentColor` with the artwork's alpha channel when embedded inline.

The frontend asset build copies this directory to `/static/brand/`.
[index.html](index.html) links the adaptive SVG favicon, black and white 32 px
PNG fallbacks selected by media query, and the 180 px Apple touch icon. These
links carry the artwork's SHA-256 prefix as a query version; update it
when replacing the artwork so browsers discard cached icons. The web manifest advertises 192 and 512 px app icons
and full-bleed maskable variants; push notifications use the 192 px app icon.
The SVGs embed a reduced PNG copy of the artwork. PNG exports are resized from
the artwork at their named dimensions. Launcher PNGs and maskable icons
use white on a black tile; maskable icons inset the circle to keep it within the
safe area. The Apple touch icon uses the standard app tile.

Backend-bound requests use the same UI for home and remote conversations.
Remote health is isolated from home health, and the remote's key policy remains
the authority. Request cancellation remains active after response headers, so
abandoned streams close and stalled discovery bodies cannot strand boot restore. [backends/events.ts](backends/events.ts) receives tree-change
tag-change notices for home and connected remotes over one visible-tab SSE connection.
Notices fence older reads and start fresh tree reads without waiting for the
fallback poll. The server multiplexes remote notices to preserve browser
connection slots. Remote subscriptions pause with the backend's existing sleep
state and do not themselves count as activity or wake a sleeping backend. [shared-trees.ts](shared-trees.ts) filters the displayed tree
but does not grant access.

Artifact and image comments persist for background sending and retry; crop
storage preserves the original pixels. Comment send controls stay outside native
text selections, including when they appear after a paragraph is selected.
The send bar updates when a selection draft opens or closes, without waiting for
a pane refresh. Cmd/Ctrl+Enter in a comment popover stages the draft without
opening the comment list and returns focus to the viewer; the next shortcut
submits the staged batch. Submitting comments closes the pane; reopening preserves the
reading position on desktop and phones without reloading unchanged documents. See
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) and
[artifacts/crop-store.ts](artifacts/crop-store.ts).
[image-preview/README.md](image-preview/README.md) describes preview gestures.
Thread images show a compact filename footer with the full label in its tooltip.
Published image frames reserve space while loading so off-screen images stay lazy,
then follow the image's proportions within their size caps;
operator uploads and allowed Markdown images use the same footer style.
Inline captions read the admitted filename with a cached metadata-only request;
Markdown descriptions remain image alt text, never the filename source.
Artifact raster previews live in the Artifacts pane, not inline in the thread.
Files keeps failed deletions visible through background list refreshes; Retry
retries the deletion rather than reloading the list.

On phones, the agent list is the full-screen root, with New agent and Settings
in its header. Opening an agent adds one conversation above the list; switching
agents replaces that entry. Browser Back and the title-bar arrow return to the
list, including after a direct link or reload. Back at the list is left to the
browser. New agent and More stay in the conversation title bar; pane counts
appear in the More menu, and Artifacts attention appears on More. The composer
uses the full width. Direct Artifact links open above the conversation. Opening
Files from an image closes the viewer's history step before opening the pane.
Desktop, tablet and embedded navigation are unchanged. A vertical touch drag
on the phone thread closes the keyboard without changing the draft or caret;
composer gestures, mouse scrolling and automatic thread movement keep focus.

## HTTP and browser capabilities

The app supports plain HTTP origins as well as HTTPS. Copy actions share
[tool_details.ts](tool_details.ts)'s clipboard helper: when the Clipboard API is
unavailable, a temporary textarea copies synchronously during the click, without
losing the browser's user gesture. Failed copies remain visible to the operator.
[settings/auth.ts](settings/auth.ts) uses the same helper for device sign-in codes.
[files.ts](files.ts) falls back from unavailable Web Share to ordinary downloads.
Push notifications require a secure context;
[settings/notifications.ts](settings/notifications.ts) disables the setting on HTTP
and explains that HTTPS is required. Loopback origins that browsers consider
trustworthy retain secure-context capabilities. [index.html](index.html) links
the authenticated web manifest served by [../src/web/notifications.ts](../src/web/notifications.ts);
there is no app-owned install button or install-prompt hook. The browser controls
whether installation is available on the current origin.

Browser UUID callers fall back when `crypto.randomUUID` is unavailable:
[conversation-ui-state/store.ts](conversation-ui-state/store.ts) uses random bytes
or a local UI-only identifier, [show-timing.ts](show-timing.ts) uses a timestamp
and sequence, and [stop-control/id.ts](stop-control/id.ts) uses random bytes before a
non-secret local fallback. `crypto.getRandomValues` works on HTTP; browser code
does not require `crypto.subtle`, `navigator.storage` or media-device access. Local/session storage
and IndexedDB also work on HTTP, independently of HTTPS storage for the same host.
Unavailable or full storage is still a persistence failure, not permission to
silently discard pending comments.

When Web Locks are unavailable, [artifacts/comment-lock.ts](artifacts/comment-lock.ts)
serializes comment upload, send and discard across tabs with an IndexedDB
readwrite transaction kept alive by pending requests. Its separate database does
not block crop storage. This is transaction ownership, not an expiring lease;
[artifacts/comment-outbox.ts](artifacts/comment-outbox.ts) rechecks ownership after
awaits, and server idempotency handles crash recovery.

## Settings

Settings keeps its category sidebar on desktop and a category list on phones.
Rows show current values or switches in rounded groups. Editors, provider
sign-in actions, usage and model pickers stay inline on desktop. On phones,
rows open the same controls in labelled modal sheets; Escape and Done return
to the row. Resizing preserves edits without leaving a sheet open on desktop.
Nested model pickers preserve unsaved effort-level edits until the ladder is
saved. Safe preferences such as themes save on change; credentials, passwords
and model policy retain their explicit confirmation actions. The prompt-cache
warming switch saves directly from the Models overview.

## Styles and assets

[theme.css](theme.css) defines design tokens and [icons.ts](icons.ts) provides
inline icons. Installed Android apps use fullscreen display; mobile chrome and
Settings keep controls clear of display cutouts using safe-area insets.
[brand/](brand/) contains the default brand assets;
[../src/branding.ts](../src/branding.ts) owns instance branding.

## Rules for changes

- Never commit `web/dist`; it is build output.
- Pure helpers get unit tests in `tests/web/`; user-visible behaviour gets a
  browser test in `tests/mobile_browser/` ([tests/README.md](../tests/README.md)).
- Keep diagnostics free of DOM text and input values
  ([main-thread-timing.ts](main-thread-timing.ts)).
