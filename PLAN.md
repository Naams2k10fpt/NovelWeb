# NovelWeb - Implementation Plan

NovelWeb is a personal desktop app for managing, reading, editing, importing, and exporting Light Novel / Web Novel content. Manga is no longer part of the product scope.

## Decisions

- Desktop app: Electron + Vite + React + TypeScript.
- Main process owns filesystem access.
- Renderer uses a narrow preload API only.
- Data is local-first in a user-selected Library folder.
- Storage remains JSON + index before SQLite.
- Every metadata file supports `schemaVersion`.
- PDF import is best-effort extracted text/images plus the original file for comparison; OCR stays out of scope.

## Architecture

```txt
Electron App
├── Main Process
│   ├── Window/app lifecycle
│   ├── Library path management
│   ├── Safe file I/O
│   ├── JSON/index storage
│   ├── Import/export services
│   ├── PDF parsing
│   ├── Search indexing
│   └── Backup/migration
├── Preload
│   └── Typed, narrow API exposed through contextBridge
└── Renderer
    ├── React UI
    ├── Library mode
    ├── Search mode
    ├── Manager mode
    ├── Novel editor/reader
    ├── Import wizard
    └── Settings
```

## Library Folder

```txt
NovelWeb Library
├── library.json
├── settings.json
├── index
│   ├── series-index.json
│   ├── search-index.json
│   └── recent-index.json
├── series
│   └── {series-id}
│       ├── meta.json
│       ├── cover.jpg
│       ├── progress.json
│       ├── bookmarks.json
│       ├── highlights.json
│       ├── categories
│       │   └── {category-id}
│       │       ├── meta.json
│       │       ├── volumes
│       │       │   └── {volume-id}
│       │       │       ├── meta.json
│       │       │       └── chapters
│       │       │           └── {chapter-id}
│       │       │               ├── meta.json
│       │       │               ├── content.html
│       │       │               ├── content.txt
│       │       │               ├── original.pdf
│       │       │               └── assets
│       │       └── chapters
│       │           └── {chapter-id}
│       │               ├── meta.json
│       │               ├── content.html
│       │               ├── content.txt
│       │               ├── original.pdf
│       │               └── assets
│       └── assets
├── backups
└── .trash
```

## Safety Rules

- Write files with atomic `.tmp` then rename.
- Backup important files before overwriting.
- Keep all writes/deletes inside Library root.
- Import sources outside Library only through a main-process import session created from an Electron dialog.
- Search uses `content.txt` and `search-index.json`.
- Keep repair/rebuild commands for indexes.
- Check `schemaVersion` when opening a Library.
- Serialize chapter saves so autosave and manual save cannot race.

## Metadata

### Series

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Title",
  "originalTitle": null,
  "originalAuthor": null,
  "translator": "Naams",
  "genres": ["Romance"],
  "tags": [],
  "status": "translating",
  "publisher": null,
  "year": null,
  "language": "vi",
  "sourceLanguage": "ja",
  "description": "",
  "categoryOrder": ["category-id"],
  "coverImage": "cover.jpg",
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z",
  "lastReadAt": null
}
```

### Category

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "type": "light-novel",
  "title": "Light Novel",
  "volumeOrder": ["volume-id"],
  "chapterOrder": [],
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

Category `type` is `light-novel` or `web-novel`.

### Volume

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Volume 1",
  "order": 1,
  "chapterOrder": ["chapter-id"],
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

### Chapter

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Chapter 1",
  "type": "chapter",
  "order": 1,
  "wordCount": 5000,
  "characterCount": 23000,
  "tags": [],
  "translationStatus": "draft",
  "hasOriginalPdf": true,
  "originalFileName": "source.pdf",
  "contentFile": "content.html",
  "plainTextFile": "content.txt",
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

Chapter `type`: `prologue`, `chapter`, `epilogue`, `interlude`, `afterword`, `bonus`.

Translation `status`: `draft`, `editing`, `reviewed`, `completed`.

## Roadmap

### Phase 0-6 - Complete

- App shell, safe storage, core data model, Library/Manager UI, Novel editor/reader, and import foundation.

### Phase 9 - Complete

- Search, recent reading, bookmarks, highlight notes, and reader/editor marker flow.

### Phase 10 - Export

- Export chapter/volume/series to PDF.
- Export chapter/volume/series to EPUB.
- Include cover, metadata, table of contents, headings, inline images, and page breaks.
- Verify Vietnamese fonts and images.

### Phase 11 - Backup, Restore, Migration

- Metadata backup.
- Content backup.
- Full library backup.
- Restore library from backup.
- Backup before migration.
- Trash restore and permanent delete.
- Simple chapter version history.

### Phase 12 - Final Build And Testing

- Configure Windows packaging.
- Prepare app icon.
- Build installer.
- Test all main LN/WN workflows with real data.

## UI Guidance

- This is a work-focused personal library app, not a landing page.
- Library mode prioritizes browsing and returning to recent reading.
- Manager mode prioritizes clear structure operations and import status.
- Reader prioritizes typography, line-height, reading width, and low distraction.
- Avoid decorative UI that slows repeated editing/reading workflows.

## Verification

```bash
npm run dev
npm run build
```

Manual checks:

1. Choose/create Library folder.
2. Create series/category/volume/chapter.
3. Close/open app and confirm metadata persists.
4. Edit chapter and confirm autosave/Ctrl+S.
5. Read chapter and confirm progress persists.
6. Import TXT/MD/DOCX/PDF.
7. Use PDF/Markdown split view.
8. Search and open result.
9. Bookmark and highlight note.
10. Rebuild indexes.
