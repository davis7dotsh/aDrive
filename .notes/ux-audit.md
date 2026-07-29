# adrive web audit — Svelte 5 patterns, simplicity, UX

Scope: `apps/web/src` client surface only (3 `.svelte` files, ~1,900 lines of
markup + `$lib/dashboard/*`). Server/Effect code is out of scope except where
the API blocks a UI fix.

State of play:

- `routes/+page.svelte` — 1,152 lines, 33 `$state` declarations, 8 inline SVGs,
  3 `<details>` menus, 2 `<dialog>`s, 4 independent message strings.
- `routes/files/[id]/+page.svelte` — 718 lines, 15 `$state`, 3 `<details>` menus.
- `$lib/components/` does not exist. Zero components in the whole app.
- `runed@0.37.1` is already a dependency and ships `resource`, `Context`,
  `onClickOutside`, `Debounced`, `watch`, `useEventListener`, `PressedKeys` —
  almost none of which are used, while the app hand-rolls all of them.
- Svelte is `5.56.8`, so attachments (`{@attach}`), `getAbortSignal()`,
  `$props.id()`, and `<svelte:boundary>` are all available.

Priority key: **P0** broken/embarrassing · **P1** high value · **P2** polish.

---

## A. Foundation (do these first, everything else gets cheaper)

### A1 · P0 — There are no components

**Issue.** The entire dashboard is two god-files. `+page.svelte` mixes sign-in,
device approval, search, tag filtering, tag CRUD, upload, file grid, per-file
menus, and API-key management in one `<script>` with 33 pieces of state that
can all see each other. Nothing is reusable, nothing is testable, and every
change risks an unrelated feature. This is the root cause of most items below.

**Solution.** Extract a real component layer. Suggested tree:

```
$lib/components/
  ui/            Button.svelte  Field.svelte  Modal.svelte  Menu.svelte
                 Icon.svelte    Toast.svelte  Confirm.svelte  Swatch.svelte
  tags/          TagChip.svelte TagFilterBar.svelte TagManager.svelte
                 TagPicker.svelte
  files/         FileCard.svelte FileGrid.svelte FileMenu.svelte
                 FilePreview.svelte VersionList.svelte FileMeta.svelte
  upload/        UploadDialog.svelte DropOverlay.svelte UploadQueue.svelte
  auth/          SignIn.svelte ApiKeys.svelte DeviceApproval.svelte
```

Target: `+page.svelte` under ~150 lines (route wiring + layout only),
`files/[id]/+page.svelte` under ~200.

**Files.** New `apps/web/src/lib/components/**`; gut
`apps/web/src/routes/+page.svelte`, `apps/web/src/routes/files/[id]/+page.svelte`.

---

### A2 · P0 — Hand-rolled fetch machinery in every `$effect`

**Issue.** Both pages implement the same async pattern by hand: a module-level
`run` counter, `AbortController`, `window.setTimeout` debounce, a bare
`refresh;` statement to force re-tracking, and manual `loading`/`error` flags.
`+page.svelte` has ~55 lines of this; `files/[id]` has two copies (~60 lines).
`$lib/dashboard/search-run.ts` is a one-line file (`current === candidate`)
with its own test file to support it. Side effect: because *every* dependency
change goes through the 200 ms timer, every mutation (`refresh += 1`) pays a
200 ms delay before the UI updates.

**Solution.** Replace all three with `resource()` from runed — it does
latest-wins cancellation, `signal`, `debounce`, `loading`, `error`, `mutate`,
and `refetch` out of the box:

```ts
const list = resource(
	() => [session.token, showTrash, params.q, [...params.tags]] as const,
	([token, trashed, q, tags], _prev, { signal }) =>
		trashed ? listFiles(token, true, signal) : searchFiles(token, q, tags, signal),
	{ debounce: 200 }
);
```

Then `refresh += 1` becomes `list.refetch()` (no debounce penalty) and
optimistic updates become `list.mutate({ ...list.current, files })`. Delete the
`run` counters, the timers, and `search-run.ts` + its test.

**Files.** `apps/web/src/routes/+page.svelte`,
`apps/web/src/routes/files/[id]/+page.svelte`; delete
`apps/web/src/lib/dashboard/search-run.ts` and `search-run.test.ts`.

---

### A3 · P1 — Responses are `as`-cast instead of decoded

**Issue.** `api.ts` decodes exactly one response with the Effect schema
(`getContentLink`) and blind-casts the other nine
(`(await response.json()) as FileListResponse`). The schemas already exist in
`@adrive/shared` (`FileListResponseSchema`, `FileDetailResponseSchema`,
`TagResponseSchema`, …). A server shape change becomes a runtime `undefined`
in the template instead of a typecheck or a decode error.

**Solution.** One generic helper: `const json = <A, I>(schema, response) =>
Schema.decodeUnknownPromise(schema)(await response.json())`, used by every
call. Also gives one place to convert decode failures into friendly messages.

