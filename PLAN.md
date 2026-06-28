# NovelWeb - Implementation Plan

NovelWeb là ứng dụng desktop cá nhân để lưu trữ, quản lý, chỉnh sửa và đọc Light Novel, Web Novel và Manga tự dịch. Tầm nhìn dài hạn vẫn bao gồm LN/WN/Manga, PDF split view, editor, reader, search, export và backup. MVP đầu tiên sẽ tập trung vào LN/WN để làm chắc nền tảng trước khi mở rộng sang manga.

## Quyết định đã chốt

- App dùng Electron, chấp nhận dung lượng build Windows khoảng 150-200MB do đóng gói Chromium.
- Stack triển khai: Electron + Vite + React + TypeScript.
- Dùng `electron-vite` để quản lý main process, preload và renderer.
- MVP đầu tiên ưu tiên LN/WN: app nền, lưu trữ an toàn, CRUD dữ liệu, editor, reader, import TXT/MD/DOCX/PDF.
- Manga vẫn là tính năng quan trọng nhưng triển khai sau khi nền LN/WN ổn.
- Giai đoạn đầu dùng JSON + index, chưa dùng SQLite.
- Mọi metadata phải có `schemaVersion` để hỗ trợ migration sau này.
- PDF import chỉ là bản trích xuất nháp để người dùng kiểm tra/chỉnh sửa trong split view; không hứa giữ format hoàn hảo.
- Scanned PDF/OCR chưa thuộc MVP. Nếu PDF không có text, app lưu PDF gốc và báo cần xử lý ngoài.

---

## Kiến trúc tổng thể

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
    ├── Manager mode
    ├── Novel editor/reader
    ├── Import wizard
    └── Later: Manga manager/reader, export tools
```

Main process là nơi duy nhất được đọc/ghi filesystem. Renderer chỉ gọi API đã expose qua preload, không truy cập trực tiếp Node.js API.

---

## Project setup

### Cấu trúc code dự kiến

```txt
NovelWeb
├── electron
│   ├── main.ts
│   ├── preload.ts
│   ├── ipc
│   │   ├── library.ts
│   │   ├── series.ts
│   │   ├── categories.ts
│   │   ├── volumes.ts
│   │   ├── chapters.ts
│   │   ├── import.ts
│   │   ├── search.ts
│   │   ├── settings.ts
│   │   └── later-manga-export-backup.ts
│   ├── services
│   │   ├── libraryService.ts
│   │   ├── fileStore.ts
│   │   ├── indexService.ts
│   │   ├── importService.ts
│   │   ├── pdfService.ts
│   │   └── migrationService.ts
│   └── schemas
│       ├── common.ts
│       ├── library.ts
│       ├── series.ts
│       └── chapter.ts
├── src
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── pages
│   │   ├── Library.tsx
│   │   ├── SeriesDetail.tsx
│   │   ├── Manager.tsx
│   │   ├── NovelReader.tsx
│   │   └── later-MangaReader.tsx
│   ├── components
│   │   ├── Sidebar.tsx
│   │   ├── TreeView.tsx
│   │   ├── ChapterEditor.tsx
│   │   ├── ImportWizard.tsx
│   │   ├── PdfCompareView.tsx
│   │   └── later-PageManager.tsx
│   ├── hooks
│   ├── types
│   └── api
│       └── client.ts
├── resources
│   └── icon.ico
├── package.json
├── electron.vite.config.ts
└── electron-builder.yml
```

Tên file `later-*` chỉ biểu thị nhóm tính năng chưa thuộc MVP đầu; khi triển khai thật có thể tạo file đúng tên ở phase tương ứng.

### Dependencies chính

| Package | Mục đích |
| --- | --- |
| `electron` | Desktop app framework |
| `electron-vite` | Build/dev workflow cho Electron + Vite |
| `electron-builder` | Build Windows installer |
| `typescript` | Type safety cho IPC, schema và data model |
| `react`, `react-dom` | UI |
| `react-router-dom` | Routing |
| `zod` | Validate IPC input và metadata |
| `@tiptap/react`, `@tiptap/starter-kit`, extensions | WYSIWYG editor |
| `@dnd-kit/core`, `@dnd-kit/sortable` | Drag & drop |
| `pdf-parse` | Trích xuất text PDF ở mức nháp |
| `pdfjs-dist` | Render PDF gốc trong split view |
| `mammoth` | Đọc DOCX |
| `lucide-react` | Icons |
| `uuid` | Generate IDs |

---

## Lưu trữ dữ liệu

Không lưu dữ liệu chính trong thư mục cài app hoặc thư mục code khi build thật.

### Vị trí lưu

- `app.getPath("userData")`: lưu app settings nhỏ, ví dụ đường dẫn Library hiện tại, window state, preference gần nhất.
- User-selected Library folder: lưu toàn bộ dữ liệu truyện, PDF gốc, ảnh, index, backup.

Phân biệt settings:

- App-level settings trong `userData`: `currentLibraryPath`, window size/state, last opened route, recent library list.
- Library-level settings trong Library folder: library name, default reading font/theme, backup preference, import preference.

### Cấu trúc Library folder

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
│       │               └── pages
│       └── assets
│           ├── illustrations
│           ├── thumbnails
│           └── originals
├── backups
└── .trash
```

