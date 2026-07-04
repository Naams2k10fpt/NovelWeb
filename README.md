# NovelWeb

NovelWeb là ứng dụng desktop cá nhân để lưu trữ, quản lý, chỉnh sửa, đọc, import và export Light Novel, Web Novel và Manga tự dịch.

Dự án hướng tới một thư viện nội dung local-first: dữ liệu chính nằm trong thư mục Library do người dùng chọn, app ưu tiên an toàn dữ liệu, khả năng mở rộng lâu dài và workflow viết/đọc nội dung cá nhân.

## Trạng thái hiện tại

NovelWeb hiện đã hoàn thành:

- Phase 0: Chốt nền tảng kỹ thuật và phạm vi MVP.
- Phase 1: Khởi tạo app Electron + Vite + React + TypeScript.
- Phase 2: Nền tảng lưu trữ an toàn.
- Phase 3: Data model core cho Series, Category, Volume và Chapter LN/WN.
- Phase 4: UI Library và Manager cơ bản.
- Phase 5: Novel editor và reader.
- Phase 6: Import TXT/MD/DOCX/PDF.
- Phase 9: Search, bookmark, highlight, note và recent reading.

Phase tiếp theo là Phase 7: Manga management.

> Lưu ý: Manga management/reader, export PDF/EPUB, backup/restore đầy đủ và build installer vẫn đang nằm trong roadmap.

## Tính năng đã có

- App desktop Electron chạy bằng `electron-vite`.
- Renderer React với các tab Library, Search, Manager, Import và Settings.
- Chọn và đổi Library folder bằng Electron dialog.
- Lưu `currentLibraryPath` trong `app.getPath("userData")`.
- Tạo cấu trúc Library folder tự động:
  - `library.json`
  - `settings.json`
  - `index/`
  - `index/series-index.json`
  - `index/search-index.json`
  - `series/`
  - `backups/`
  - `.trash/`
- Đọc JSON an toàn, báo lỗi khi JSON hỏng thay vì ghi đè im lặng.
- Ghi JSON bằng atomic write: ghi `.tmp`, rồi `rename`.
- Backup file cũ bằng `.bak` trước khi ghi đè file quan trọng.
- Guard path để thao tác file/thư mục con không vượt ra ngoài Library root.
- Health check cơ bản cho Library.
- Rebuild `series-index.json` từ `series/*/meta.json`.
- Skeleton `search-index.json`.
- Skeleton migration dựa trên `schemaVersion`.
- Kiểm tra `schemaVersion` khi mở Library.
- Per-resource write queue để tránh các lần ghi cùng file chạy chồng nhau.
- IPC response thống nhất dạng `{ ok, data, error }`.
- CRUD Series, Category, Volume và Chapter LN/WN.
- Library/Series Detail/Manager UI để duyệt và quản lý cấu trúc truyện.
- TipTap editor với toolbar cơ bản, autosave, Ctrl+S và trạng thái lưu.
- Lưu `content.html`, sinh `content.txt`, sanitize HTML và hỗ trợ ảnh inline.
- NovelReader với font size, reading width, theme và progress theo scroll.
- Import Wizard cho TXT, MD, DOCX và PDF qua import session từ Electron dialog.
- PDF split view để đối chiếu PDF gốc với text/editor.
- Search qua `search-index.json`, bookmark, highlight/note và recent reading.

## Tầm nhìn tính năng

Khi hoàn thiện, NovelWeb sẽ hỗ trợ:

- Quản lý Light Novel và Web Novel theo series, category, volume và chapter.
- Editor cho nội dung dịch với autosave, Ctrl+S, trạng thái lưu rõ ràng và chống ghi đè sai thứ tự.
- Reader cho LN/WN với tùy chỉnh font, theme, reading width và tiến độ đọc.
- Import TXT, MD, DOCX và PDF qua Import Wizard.
- PDF split view để đối chiếu file gốc và text trích xuất.
- Quản lý Manga theo chapter/page, thumbnail cache và sắp xếp trang.
- Manga reader với long strip, page mode, RTL/LTR, zoom và lazy load.
- Search dựa trên `content.txt` và `search-index.json`.
- Bookmark, highlight, note và recent reading.
- Export PDF/EPUB.
- Backup, restore, migration và trash nội bộ.

## Tech stack