**Files.** `apps/web/src/lib/dashboard/api.ts`; possibly export a
`TagResponseSchema`/`FileTagsResponseSchema` from
`packages/shared/src/index.ts` if any are missing.

---

### A4 · P1 — Session boilerplate: 40 lines of getters and a raw context symbol

**Issue.** `session.svelte.ts` declares an interface, four `$state` locals, and
eight explicit `get x() { return x }` forwarders, plus a hand-made
`Symbol()` + `getContext<T>()` pair. Also `+layout.svelte` uses
`onMount(() => void session.restore())` for something the session should own.

**Solution.** A class with `$state` fields plus runed's `Context`:

```ts
export class DashboardSession {
	token = $state('');
	ready = $state(false);
	connecting = $state(false);
	error = $state('');
	async connect(passcode: string) { … }
}
export const sessionContext = new Context<DashboardSession>('adrive.session');
```

Drops ~35 lines, keeps inference, gives typed `.get()`/`.set()`/`.exists()`.
Move `restore()` into the layout's single `$effect`/class init.

**Files.** `apps/web/src/lib/dashboard/session.svelte.ts`,
`apps/web/src/routes/+layout.svelte`, both route files (import site).

---

### A5 · P1 — 5 message/error slots per page, rendered in 5 places

**Issue.** `+page.svelte` has `loadError`, `uploadMessage`, `tagMessage`,
`authMessage`; `files/[id]` has `error`, `message`, `previewError`. Each is set
in ~4 handlers, rendered with a different treatment (left border amber, left
border red, plain gray `<p>`), never auto-dismisses, and appears far from the
control that caused it — the tag manager's confirmation lands at the bottom of
the dialog below the Delete button. Layout shifts every time one appears.

**Solution.** One `toast.svelte.ts` store + `<Toaster/>` in the layout:
`toast.success('Tag created')`, `toast.error(cause)`. Every catch block
collapses to one line, all seven state variables disappear, messages
auto-dismiss, and no layout shifts. Keep inline errors only where they're
field-specific (sign-in passcode).

**Files.** New `apps/web/src/lib/dashboard/toast.svelte.ts` +
`lib/components/ui/Toast.svelte`; `routes/+layout.svelte`, both route files.

---

### A6 · P1 — `<details>` abused as dropdown menus (6 instances)

**Issue.** Every menu in the app is a `<details>`: the per-card `•••` menu, the
API-keys section, and the file detail Tags/History/••• toolbar. Consequences:

- No close on outside click. Open a card menu, click elsewhere, it stays open.
- No close on Escape (the global `Escape` handler only knows about dialogs).
- Multiple card menus can be open at once (only the detail toolbar uses
  `name="file-toolbar"` for mutual exclusion).
- Panels are `position: absolute` inside grid `<li>` items → they overlap
  neighbours and get clipped near the viewport edge, with no flipping.
- No `role="menu"`, no `aria-expanded`, no arrow-key navigation, no focus
  return to the trigger.

**Solution.** One `Menu.svelte` built on the popover API (`popover="auto"` gets
you light-dismiss, Escape, and the top layer for free) plus CSS anchor
positioning with a `bottom-start` fallback, or `onClickOutside` from runed if
you prefer JS. Every menu becomes `<Menu trigger={…}>{#snippet items()}…{/snippet}</Menu>`.

**Files.** New `lib/components/ui/Menu.svelte`; `routes/+page.svelte` (card
menu, API keys), `routes/files/[id]/+page.svelte` (3 toolbar menus).

---

### A7 · P1 — Dialog open state is mirrored by an `$effect`, Escape handled 3×

**Issue.** For each dialog there's a `xOpen` boolean, a `xDialog` element ref,
and an `$effect` that reconciles them (`if (open && !dialog.open) showModal()`),
plus `onclose`, `oncancel`, and a backdrop `onclick` handler — then a *global*
`onWindowKeyDown` that also closes dialogs on Escape, duplicating what
`<dialog>` does natively. Nothing moves focus into the dialog on open.

**Solution.** One `Modal.svelte` with `bind:open`, using an attachment:

```svelte
<dialog {@attach (node) => { open ? node.showModal() : node.close(); }} …>
```

encapsulating backdrop click, native cancel, `aria-labelledby`, autofocus of
the first field, and focus return. Delete `onWindowKeyDown` entirely.

**Files.** New `lib/components/ui/Modal.svelte`; `routes/+page.svelte`
(uploadDialog/tagDialog effects, `onWindowKeyDown`).

---

### A8 · P2 — Class-string duplication instead of primitives

**Issue.** `rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white
disabled:opacity-50` appears 7×; `rounded-md border border-zinc-300 px-3 py-2
text-sm` 6×; the "selected tag pill" ternary block is written out 4× with
subtly different colors each time; the same file/plus/close SVG paths are
inlined 8× across the two pages. Hex literals `#a1a1aa`, `#71717a`, `#2563eb`
are hardcoded in markup and in `.ts` defaults even though `@theme` tokens
exist.