`categories/{category-id}/chapters` dùng cho manga hoặc WN không chia volume. Với MVP novel-first, phần manga có thể có schema nhưng chưa cần UI đầy đủ.

### Data safety bắt buộc

- Ghi file bằng atomic write: ghi vào `.tmp`, backup file hiện tại, rồi rename.
- Trước migration phải tạo backup.
- Xóa mềm tối thiểu phải có từ phase Manager đầu tiên: move item vào `.trash`; UI restore đầy đủ có thể làm sau.
- Mọi thao tác ghi/xóa phải nằm trong Library root.
- Thao tác đọc source import được phép nằm ngoài Library chỉ khi path đến từ Electron dialog và import session hợp lệ do main process tạo.
- Search dùng `content.txt` và `search-index.json`, không quét toàn bộ `content.html` mãi mãi.
- Có library health check và repair/rebuild index: rebuild `series-index.json` từ `series/`, rebuild `search-index.json` từ `content.txt`.
- Có `migrationService` skeleton từ sớm: khi mở Library phải kiểm tra `schemaVersion`; nếu version không hỗ trợ thì báo lỗi rõ ràng.
- Có save queue/write lock theo resource, đặc biệt cho chapter editor, để autosave và Ctrl+S không ghi chồng sai thứ tự.

### Backup strategy

- Metadata backup: `meta.json`, index, settings, progress, bookmarks, highlights.
- Content backup: `content.html`, `content.txt` và metadata liên quan.
- Full backup: toàn bộ Library gồm PDF gốc và ảnh; có thể rất nặng nên ưu tiên chạy thủ công.

---

## Metadata schema tối thiểu

### Series

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Jimikawa",
  "originalTitle": "Tên gốc",
  "originalAuthor": "Tác giả gốc",
  "translator": "Naams",
  "genres": ["Romance", "School Life"],
  "tags": [],
  "status": "translating",
  "publisher": "NXB gốc",
  "year": 2020,
  "language": "vi",
  "sourceLanguage": "ja",
  "description": "Mô tả...",
  "categoryOrder": ["cat-ln-id"],
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
  "volumeOrder": ["vol-id-1"],
  "chapterOrder": [],
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

`type` gồm `light-novel`, `web-novel`, `manga`.

### Volume

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Volume 1",
  "order": 1,
  "chapterOrder": ["chapter-id-1"],
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

### Chapter LN/WN

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Chương 1 - Tiêu đề",
  "type": "chapter",
  "order": 1,
  "wordCount": 5000,
  "characterCount": 23000,
  "translationStatus": "draft",
  "hasOriginalPdf": true,
  "originalFileName": "Jimikawa_Tap3_Chuong1.pdf",
  "contentFile": "content.html",
  "plainTextFile": "content.txt",
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

Chapter type gồm `prologue`, `chapter`, `epilogue`, `interlude`, `afterword`, `bonus`. Translation status gồm `draft`, `editing`, `reviewed`, `completed`.

