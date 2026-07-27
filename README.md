# NovelWeb

NovelWeb is a personal desktop app for storing, managing, editing, reading, importing, and exporting Light Novel / Web Novel content.

The app is local-first: user content lives in a Library folder chosen by the user. The main process owns filesystem access, while the renderer talks through a narrow preload API.

## Current Status

The LN/WN MVP is complete, including export, backup/restore, import hardening, Windows packaging, workflow tests, statistics, tags, collections, and export preview. Manga is out of scope.

## Features

- Library folder selection through Electron dialogs.
- Safe JSON storage with atomic writes and `.bak` backups for important files.
- Path guards so filesystem writes stay inside the Library root.
- Library health checks and index rebuild support.
- CRUD for Series, Category, Volume, and LN/WN Chapter metadata.
- Library, Series Detail, Search, Manager, and Settings views.
- TipTap editor with formatting toolbar, autosave, Ctrl+S, save state, inline images, and PDF/Markdown original split view.
- NovelReader with font size, reading width, theme, scroll progress, chapter navigation, bookmarks, and edit markers.
- Import Wizard in Manager for TXT, MD, DOCX, and PDF.
- Search index based on `content.txt`, plus bookmarks, recent reading, and highlight notes.
- Metadata, content, and full Library backups from Settings.
- Safe restore to a new Library folder and automatic backed-up `schemaVersion` migration.
- Trash browser with restore and confirmed permanent delete.
- Chapter content history with restore from the editor.
- Chapter, volume, and series PDF export with metadata, headings, inline images, table of contents, and A4 print styling.
- Chapter, volume, and series EPUB 3 export with metadata, navigation, ordered XHTML content, and packaged inline images.
- Series covers are included in PDF title pages and EPUB cover documents.

## Tech Stack

- Electron
- Vite
- React
- TypeScript
- electron-vite
- TipTap

## Architecture

```txt
Electron App
├── Main Process
│   ├── Window/app lifecycle
│   ├── Library path management
│   ├── Safe file I/O
│   ├── JSON/index storage
│   ├── Import/PDF parsing
│   ├── Search/reading state
│   └── Migration/health-check foundation
├── Preload
│   └── Narrow API exposed through contextBridge
└── Renderer
    ├── React UI
    ├── Library/Search
    ├── Manager/Import
    ├── Novel editor/reader
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
├── backups
└── .trash
```

Series data is stored under `series/{series-id}` with metadata, categories, volumes, chapters, content files, original files, reading progress, bookmarks, highlights, and assets.

## Commands

```bash
npm install
npm run dev
npm test
npm run test:pdf
npm run build
npm run package:dir
npm run package:win
```

## Branch Workflow

- `main`: stable/demo-ready state.
- `develop`: integration branch.
- task branches: small scoped changes from `develop` or the current release branch.

Run `npm run build` after meaningful changes.