**Solution.** `Button.svelte` (`variant: primary | secondary | ghost | danger`),
`Field.svelte`, `Icon.svelte` with a `name` → path map, `TagChip.svelte` with
`variant: filter | edit | static`. Move the fallback tag color into a
`DEFAULT_TAG_COLOR` constant and a `--color-tag-default` token.

**Files.** New `lib/components/ui/*`; both routes; `apps/web/src/app.css`.

---

### A9 · P2 — Inconsistent style binding

**Issue.** `+page.svelte` uses `style={\`background:${tag.color ?? '#a1a1aa'}\`}`
(string interpolation, 2×) while `files/[id]` uses `style:background={…}` for
the identical chip. The interpolated form is the one you don't want if a color
value ever comes from user input.

**Solution.** Standardize on `style:background` — resolved by A8's `TagChip`.

**Files.** `routes/+page.svelte` (tag filter chips, tag manager chips).

---

### A10 · P2 — Timeout leaks and stringly-typed "copied" state

**Issue.** Four `window.setTimeout(… , 1500)` calls reset copy confirmations
with no cleanup on unmount. In `files/[id]`, `copied` is a string holding
`'current' | 'command' | String(versionNumber)` and is compared with
`copied === String(version.version)`.

**Solution.** One `copied.svelte.ts` helper: `const copy = useCopy()` exposing
`copy.run(key, text)` and `copy.is(key)`, with the timer cleaned up via
`onDestroy`. Key it by a typed union, not free strings.

**Files.** New `apps/web/src/lib/dashboard/copy.svelte.ts`; both routes;
`lib/dashboard/format.ts` (`copyText` stays as the low-level primitive).

---

### A11 · P2 — Unused payload fields / dead UI surface

**Issue.** `FileListResponse.semantic` (enabled, indexedChunks, dimensions,
model, costNotice) and `FileDetailResponse.semanticEnabled` are fetched on
every request and never rendered. `indexState` / `indexError` /
`indexAttempts` are surfaced only as raw text in a dropdown
(`Index · pending`), with `indexError` never shown even when indexing failed.
`lastDownloadAt` and `expiresAt` are never shown in the list.

**Solution.** Pick one: surface them (a small "Search index" line in settings
showing semantic status + chunk count; an amber "Indexing failed" badge with
`indexError` on the card and detail page) or drop them from the response.
Showing `indexError` is genuinely useful — right now a failed extraction is
invisible.

**Files.** `routes/+page.svelte`, `routes/files/[id]/+page.svelte`, possibly
`lib/server/file-rows.ts` / `packages/shared/src/index.ts` if trimming.

---

## B. Manage tags dialog (the screenshot)

### B1 · P0 — Raw full-width `<input type="color">` renders as a giant colored bar

**Issue.** This is the blue slab and the gray slab in the screenshot. The rows
use `sm:grid-cols-[1fr_auto_auto]` with the color input at `h-10 w-full sm:w-12`.
Tailwind's `sm:` is **viewport**-based, but the dialog is a fixed
`w-[min(38rem,…)]` box — so on any viewport under 640 px the three-column
layout collapses and the color input stretches to full width, producing a 100%
× 40px block of pure color. It looks like a broken progress bar, not a control.

**Solution.** Never render a bare color input at flexible width. Replace with a
`Swatch.svelte`: a 24 px circle button showing the current color that opens a
small palette of ~8 preset tag colors plus a "custom" entry (a *fixed-size*
native color input). And stop using viewport breakpoints inside dialogs — use
container queries (`@container` on the dialog body) or a layout that works at
every width.

**Files.** `routes/+page.svelte` (tag dialog markup), new
`lib/components/ui/Swatch.svelte`.

---

### B2 · P0 — Three disconnected forms for one concept

**Issue.** The dialog is create-row → chip list → *detached* edit row. To
rename a tag you click a chip in the middle, then your eyes have to jump to an
unlabeled input at the bottom that gives no indication of which tag it belongs
to, edit it there, and hit Save. Delete sits next to Save in the same detached
block with no confirmation. The chips in the middle look **identical** to the
filter chips on the main page (same `border-accent-500 bg-accent-50` selected
state) but do something completely different — one filters, one selects for
editing.

**Solution.** Collapse to a single list where each row *is* the editor:

```
┌────────────────────────────────────────────┐
│ ●  [ New tag name……………… ]          [Create]│   ← form, Enter submits
├────────────────────────────────────────────┤
│ ●  deej                       1 file    🗑  │   ← click name → inline rename
│ ●  reports                   14 files   🗑  │
└────────────────────────────────────────────┘
```

- Swatch click opens the palette and saves on pick (no Save button).
- Name is a borderless input that saves on blur/Enter and reverts on Escape.
- Trash icon opens a `Confirm` ("Delete *deej*? 1 file keeps its other tags.").
- No selection mode, no second form, no `manageTagId`/`manageName`/`manageColor`
  state at all.

