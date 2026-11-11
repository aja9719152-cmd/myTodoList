# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A vanilla HTML/CSS/JS todo app ("My Tasks") made of three files: `index.html`, `style.css`, `script.js`. There is no build step, package manager, framework, linter or test suite.

Product and technical docs live in `docs/`: `PRD.md` (features and acceptance criteria), `TRD.md` (design rationale) and `TASKS.md` (done, needs-verification and backlog items). Update `TASKS.md` when finishing or adding work.

## Running

- Open `index.html` directly in a browser, or serve the folder (e.g. `npx serve .` or `python -m http.server`).
- Syntax check without a browser: `node --check script.js`.
- To exercise behavior headlessly, load the page in jsdom outside the repo. Inject `script.js` as a `<script>` element (not `window.eval`): the file is `'use strict'`, so strict eval would hide its top-level functions. Then call functions like `toggleTodo(id)` or `importFromFile(fileLike)` on `window`. jsdom lacks `dialog.showModal`, `URL.createObjectURL` and `scrollBy`, so stub them. Delete and toggle wait ~400ms for exit animations, and saves are debounced by 300ms.

## Responsive layout

- `index.html` groups the UI into three panels: `.panel--nav` (title, theme toggle, category filters, shortcut list), `.panel--insights` (quote, stats) and `.panel--main` (the sticky `.main__controls` with the add form and search/sort, then the list and list actions).
- The "데스크톱 레이아웃" section at the end of `style.css` arranges them by width:
  - ≥1440px: 3 columns, with the nav and insights panels sticky.
  - 1024–1439px: 2 columns, with nav and insights stacked on the left.
  - ≥1920px: the middle column is capped at 1100px.
  - <1024px: everything sits in one card (`.app` is the card and the panels are transparent). The ≤480px rules add mobile touch sizing.
- A browser window 1024px wide has a viewport of about 1002px because of the scrollbar, so it gets the single-card layout.
- The page itself scrolls (no inner scroll container) because drag auto-scroll uses `window.scrollBy`. `stickyHeaderBottom()` makes upward auto-scroll start below the pinned `.main__controls`.
- `html { scroll-padding-top }` (240px, ≥1024px) must stay larger than the pinned header's height (~183px), or keyboard focus scrolls items underneath the header.
- The shortcut list shows only at ≥1024px on hover-capable devices; below that, the buttons' `title` tooltips carry the hints.
- `win.png` is the user's reference screenshot of the old single-column layout on a wide screen.

## Architecture

`script.js` is split into numbered sections (constants → DOM refs → state → … → init); a header comment lists them. `requireElement()` throws if `index.html` is missing an id the script needs.

**State and persistence**
- Persisted state lives in `localStorage` under `STORAGE_KEYS`:
  - `todos`: the array. Its order *is* the manual ("직접 정렬") order.
  - `todoFilter` and `todoSort`.
  - `todoTheme`. The inline script in `<head>` also reads this key to avoid a theme flash, so keep them in sync.
- Each todo is `{ id, text, completed, createdAt, category }`. Everything coming from storage or an imported file goes through `sanitizeTodo` / `sanitizeTodoList`, which drop items without text, coerce fields, migrate missing or invalid categories to `personal`, and re-id duplicate ids. Keep the shape backward compatible.
- When stored data is corrupt, `loadTodos()` copies the raw string to `todos_corrupted_backup` before starting fresh, and queues a startup toast.
- `saveTodos` is **debounced** (300ms). It is flushed on `pagehide`, `beforeunload` and `visibilitychange`. Call `saveTodos()`, never `persistTodos()` directly. A `storage` event reloads data changed in another tab; if this tab has a pending save, its own data wins instead.

**Render pipeline**
- Every mutation changes state, then calls `saveTodos()` and `render()`.
- `render()` → `getVisibleTodos()`: filter by `isVisible()` (category + search), then order by `sortForDisplay()`. `status` (the default) and `category` put completed items last; `newest` / `oldest` sort by `createdAt`; `manual` keeps array order.
- The list is **keyed**, not rebuilt:
  - `nodeCache` maps id → `{ el, sig, query }`, and `signatureOf()` covers everything that affects an item's markup. When the signature is unchanged, the existing `<li>` is reused; a changed search term only re-renders that item's highlight text.
  - `reconcileList()` first removes unwanted nodes, then walks the list, so moving one item costs one DOM move.
  - If you add a field that changes an item's markup, add it to `signatureOf()`, or the change will never show.
- Entry animations go through `entryAnimations` (id → class), which `render()` applies once and then clears. Exit animations run *before* the state change: `animateOut()` waits for `animationend`, with a timeout fallback, and `.is-leaving` blocks double clicks.
- The dashboard, badge, clear-completed button and cheer message all come from a single `computeStats()` pass. The dashboard markup is static, so only text and `style.width` change, which keeps the progress-bar transition working.

