# NovelWeb Progress

This tracker follows the current LN/WN-only product scope. Manga support was removed from scope on 2026-07-08.

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Needs review

## Working Rules

- Build one small task at a time.
- Prefer stable storage and data safety over UI polish.
- Main process owns filesystem access.
- Renderer uses preload APIs only.
- JSON + index storage comes before SQLite.
- Every metadata file supports `schemaVersion`.
- Run `npm run build` after meaningful changes.

## Implementation Groups

Complete each group as one tested workflow while keeping the phase checklist below as the source of completion status.

1. **Data safety and migration — complete**
   - Metadata backup, content backup, backup before migration, and migration by `schemaVersion`.
2. **Recovery and history — complete**
   - Restore from `.trash`, permanent delete with confirmation, and simple chapter version history.
3. **Export**
   - Shared chapter/volume/series export flow for PDF and EPUB, including cover, metadata, table of contents, headings, inline images, page breaks, Vietnamese fonts, export tests, and export preview.
4. **Import hardening**
   - Duplicate detection by file hash, detailed import history, TXT/MD/DOCX/PDF workflow tests, and PDF/Markdown split-view tests.
5. **Core workflow QA**
   - Library selection, editor/autosave, NovelReader, and final bug checklist.
6. **Windows release**
   - App icon, packaging configuration, installer build, and update testing without data loss.
7. **Post-MVP library features**
   - Statistics, free-form tags, and collections.

---

## Phase 0 - Foundation Decisions

**Status:** `[x]`

- [x] Electron app accepted.
- [x] TypeScript chosen.
- [x] JSON + index chosen before SQLite.
- [x] Library data stored in a user-selected folder.
- [x] App settings stored in `app.getPath("userData")`.
- [x] LN/WN-only product scope confirmed.
- [x] PDF import is best-effort extracted text/images plus original file.
- [x] OCR/scanned PDF remains out of scope.

---

## Phase 1 - App Shell

**Status:** `[x]`

- [x] Electron + Vite + React + TypeScript scaffold.
- [x] Main/preload/renderer created.
- [x] Security defaults enabled.
- [x] Sidebar layout with Library, Search, Manager, Settings.
- [x] App runs in dev mode.

---

## Phase 2 - Safe Storage

**Status:** `[x]`

- [x] Choose/change Library folder.
- [x] Create Library folder structure.
- [x] Safe JSON read/write.
- [x] Atomic writes through `.tmp` then rename.
- [x] Backup important files before overwrite.
- [x] Path safety guards.
- [x] Import session guard for outside-Library source files.
- [x] IPC response shape `{ ok, data, error }`.
- [x] Library health check.
- [x] Rebuild `series-index.json`.
- [x] Search index skeleton.
- [x] Migration skeleton and `schemaVersion` checks.
- [x] Per-resource write queue.

---

## Phase 3 - Core Data Model

**Status:** `[x]`

- [x] Series metadata.
- [x] Category metadata for `light-novel` and `web-novel`.
- [x] Volume metadata.
- [x] Chapter metadata for LN/WN.
- [x] CRUD Series.
- [x] CRUD Category.
- [x] CRUD Volume.
- [x] CRUD Chapter.
- [x] Soft-delete to `.trash`.
- [x] Series index updates on metadata changes.

---

## Phase 4 - Library And Manager UI

**Status:** `[x]`

- [x] Library page with series cards.
- [x] Series detail page with category tabs.
- [x] Manager tree for series/category/volume/chapter.
- [x] Manager lazy-loads series children to avoid scanning every chapter on open.
- [x] Manager context actions.
- [x] Import entry points from Manager.
- [x] Chapter reorder and move between valid LN/WN folders.
- [x] Ctrl/Shift multi-select chapters in Manager and drag selected chapters to an exact drop position.
- [x] Fallback move-to-trash when Windows blocks direct directory rename.
- [x] Loading/empty/error states.

---

## Phase 5 - Novel Editor And Reader

**Status:** `[x]`

- [x] TipTap editor.
- [x] Formatting toolbar.
- [x] Save `content.html`.
- [x] Generate `content.txt`.
- [x] Autosave debounce and Ctrl+S.
- [x] Save serialization.
- [x] Dirty warning when leaving chapter.
- [x] Save status UI.
- [x] Inline images copied into chapter assets.
- [x] Sanitized HTML render/save.
- [x] NovelReader from `content.html`.
- [x] Reader font size, width, theme.
- [x] Reading progress by scroll.
- [x] Reader toolbar with previous/list/mark/bookmark/next.
- [x] Reader mark popup with note.
- [x] Editor displays saved mark notes.
- [x] Mark offsets prevent highlighting the wrong repeated text.