**Files.** New `lib/components/tags/TagManager.svelte`,
`lib/components/ui/Confirm.svelte`; `routes/+page.svelte` (delete the tag
dialog block and `selectManagedTag`/`saveManagedTag`/`removeManagedTag` +
their 5 state vars).

---

### B3 · P1 — Create row isn't a form; Enter does nothing

**Issue.** The create row is a `<div class="grid">` with a `<button
type="button">`. Typing a name and pressing Enter does nothing — you must
mouse to Create. Same for the edit row. The name input isn't autofocused when
the dialog opens.

**Solution.** Wrap in `<form onsubmit>`, `type="submit"`, autofocus the name
field on open (handled by `Modal.svelte` from A7).

**Files.** `routes/+page.svelte` → `lib/components/tags/TagManager.svelte`.

---

### B4 · P1 — No empty state, no delete confirmation, no count context

**Issue.** With zero tags the dialog shows just the create row floating over
two horizontal rules' worth of whitespace. Delete is instant and irreversible
(the only feedback is "Tag deleted. Files remain in the drive." at the bottom,
after the fact). The `1` next to a tag is unlabeled — a bare gray digit.

**Solution.** Empty state: "No tags yet. Tags are how you organize — files can
have as many as you like." Confirm dialog before delete, naming the tag and
the affected file count. Label the count (`1 file` / `14 files`) or make it a
button that closes the dialog and applies the filter.

**Files.** `lib/components/tags/TagManager.svelte`,
`lib/components/ui/Confirm.svelte`.

---

### B5 · P1 — "Manage tags" is glued into the filter bar

**Issue.** On the main page, the dashed "+ Manage tags" button sits inline
among the tag filter chips, so a management action shares a row and visual
weight with filters. It's also the only way to reach tag CRUD, and it's hidden
entirely in Trash view.

**Solution.** Filter chips row stays pure filters (plus a "Clear" chip when any
are active). Move management to a small gear/"Edit tags" text link at the end
of the row or into the header overflow menu.

**Files.** `routes/+page.svelte` →
`lib/components/tags/TagFilterBar.svelte`.

---

## C. Upload

### C1 · P0 — No upload progress at all

**Issue.** With a 100 MB per-file cap, uploading a large file shows only a
button reading "Uploading…" and nothing else. Multiple files upload
sequentially in a `for` loop and `uploadMessage` is overwritten each iteration,
so you see only the last one. No per-file status, no byte progress, no "3 of 7",
no way to cancel. `fetch()` can't report upload progress, which is presumably
why there is none.

**Solution.** An upload queue: each dropped/picked file becomes a row with
name, size, and a progress bar; use `XMLHttpRequest.upload.onprogress` (or a
`ReadableStream` body with a counting transform) inside `uploadFile` to drive
it; run 3 concurrently like the CLI does; per-row error with Retry; a Cancel
button per row via `xhr.abort()`. Keep the queue visible after the dialog
closes (a compact pinned card, bottom-right).

**Files.** `lib/dashboard/api.ts` (`uploadFile` → progress callback),
new `lib/components/upload/UploadQueue.svelte`,
new `lib/dashboard/uploads.svelte.ts`, `routes/+page.svelte`.

---

### C2 · P1 — Dialog puts the action before the options

**Issue.** "Upload files" shows a big black **Choose files** button first, then
Public / Tags / Expiration *below* it. Clicking the top button immediately
uploads with whatever the untouched defaults below happen to be. There's also
no drop target inside the dialog even though the app supports drag-and-drop
globally, and the max upload size (`maxUploadBytes`, already fetched) is never
displayed — you only learn the limit by exceeding it.

**Solution.** Reorder to: dashed drop zone that is also click-to-browse
("Drop files here or browse · up to 100 MB") → options → footer. Move the
primary button to a footer, or keep it zero-step (options first, drop zone last).
Show the size limit in the drop zone.

**Files.** `routes/+page.svelte` → `lib/components/upload/UploadDialog.svelte`.

---

### C3 · P1 — Upload settings silently persist between uploads

**Issue.** `expiresAtInput`, `isPublic`, and `uploadTagIds` are page-level state
that is never reset after a successful upload, and the dialog auto-closes on
success. Set an expiry once and every subsequent upload — including
drag-and-drop uploads that never open the dialog — silently inherits it. The
next drop can quietly schedule a file for deletion.

**Solution.** Reset expiry after each successful upload (keep visibility and
tags if you want stickiness, but show them). Surface the active defaults on the
Upload button or drop overlay: "Drop to upload · Public · expires Aug 31".

**Files.** `routes/+page.svelte`, `lib/components/upload/UploadDialog.svelte`,
`lib/components/upload/DropOverlay.svelte`.

---

### C4 · P1 — Expiration is a bare `datetime-local`

**Issue.** Setting a TTL means operating a native datetime picker; there's no
way to express the common cases ("an hour", "a week"), no way to clear it
except selecting the field and deleting, and no display of the resulting
absolute time in a readable form.