### Chapter Manga

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Chapter 1",
  "order": 1,
  "pageCount": 24,
  "pageOrder": ["page_001.jpg", "page_002.jpg"],
  "readingDirection": "rtl",
  "viewMode": "long-strip",
  "thumbnail": "thumb_001.jpg",
  "totalSizeBytes": 120000000,
  "createdAt": "2026-06-25T00:00:00Z",
  "updatedAt": "2026-06-25T00:00:00Z"
}
```

---

## IPC và preload contract

### Security rules

- `contextIsolation: true`.
- `nodeIntegration: false`.
- Không expose `ipcRenderer` trực tiếp.
- Preload chỉ expose API nhóm rõ ràng qua `contextBridge`.
- Main process validate input bằng `zod`.
- Main process trả lỗi thống nhất để renderer hiển thị được.

### Response format

```ts
type ApiResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };
```

### API shape dự kiến

```ts
window.api.library.getCurrent();
window.api.library.chooseFolder();
window.api.series.list();
window.api.series.get(seriesId);
window.api.series.create(input);
window.api.series.update(seriesId, input);
window.api.series.moveToTrash(seriesId);
window.api.categories.create(seriesId, input);
window.api.volumes.create(seriesId, categoryId, input);
window.api.chapters.get(seriesId, categoryId, volumeId, chapterId);
window.api.chapters.save(seriesId, categoryId, volumeId, chapterId, input);
window.api.import.chooseSourceFolder();
window.api.import.scan(importSessionId);
window.api.import.parsePdf(importSessionId, fileId);
window.api.import.execute(importSessionId, importPlan);
window.api.settings.get();
window.api.settings.update(input);
```

`importSessionId` do main process tạo sau khi user chọn folder bằng Electron dialog. Renderer không được gửi path import tùy ý để main process đọc trực tiếp.

Manga, export, backup/restore API được thêm ở phase sau khi nền novel ổn.

---

## Roadmap triển khai

### Phase 0 - Chốt nền tảng

- Chấp nhận Electron build size.
- Chốt TypeScript.
- Chốt JSON + index.
- Chốt Novel-first MVP.
- Chốt PDF import là trích xuất nháp, không OCR.

### Phase 1 - App shell

- Scaffold Electron + Vite + React + TypeScript.
- Tạo main/preload/renderer.
- Bật security defaults.
- Tạo layout Library/Manager cơ bản.
- App chạy bằng `npm run dev`.

### Phase 2 - Storage foundation

- Chọn/tạo Library folder.
- Lưu current library path trong `userData`.
- Tạo cấu trúc Library folder.
- Tách rõ app-level settings trong `userData` và library-level settings trong Library folder.
- Implement safe JSON read/write.
- Implement path safety.
- Implement response/error format.
- Tạo `migrationService` skeleton và check `schemaVersion` khi mở Library.
- Tạo library health check.
- Tạo repair/rebuild `series-index.json`; chuẩn bị skeleton rebuild `search-index.json`.

### Phase 3 - Core data model

- CRUD Series, Category, Volume, Chapter LN/WN.
- Validate bằng `zod`.
- Cập nhật `series-index.json`.
- Load tree structure cho Manager.
- Xóa mềm tối thiểu bằng cách move folder/item vào `.trash`.
- Đảm bảo index cập nhật đồng bộ khi create/update/delete.

### Phase 4 - Library và Manager cơ bản

- Library hiển thị series card.
- Series detail hiển thị tab category.
- Manager hiển thị tree view.
- Context menu cơ bản: thêm, sửa tên, xóa mềm bằng `.trash` tối thiểu.
- Loading/empty/error states rõ ràng.

### Phase 5 - Novel editor và reader

- Tích hợp TipTap.
- Lưu `content.html` và `content.txt`.
- Autosave debounce + Ctrl+S.
- Save queue theo `chapterId`: không cho hai thao tác save cùng chapter chạy song song.
- Save mới nhất thắng; save cũ bị bỏ qua nếu đã stale.
- Cảnh báo khi rời chapter còn nội dung chưa lưu.
- Trạng thái lưu rõ ràng.
- NovelReader có font size, reading width, theme và progress.

### Phase 6 - Import TXT/MD/DOCX/PDF

- Import Wizard 3 bước: chọn folder, preview/chỉnh sửa, confirm.
- Source folder phải đến từ Electron dialog và được main process gắn với import session.
- Parse TXT/MD/DOCX.
- Parse PDF ở mức text nháp.
- Nếu `pdf-parse` lỗi, thử fallback extractor bằng `pdfjs-dist`.
- Nếu PDF không có text, đánh dấu `scanned/unsupported`, vẫn lưu PDF gốc và báo cần OCR ngoài.
- PDF Split View: PDF gốc bên trái, text/editor bên phải.
- Lưu PDF gốc cùng chapter.
- Log và report sau import.

### Phase 7 - Manga management

- Tạo manga category/chapter.
- Add/remove/reorder pages.
- Thumbnail cache.
- PageManager dùng thumbnail, không load full-size toàn bộ ảnh.

### Phase 8 - Manga reader

- Long strip mode.
- Page mode.
- RTL/LTR.
- Fit width/height, zoom.
- Keyboard navigation.
- Lưu trang đang đọc.

### Phase 9 - Search, bookmark, highlight, note

- Search từ `content.txt`.
- Search index cập nhật theo chapter.
- Bookmark, highlight, note.
- Recent reading.

### Phase 10 - Export PDF/EPUB

- Export chapter/volume/series.
- Cover, metadata, mục lục, heading, ảnh inline, page break.
- Test kỹ tiếng Việt và ảnh.
- Export không thuộc điều kiện MVP đầu.

### Phase 11 - Backup, restore, migration

- Backup thủ công và tự động theo 3 loại: metadata backup, content backup, full backup.
- Restore library.
- Migration theo `schemaVersion`.
- Trash nội bộ.
- Version history đơn giản cho chapter.

### Phase 12 - Build và kiểm thử cuối

- Build Windows `.exe`.
- Icon app, desktop shortcut.
- Test với dữ liệu thật: import, editor, reader, manga, search, export, backup/restore.

---

## UI/UX định hướng

- App là công cụ cá nhân để đọc và quản lý nội dung, không phải landing page.
- Library mode ưu tiên đọc, duyệt và quay lại nội dung nhanh.
- Manager mode ưu tiên thao tác rõ ràng, trạng thái lưu/import/error dễ thấy.
- Reader ưu tiên font dễ đọc, line-height tốt, width hợp lý, ít phân tâm.
- Glassmorphism/blur chỉ dùng tiết chế ở sidebar/modal/card; không lạm dụng trong danh sách dài.
- Manga UI phải thiết kế cho hiệu năng: thumbnail, lazy load, không render ảnh gốc hàng loạt.

---

## Verification plan

### Kiểm tra tự động

```bash
npm run dev
npm run build
```

Sau khi có test:

```bash
npm run test
npm run typecheck
```

### Kiểm tra thủ công theo MVP

1. Mở app bằng dev mode.
2. Chọn/tạo Library folder.
3. Tạo series, category LN/WN, volume, chapter.
4. Đóng/mở app, dữ liệu vẫn còn.
5. Editor lưu `content.html` và `content.txt`.
6. Autosave và Ctrl+S hoạt động.
7. NovelReader đọc được chapter và lưu progress.
8. Import TXT/MD/DOCX/PDF qua wizard.
9. PDF split view hiển thị PDF gốc và text/editor.
10. Import source ngoài Library chỉ được đọc khi đến từ dialog/import session hợp lệ.
11. Path ghi/xóa ngoài Library bị từ chối.
12. Repair/rebuild index hoạt động.
13. Ghi file lỗi không làm mất file cũ.

### Kiểm tra sau MVP

1. Manga PageManager add/remove/reorder pages.
2. MangaReader long strip/page mode.
3. Search index hoạt động với nhiều chapter.
4. Export PDF/EPUB không lỗi tiếng Việt.
5. Backup/restore/migration không làm hỏng library cũ.
6. Update app không làm mất Library folder.

---

## Liên kết với PROGRESS.md

`PROGRESS.md` là tracker theo dõi việc làm từng phase. Khi thay đổi roadmap hoặc scope trong file này, cần đối chiếu và cập nhật checklist trong `PROGRESS.md` để hai tài liệu không mâu thuẫn.