---

## Phase 6 - TXT/MD/DOCX/PDF Import

**Status:** `[x]`

- [x] Import Wizard.
- [x] Choose folder/files through Electron dialogs.
- [x] Scan import source.
- [x] Rename/skip items before import.
- [x] Import TXT.
- [x] Import MD with basic formatting.
- [x] Import DOCX through `mammoth`.
- [x] Import PDF through parser with fallback.
- [x] Import PDF images as best-effort chapter assets.
- [x] Harden PDF image import to keep successful pages when one page fails.
- [x] Repair missing imported PDF images when opening older PDF chapters.
- [x] Detect PDF images inside form XObjects.
- [x] Strip common PDF page number/footer markers during import.
- [x] Preserve original PDF.
- [x] PDF split view.
- [x] PDF split view renders large originals through Blob URLs.
- [x] PDF image import uses an explicit Node canvas factory in Electron main.
- [x] Write `index/import.log` diagnostics for PDF image import.
- [x] Pin PDF.js worker to the matching `pdfjs-dist` version for image extraction.
- [x] Preserve original Markdown and show split view.
- [x] Import `illustrations` folders as image chapters.
- [x] Import into new or existing series/category/volume.
- [x] Skip pre-import text preview and read source content during import execution.
- [x] Progress and report UI.

---

## Phase 9 - Search, Recent, Bookmark, Highlight Note

**Status:** `[x]`

- [x] Search from `content.txt`.
- [x] Search index.
- [x] Update search index when chapters change.
- [x] Search result snippets.
- [x] Open result at matching chapter/position.
- [x] Temporary search highlight fades after navigation.
- [x] Recent reading with Library carousel.
- [x] Library load avoids repeated empty recent-index rebuilds.
- [x] Bookmark chapter/position.
- [x] Highlight selected reader text with note.
- [x] Hover highlight to view note.
- [x] Editor shows highlight notes for fixes.

---

## Current Scope Cleanup - 2026-07-08

**Status:** `[x]`

- [x] Product scope changed to LN/WN only.
- [x] Removed user-facing page workflow from renderer.
- [x] Removed reader route for image-page chapters.
- [x] Removed page-management UI from Manager.
- [x] Removed page APIs from preload.
- [x] Removed image-page CRUD from the main process.
- [x] Removed retired category/chapter schema values.
- [x] New category creation rejects removed category type.
- [x] Updated README and PLAN to match current scope.

---

## Phase 10 - Export

**Status:** `[x]`

- [x] Export chapter to PDF.
- [x] Export volume to PDF.
- [x] Export series to PDF.
- [x] Export chapter to EPUB.
- [x] Export volume to EPUB.
- [x] Export series to EPUB.
- [x] Include cover, metadata, table of contents, headings, inline images, and page breaks.
- [x] Test Vietnamese fonts.

---

## Phase 11 - Backup, Restore, Migration

**Status:** `[x]`

- [x] Metadata backup.
- [x] Content backup.
- [x] Full library backup.
- [x] Restore library from backup.
- [x] Backup before migration.
- [x] Migration by `schemaVersion`.
- [x] Restore from `.trash`.
- [x] Permanent delete with confirmation.
- [x] Simple chapter version history.

---

## Phase 12 - Final Build And Testing

**Status:** `[~]`

- [x] Configure Windows packaging.
- [x] Prepare app icon.
- [x] Build installer.
- [x] Test Library selection.
- [x] Test CRUD series/category/volume/chapter.
- [x] Test editor and autosave.
- [ ] Test NovelReader.
- [ ] Test TXT/MD/DOCX/PDF import.
- [ ] Test PDF/Markdown split view.
- [x] Test search.
- [x] Test bookmark/highlight notes.
- [ ] Test export PDF/EPUB.
- [x] Test backup/restore.
- [ ] Test update without data loss.
- [ ] Final bug checklist.

---

## Backlog

- [ ] Duplicate detection on import by file hash.
- [ ] Statistics: series, chapters, words, and Library size.
- [ ] Free-form tags for series/chapter.
- [ ] Collections: Reading, Favorite, Needs Edit, Completed.
- [ ] Detailed import history.
- [ ] Export preview.