**Solution.** Segmented presets — Never · 1 hour · 1 day · 7 days · 30 days ·
Custom — with the resolved date shown underneath ("Expires Aug 4, 3:12 PM").
Same control on the detail page.

**Files.** New `lib/components/ui/ExpirySelect.svelte`; `UploadDialog.svelte`,
`routes/files/[id]/+page.svelte`; `lib/dashboard/format.ts` (relative helper).

---

### C5 · P1 — Visibility is an unexplained checkbox

**Issue.** A bare `☐ Public` checkbox whose only explanation lives in a `title`
tooltip nobody hovers. HTML files force public — that's only discovered *after*
upload, via a message. `default = public` (per the product contract) is a
consequential default to hide behind an unlabeled checkbox.

**Solution.** Two-option segmented control with one-line descriptions:
"Public — anyone with the link" / "Private — signed 15-minute links only". If
any selected file is HTML, show the forced-public note *before* uploading.

**Files.** `lib/components/upload/UploadDialog.svelte`;
`lib/dashboard/format.ts` (`isHtmlFile` already exists and is currently unused
on the client — wire it up here).

---

### C6 · P2 — Drag overlay can get stuck; folders and disabled states are silent

**Issue.** `dragDepth` is only decremented by `dragleave`. Drag files in, then
drop them on another application or hit Escape mid-drag, and the depth never
returns to 0 — the full-screen "Drop to upload" overlay stays up. Dropping a
*folder* yields a directory entry that fails with a confusing server error. In
Trash view, drop and paste are silently ignored with no explanation.

**Solution.** Reset on `dragend`, `window.blur`, and Escape. Detect directory
entries (`item.webkitGetAsEntry()?.isDirectory`) and show "Folders aren't
supported — use `adrive site put`". In Trash, show "Switch to Files to upload"
in the overlay instead of nothing.

**Files.** New `lib/dashboard/drop-zone.svelte.ts` (extract the four
`onWindowDrag*` handlers + paste out of `routes/+page.svelte`),
`lib/components/upload/DropOverlay.svelte`.

---

### C7 · P2 — Paste-to-upload is completely undiscoverable

**Issue.** `onWindowPaste` uploads clipboard files — a genuinely nice feature
that is mentioned nowhere in the UI.

**Solution.** Mention it in the empty state and the upload dialog's drop zone:
"Drop files, browse, or paste (⌘V)".

**Files.** `lib/components/upload/UploadDialog.svelte`, empty-state markup in
`routes/+page.svelte`.

---

## D. Files list

### D1 · P1 — Header crowds a primary action into the tab strip

**Issue.** As in the screenshot: `[+ Upload] Files Trash` are all in one
right-hand cluster, so a black primary button sits immediately adjacent to two
underline tabs. The `<h1>` then repeats whichever tab is active ("Files" over
"Files"), and the `<h1>` is wrapped in a pointless `<div>`.

**Solution.** Tabs on the left (they *are* the page title — drop the redundant
`<h1>` or keep only "adrive" in the layout header), primary Upload button
pushed to the far right with real separation. Consider moving Files/Trash to a
segmented control so it reads as a scope switch, not navigation.

**Files.** `routes/+page.svelte` (header block).

---

### D2 · P1 — Every mutation costs a full refetch + 200 ms

**Issue.** `changeState()` (trash/restore) and the tag/upload handlers all do
`refresh += 1`, which re-triggers the debounced search effect: 200 ms timer,
then a full network round trip, then the whole grid re-renders. Trashing a file
feels laggy and the card sits there looking untouched the whole time.

**Solution.** Optimistic update — remove the card immediately (with a small
fade), fire the request, roll back + toast on failure. Pair with an **Undo**
action in the toast ("Moved to trash · Undo"), which is the single biggest UX
win available here since `restore` already exists. With A2's `resource`, this
is `list.mutate(...)` and no refetch at all.

**Files.** `routes/+page.svelte` → `lib/components/files/FileGrid.svelte`,
`lib/dashboard/toast.svelte.ts`.

---

### D3 · P1 — Cards are gray boxes; no thumbnails, no previews

**Issue.** Every card renders the same gray `aspect-[4/3]` rectangle with a
generic outline icon and an uppercase extension label. In a *file drive*, this
makes visual scanning impossible — twelve images all look identical. The server
already serves bytes from the content origin and already has a text/markdown
preview endpoint.