- Electron
- Vite
- React
- TypeScript
- electron-vite

Các dependency hiện tại bao gồm nền app, editor và parser import. Drag & drop, icons hoặc packaging sẽ được thêm khi đến phase tương ứng.

## Kiến trúc

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

Nguyên tắc quan trọng:

- Main process là nơi duy nhất đọc/ghi filesystem.
- Renderer không truy cập trực tiếp Node.js API.
- `contextIsolation` bật.
- `nodeIntegration` tắt.
- Preload chỉ expose API hẹp qua `contextBridge`.
- Không expose thẳng `ipcRenderer`.

## Cấu trúc Library folder

Ở trạng thái hiện tại, khi người dùng chọn Library folder, NovelWeb tạo cấu trúc nền tảng sau:

```txt
NovelWeb Library
├── library.json
├── settings.json
├── index
│   ├── series-index.json
│   └── search-index.json
├── series
├── backups
└── .trash
```

Trong roadmap, thư mục `series/` sẽ chứa dữ liệu truyện thật:

```txt
series
└── {series-id}
    ├── meta.json
    ├── cover.jpg
    ├── progress.json
    ├── bookmarks.json
    ├── highlights.json
    └── categories
        └── {category-id}
            ├── meta.json
            ├── volumes
            └── chapters
```

## Data safety

NovelWeb ưu tiên dữ liệu cá nhân an toàn hơn là UI đẹp quá sớm.

Các nguyên tắc đang áp dụng:

- App-level settings nhỏ lưu trong `app.getPath("userData")`.
- Dữ liệu truyện chính lưu trong Library folder do user chọn.
- Không lưu dữ liệu chính trong thư mục cài app.
- Mọi metadata có `schemaVersion`.
- Ghi JSON qua `.tmp` rồi `rename`.
- Backup file cũ bằng `.bak` trước khi ghi đè file quan trọng.
- Mọi path con trong Library đều được guard để không thoát khỏi Library root.
- `series-index.json` có thể rebuild từ metadata thật trong `series/`.

Import source ngoài Library sẽ được guard theo import session khi triển khai Import Wizard ở Phase 6.

## Cài đặt và chạy

Yêu cầu:

- Node.js phiên bản phù hợp với Electron/Vite hiện tại.
- npm.

Cài dependency:

```bash
npm install
```

Chạy app ở dev mode:

```bash
npm run dev
```

Kiểm tra TypeScript:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

## Scripts

| Script | Mục đích |
| --- | --- |
| `npm run dev` | Chạy Electron app ở dev mode |
| `npm run typecheck` | Kiểm tra TypeScript bằng `tsc --noEmit` |
| `npm run build` | Typecheck và build main/preload/renderer bằng `electron-vite` |

## Branch workflow

- `main`: bản stable, chỉ chứa trạng thái đã chạy được và có thể demo/build.
- `develop`: nhánh phát triển chính.
- `phase/*`: nhánh triển khai theo phase lớn.
- `task/*`: nhánh task nhỏ khi cần.
- `fix/*`: nhánh sửa lỗi khi cần.

Workflow hiện tại:

1. Làm phase/task trên branch riêng từ `develop`.
2. Test bằng `npm run typecheck` và `npm run build`.
3. Merge phase hoàn thành vào `develop`.
4. Chỉ merge `develop` vào `main` khi app chạy ổn và phase đạt tiêu chí hoàn thành.

## Roadmap

- Phase 0-6: Đã hoàn thành nền app, storage, data model, Library/Manager, editor/reader và import.
- Phase 7: Manga management.
- Phase 8: Manga reader.
- Phase 9: Đã hoàn thành search, bookmark, highlight và note.
- Phase 10: Export PDF/EPUB.
- Phase 11: Backup, restore và migration.
- Phase 12: Build final và kiểm thử toàn bộ workflow.

## Tài liệu dự án

- `PLAN.md`: kiến trúc, quyết định kỹ thuật và roadmap.
- `PROGRESS.md`: checklist theo dõi tiến độ từng phase.
- `AGENTS.md`: quy tắc làm việc cho coding agent trong repo.

## Ghi chú

NovelWeb hiện là dự án cá nhân đang phát triển. README này phản ánh trạng thái sau Phase 6 và Phase 9; phần tiếp theo ưu tiên Manga management trước Manga reader, export, backup/restore và build final.