**Undo**
- `pushUndo(label, fn)` records an undoable action (delete, clear completed, edit, import); the stack holds up to `MAX_UNDO`.
- Ctrl+Z and the undo button run `undoLast()`, which is LIFO. A toast's "되돌리기" runs `runUndo(entry)` for that specific entry.
- `removeTodos()` returns `{ todo, index }`, and `restoreTodos()` re-inserts in ascending index order.
- The replace-import undo keeps a deep-copied snapshot, because toggles mutate todo objects in place.

**Import/export**
- Export writes `{ format: 'my-tasks', version: 1, exportedAt, todos }`.
- Import accepts that format or a bare array. `parseImportText()` throws `Error`s whose messages are shown to the user.
- When there is existing data, `#import-dialog` asks for merge or replace, plus an optional backup download. Merge skips ids that already exist. If the backup download fails, the import is aborted.

**Drag and drop (manual sort only)**
- Uses Pointer Events, not HTML5 DnD, so it works on touch. Capture is set on the `<ul>`, not the moving `<li>`, because some browsers release capture when a node is moved.
- The dragged `<li>` is moved live in the DOM, and pointerup reads the DOM order back into `reorderVisible()`. That function fills the visible items' slots in the array, so items hidden by the filter or search keep their positions.
- Esc or pointercancel restores the original order by re-rendering.
- Keyboard alternative: ↑/↓ on the `⋮⋮` handle (`moveTodoBy`).
- Handles are always rendered and shown only via `.todo-list.is-manual`.

**Keyword auto-category (section 6-1)**
- `classifyText(text)` matches `CATEGORY_KEYWORDS`. Korean keywords are matched as substrings (particles attach to nouns, e.g. "회의를"); ASCII keywords use `\b` word boundaries.
- Matchers run longest-first, and a match that overlaps characters already claimed is discarded: '산책' blocks the '책' inside it, and '머신러닝' blocks '러닝'. For this reason, don't add one-character Korean keywords ('책' would match '책상', '약' would match '계약'), and leave out words that span categories (발표, 예약, 면접).
- The category with the most matches wins. A tie goes to the match ending latest, because Korean is head-final ("영어 회의" → 업무).
- UI state: `categoryTouched` (the user picked from the dropdown since the last add) and `baseCategory` (their last manual pick, which is the fallback when no keyword matches).
  - Untouched: the dropdown is auto-set.
  - Touched: the dropdown is left alone and only a "추천" chip is shown.
  - `resetAutoCategory()` runs after each add.
- Only the dropdown's `change` event (fired by user picks, not programmatic sets) marks it touched. The on/off setting is saved under `todoAutoCategory`. The classifier runs only for new todos, not for inline edits or imports.

**Inline edit**
- `startEdit` commits any other open editor first.
- `commitEdit(id, …)` only acts when `editingId === id`, and it clears `editingId` *before* rendering. This matters because removing the focused editor fires `focusout`, which would otherwise commit twice or commit to the wrong item.
- Enter is ignored while `e.isComposing` (Korean IME). Enter and Esc return focus to the item's ✎ button; a commit triggered by clicking elsewhere doesn't steal focus.

**Accessibility and feedback**
- `announce()` writes to the visually hidden `#sr-status` live region; use it for actions that show no toast. Toasts live in an `aria-live` container, and errors get `role="alert"`.
- `openDialog()` restores focus to the opener. `focusTodo(id, selector)` moves focus after re-renders, e.g. to the neighbor after a delete or to the moved item after a keyboard toggle.
- Keyboard shortcuts are handled in one `document` keydown listener matching `e.code`, so they work under the Korean IME. Ctrl+Z is ignored inside text fields so native text undo still works.

## Conventions

- Set user-provided text with `textContent` or text nodes, never `innerHTML`. `appendHighlighted` builds `<mark>` elements by hand for this reason.
- Use the CSS custom properties on `:root` / `:root[data-theme="dark"]` for colors; hard-coded colors break dark mode.
- Theme switching temporarily adds `.theme-transition`, which forces color transitions on every element, so don't add per-element color transitions.
- Category colors flow through `--accent`, and `--accent-text` is a lightened variant for text on dark backgrounds. The default `--accent` must be declared *before* the `--work/--personal/--study` modifier rules because they have equal specificity.
- Under `max-width: 480px`, touch targets are at least 44px. `@media (hover: none)` reveals hover-only icon buttons and hides the shortcut hints.
- UI strings and code comments are in Korean.
- Adding a category means updating `CATEGORIES` in `script.js`; the `<option>`, filter button and `.stats-cat` block (with `data-count` / `data-bar`) in `index.html`; and the `--cat-*` color plus the modifier rules in the "카테고리 색" section of `style.css`.