**Solution.** Render real previews in the card: `<img loading="lazy">` for
`image/*` (public files via `contentOrigin`, private via a signed link fetched
lazily when the card intersects — runed's `useIntersectionObserver`), the first
few lines of text for markdown/text, and keep the icon fallback for everything
else. Color the extension badge by family (image / doc / code / archive).

**Files.** New `lib/components/files/FileCard.svelte`, `FileThumb.svelte`;
`routes/+page.svelte`; possibly `lib/dashboard/api.ts` (batch link fetch).

---

### D4 · P1 — No list view, no sort, no bulk actions

**Issue.** Grid-only, server-order-only. There's no way to sort by size or
date, no way to see metadata columns without opening each file, and no way to
act on more than one file at a time — so tagging ten uploads means ten
navigations to ten detail pages. The count line ("12 files") carries no total
size or other summary.

**Solution.** (a) Grid/list toggle persisted in the URL (`?view=list`) or via
runed `PersistedState`; list shows name / tags / size / modified / visibility.
(b) Sort menu (name, size, modified) — client-side is fine at this scale.
(c) Checkbox selection with shift-range, and a selection action bar: Add tags,
Make public/private, Trash. This turns tagging from N navigations into one
action. (d) Add total size to the count line.

**Files.** `routes/+page.svelte`, new
`lib/components/files/FileList.svelte`, `SelectionBar.svelte`;
`lib/dashboard/api.ts` (add a batch-tag/batch-mutate helper or loop);
possibly `routes/api/files/+server.ts` for a bulk endpoint.

---

### D5 · P1 — Trash is a dead end

**Issue.** Trash view has no search box (search is inside `{#if !showTrash}`),
no "Delete permanently", no "Empty trash", and no indication of *when* items
get purged — even though `lib/server/services/lifecycle.ts` and
`purge-sql.ts` implement a real purge schedule. `deletedAt` is on the payload
and never shown.

**Solution.** Keep search available in Trash (the API already accepts a
`trashed` list; add `q` support or filter client-side as a first pass). Show
"Deleted 3 days ago · purges in 27 days" on each card. Add per-file "Delete
permanently" and an "Empty trash" action with confirmation.

**Files.** `routes/+page.svelte`, `lib/dashboard/api.ts`,
`routes/api/files/[id]/+server.ts` + `lib/server/services/files.ts` (purge-now
endpoint), `packages/shared/src/index.ts` (`FileMutationSchema` — add a
`purge` action).

---

### D6 · P2 — Empty states are inert

**Issue.** "No files yet" with a gray icon and no next step. "No matching
files" doesn't offer to clear the query or the tag filters — and when tag
filters are active there is no clear-all affordance anywhere.

**Solution.** "No files yet" → primary "Upload files" button + "or drop them
anywhere · ⌘V to paste". "No matching files" → show the active query and tag
filters as removable chips with "Clear all".

**Files.** `routes/+page.svelte`, `lib/components/tags/TagFilterBar.svelte`.

---

### D7 · P2 — "0 files" flashes before results

**Issue.** The count line renders `{files.length} files` unconditionally, so
initial load and every filter change flash "0 files" while `loading` is true,
and the loading indicator is a tiny gray "Searching…" in the corner.

**Solution.** Show skeleton cards on first load and keep the previous count
dimmed during refetch (`resource` exposes `loading` alongside the stale
`current`).

**Files.** `routes/+page.svelte`, `lib/components/files/FileGrid.svelte`.

---

### D8 · P2 — Private download navigates the whole page away

**Issue.** `openLink()` does `window.location.assign(link.url)`, unloading the
dashboard to trigger a download. You lose your scroll position, your search,
and your in-flight upload queue.

**Solution.** Create a hidden `<a download href={url}>` and click it, or
`window.open(url, '_blank', 'noopener')`.

**Files.** `routes/+page.svelte` (`openLink`),
`routes/files/[id]/+page.svelte` (`downloadPrivate`), possibly a shared
`lib/dashboard/download.ts`.

---

### D9 · P2 — "Copy link" hides that private links expire

**Issue.** On the list page, copying a private file's link silently produces a
15-minute signed URL — the button just says "Copied". The detail page *does*
say "Link copied · 15 min". Someone will paste a dying link into Slack.

**Solution.** Same treatment everywhere: "Copied · expires in 15 min", and mark
private cards with a small "signed link" hint in the menu item itself
("Copy temporary link").

**Files.** `routes/+page.svelte` (`copyLink`), `lib/components/files/FileMenu.svelte`.

---

### D10 · P2 — No keyboard affordances

**Issue.** The only keyboard handling in the app is Escape-closes-dialog
(itself redundant, see A7). No `/` or `⌘K` to focus search, no arrow navigation
in the grid, no `u` to upload.

**Solution.** `PressedKeys` from runed: `/` and `⌘K` focus search, `u` opens
upload, `Escape` clears the search box when it's focused and non-empty. Add a
tiny `⌘K` hint inside the search field.

**Files.** `routes/+page.svelte`.

---

## E. File detail page

### E1 · P0 — The whole page is three dropdowns in a toolbar

**Issue.** Everything about a file lives behind `Tags ▾`, `History ▾`, and
`••• ▾` in a cramped header row next to the filename. The `•••` panel alone
contains: Copy link, a Public checkbox, an expiration date input + Save, a
"New version" file picker, an index state + Reindex button, a definition list
of size/updated/downloads/version/id, *and* "Move to trash" — seven unrelated
concerns in one 22 rem scrolling popover. Size and modified date, the two most
basic facts about a file, are two clicks away. It's the same pathology as the
tag manager.

**Solution.** Give the page an actual layout: preview as the main column, a
persistent right sidebar (stacking below on mobile) with sections — Share
(link + visibility), Details (size, type, modified, downloads, id), Tags
(inline editable), Expiry, Versions, Danger (trash). Keep only genuinely
secondary actions (Reindex, Copy id) in one `•••`. Delete all three `<details>`
toolbars.

**Files.** `routes/files/[id]/+page.svelte` → new
`lib/components/files/FileSidebar.svelte`, `FileMeta.svelte`,
`VersionList.svelte`, `lib/components/tags/TagPicker.svelte`.

---

### E2 · P1 — Back button destroys your search context

**Issue.** The back arrow is `href="/"`, hardcoded. Search for something, open
a result, go back → your query and tag filters are gone, even though the whole
point of the `useSearchParams` setup is shareable, restorable state.

**Solution.** Preserve the referring search: either `history.back()` when the
previous entry is the list, or thread the current `?q=&tags=` into the card's
`href` and back into the back link. Also replace the raw `←` character with a
real icon and label it "Files".

**Files.** `routes/files/[id]/+page.svelte`, `routes/+page.svelte` (card
hrefs).

---

### E3 · P1 — Previews only exist for text and markdown

**Issue.** `previewKind` is `markdown | text | null`, so images, PDFs, video,
and audio show an empty white page with nothing but the filename in the
toolbar. Sites get a single "Open site" text link. The content origin can serve
all of these, and private files have signed links.

**Solution.** Extend `FilePreview.svelte` by content type: `<img>` for images
(with dimensions in Details), `<video controls>` / `<audio controls>`,
`<iframe>` for PDF, an `<iframe>` embed for sites. Fall back to a large icon +
size + a prominent Download button for true binaries — never a blank page.

**Files.** `routes/files/[id]/+page.svelte` → new
`lib/components/files/FilePreview.svelte`; `lib/server/file-preview.ts` (kind
detection) if you want the server to classify.

---

### E4 · P1 — There is no rename anywhere in the product

**Issue.** `displayName` is set at upload and can never be changed — not in the
dashboard, not in the CLI. `FileMutationSchema` has visibility / trash /
restore / expiration / reindex and no rename. Upload a file with a bad name and
it's permanent.

**Solution.** Add a `rename` action to the mutation union and make the detail
page's filename an inline-editable heading (click → input, Enter saves, Escape
reverts). Re-index the filename on rename so search stays correct.

**Files.** `packages/shared/src/index.ts` (`FileMutationSchema`),
`apps/web/src/routes/api/files/[id]/+server.ts`,
`apps/web/src/lib/server/services/files.ts`,
`apps/web/src/lib/server/services/indexing.ts` (filename trigram refresh),
`routes/files/[id]/+page.svelte`, `packages/cli` (parity).

---

### E5 · P2 — Version history uses three different verbs

**Issue.** Each version row offers "Copy", "Open", and "Get". "Get" is
CLI-speak for download. Rows show `v3 · current` as plain text with no visual
emphasis, and there's no diff or "restore this version" action even though the
version history is append-only and complete.

**Solution.** "Copy link" / "Open" / "Download" — no invented verbs. Mark the
current version with a badge, not a text suffix. Consider "Restore as new
version" (re-uploads an old blob as v(n+1)), which fits the append-only model
exactly and makes history actually useful.

**Files.** new `lib/components/files/VersionList.svelte`;
`packages/shared/src/index.ts` + `lib/server/services/files.ts` for restore.

---

### E6 · P2 — Trashed files hide their content and offer no permanent delete

**Issue.** When `deletedAt` is set the entire preview block is skipped, so you
can't see what you're about to lose. The only action is Restore. The "In trash"
state is a 12 px amber text fragment.

**Solution.** Keep the preview visible with a clear banner strip ("In trash ·
purges in 27 days") plus Restore and Delete permanently.

**Files.** `routes/files/[id]/+page.svelte`.

---

### E7 · P2 — Detail-page tag UI is a third, different tag interaction

**Issue.** Tags now have four distinct UIs: filter chips (main page), edit
chips (tag manager), toggle chips in the detail Tags dropdown, and read-only
pills in the detail header. The read-only pills can't be removed where they're
shown; you have to open the dropdown, find the same tag, and click it again.
Creating a tag from here can't set a color.

**Solution.** One `TagPicker.svelte` (combobox: type to filter, Enter to create,
click to toggle) used by the detail page, the upload dialog, and the future
bulk-selection bar. Header pills get an `×` that removes directly.

**Files.** new `lib/components/tags/TagPicker.svelte`;
`routes/files/[id]/+page.svelte`, `lib/components/upload/UploadDialog.svelte`.

---

## F. Auth, settings, global chrome

### F1 · P1 — API-key management is a `<details>` at the bottom of the file list

**Issue.** Key creation/revocation lives in a collapsed disclosure below the
file grid, on the Files tab only (it disappears in Trash). Newly created key
tokens render as a bare `<code>` block with no copy button — the one string in
the app you can never see again is the only one you have to select by hand.
Revoke has no confirmation. The "API keys have full access" warning is a
`title` attribute.

**Solution.** A `/settings` route (or a header avatar menu) holding: API keys,
semantic-index status (see A11), content origin, upload limit, and sign out.
The new-key panel gets a real "Copy key" button, a visible full-access warning,
and revoke gets a confirm.

**Files.** new `apps/web/src/routes/settings/+page.svelte`,
`lib/components/auth/ApiKeys.svelte`; `routes/+page.svelte` (remove the
block), `routes/+layout.svelte` (nav entry).

---

### F2 · P1 — Device approval banner never resolves

**Issue.** With `?device=CODE`, a banner offers "Approve device". After
approval the banner stays exactly as it was — same button, still clickable —
with a message appended elsewhere. Nothing removes the `device` param, so a
refresh re-arms it. There's also no Deny action, and no expiry countdown even
though device codes expire in 10 minutes.

**Solution.** After approval, replace the banner with a success state ("Device
approved — return to your terminal") and strip the param via
`replaceState`. Add Deny. Show the remaining validity.

**Files.** `routes/+page.svelte` → new
`lib/components/auth/DeviceApproval.svelte`; possibly
`routes/api/auth/device/approve/+server.ts` for a deny action.

---

### F3 · P2 — "Disconnect" and "Local HTTP fallback" are internal jargon

**Issue.** The header button says "Disconnect" (users think "sign out"), and
the sign-in page's fallback path is labeled "Local HTTP fallback" with a
`adr_…` placeholder and zero explanation of when or why you'd need it. When
passcode login fails over plain HTTP, the error won't explain that the
`__Host-` cookie was refused because the origin isn't HTTPS.

**Solution.** "Sign out". Rename the disclosure to "Sign in with an API key"
with one sentence: "Use this on plain-HTTP origins where the secure session
cookie can't be set." Detect `location.protocol === 'http:'` and surface that
hint proactively.

**Files.** `routes/+layout.svelte`, `routes/+page.svelte` → new
`lib/components/auth/SignIn.svelte`, `lib/dashboard/session.svelte.ts`
(error text).

---

### F4 · P2 — Everything is client-rendered behind a two-stage skeleton

**Issue.** The app renders a skeleton until `session.ready`, then a *second*
loading state while the file list fetches. Browser sessions authenticate via
the `__Host-adrive-session` cookie, which the server can read — so this
double flash is avoidable for the common case.

**Solution.** Add a `+page.server.ts` that loads the file list when the session
cookie is present, and hydrate the client resource with it
(`resource(..., { initialValue: data.list })`). API-key sessions keep the
current client-only path. First paint goes from ~2 spinners to 0.

**Files.** new `apps/web/src/routes/+page.server.ts`,
`apps/web/src/routes/files/[id]/+page.server.ts`; `routes/+page.svelte`,
`hooks.server.ts` (locals for the authed session), `lib/server/services/*`
(reuse existing handlers).

---

### F5 · P2 — No app chrome: no favicon, no theme color, no dark mode

**Issue.** No `apps/web/static/` directory at all, so no favicon (browsers
request `/favicon.ico` → 404 on every load), no apple-touch-icon, no
`theme-color`, no OG image for shared links. `app.css` hardcodes
`background: #ffffff` with no `prefers-color-scheme` support.

**Solution.** Add a minimal SVG favicon + `theme-color` meta. Dark mode is
optional but cheap in Tailwind v4 if the zinc scale is tokenized first (A8).

**Files.** new `apps/web/static/favicon.svg`, `apps/web/src/app.html`,
`apps/web/src/app.css`.

---

### F6 · P2 — 191 lines of hand-written markdown CSS

**Issue.** `app.css` is 80% a bespoke `.markdown-preview` stylesheet
(headings, tables, code, blockquote, hr…) reimplementing what
`@tailwindcss/typography` provides, with more hardcoded hex values.

**Solution.** Either adopt `@tailwindcss/typography` and reduce this to a short
`@utility`/theme override block, or keep it but pull the colors into `@theme`
tokens so light/dark and accent changes are one edit.

**Files.** `apps/web/src/app.css`, `apps/web/package.json`,
`routes/files/[id]/+page.svelte` (`prose` classes).

---

## Suggested order

1. **A1, A2, A4, A5, A6, A7** — components, `resource`, session class, toasts,
   `Menu`, `Modal`. Nothing else lands cleanly until these exist.
2. **B1–B5** — the tag manager rebuild (the trigger for this audit).
3. **C1–C3, D1, D2, E1** — upload progress, header, optimistic mutations, and
   the file detail layout. These are the biggest felt improvements.
4. **A3, D3–D5, E2–E4, F1, F2** — type-safe decoding, thumbnails, list/bulk,
   trash, previews, rename, settings.
5. Everything marked P2.

After each change: `pnpm format && pnpm check`.
