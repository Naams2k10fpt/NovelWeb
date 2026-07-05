# NovelWeb Progress

File này dùng để theo dõi tiến độ phát triển NovelWeb theo từng phase nhỏ. Mục tiêu là làm chắc từng lớp nền trước khi chuyển sang phần phức tạp hơn.

## Quy ước trạng thái

- `[ ]` Chưa làm
- `[~]` Đang làm
- `[x]` Xong
- `[!]` Cần xem lại

## Nguyên tắc làm việc

- Làm theo thứ tự phase, ưu tiên nền tảng ổn định trước tính năng đẹp.
- Phase sau không nên bắt đầu khi phase nền phía trước còn lỗi nghiêm trọng.
- Mỗi phase cần có thể chạy thử và kiểm tra thủ công.
- Các tính năng liên quan dữ liệu cá nhân phải ưu tiên an toàn dữ liệu, backup và khả năng phục hồi.
- PDF import chỉ được xem là bản trích xuất ban đầu; người dùng luôn có quyền đối chiếu và chỉnh sửa bằng split view.

---

## Phase 0 - Chốt quyết định nền tảng

**Trạng thái:** `[x]`

**Mục tiêu:** Chốt các quyết định quan trọng trước khi viết code để tránh phải đổi kiến trúc giữa chừng.

### Checklist

- [x] Chấp nhận Electron app khi build có thể khoảng 150-200MB.
- [x] Chốt settings app lưu trong `app.getPath("userData")`.
- [x] Chốt thư viện truyện lưu ở folder riêng do user chọn.
- [x] Chốt MVP đầu tiên tập trung LN/WN trước, Manga làm sau khi nền novel ổn.
- [x] Chốt giai đoạn đầu dùng JSON + index thay vì SQLite.
- [x] Thêm `schemaVersion` vào metadata ngay từ đầu để hỗ trợ migration sau này.
- [x] Chốt PDF import là bản trích xuất nháp, không kỳ vọng giữ format hoàn hảo 100%.
- [x] Chốt PDF gốc được lưu lại để đối chiếu lâu dài.
- [x] Chốt OCR/scanned PDF chưa thuộc MVP.
- [x] Chốt các format import ban đầu: TXT, MD, DOCX, PDF.

### Tiêu chí hoàn thành

- [x] Các quyết định trên được phản ánh trong tài liệu kỹ thuật hoặc task triển khai.
- [x] Không còn câu hỏi lớn về nơi lưu dữ liệu, kiểu dữ liệu và phạm vi PDF import.

---

## Phase 1 - Khởi tạo app

**Trạng thái:** `[x]`

**Mục tiêu:** Tạo nền app Electron + Vite + React + TypeScript chạy được ở dev mode.

### Checklist

- [x] Scaffold project Electron + Vite + React + TypeScript.
- [x] Tạo `package.json` với scripts cần thiết.
- [x] Tạo Electron main process.
- [x] Tạo preload script.
- [x] Tạo React renderer entry.
- [x] Tạo config `electron.vite.config.ts`.
- [x] Bật `contextIsolation`.
- [x] Tắt `nodeIntegration`.
- [x] Tạo BrowserWindow cơ bản.
- [x] Tạo layout app cơ bản với sidebar.
- [x] Tạo 2 mode chính: Library và Manager.
- [x] App chạy được bằng `npm run dev`.

Ghi chú: Đã xác nhận `npm run dev` mở app và chuyển được giữa Library/Manager. `npm run build` cần chạy ngoài sandbox do esbuild bị chặn đọc config trong sandbox.

### Tiêu chí hoàn thành

- [x] Chạy `npm run dev` mở được app desktop.
- [x] Có sidebar chuyển được giữa Library và Manager.
- [x] Renderer không truy cập trực tiếp Node.js API.

---

## Phase 2 - Nền tảng lưu trữ an toàn

**Trạng thái:** `[x]`

**Mục tiêu:** Xây hệ thống lưu trữ local an toàn, rõ ràng và có thể mở rộng.

### Checklist

- [x] Tạo cơ chế chọn thư mục Library lần đầu mở app.
- [x] Tạo cơ chế đổi thư mục Library trong settings.
- [x] Tạo thư mục Library nếu chưa tồn tại.
- [x] Tách rõ app settings trong `userData` và library settings trong Library folder.
- [x] Tạo `library.json`.
- [x] Tạo `settings.json`.
- [x] Tạo thư mục `index/`.
- [x] Tạo thư mục `series/`.
- [x] Tạo thư mục `backups/`.
- [x] Tạo thư mục `.trash/` tối thiểu để phục vụ xóa mềm sớm.
- [x] Implement đọc JSON an toàn.
- [x] Implement ghi JSON an toàn bằng `.tmp` rồi rename.
- [x] Tạo backup gần nhất trước khi ghi đè file quan trọng.
- [x] Implement path safety để mọi thao tác nằm trong library root.
- [x] Cho phép đọc source import ngoài Library chỉ khi path đến từ Electron dialog/import session hợp lệ.
- [x] Chuẩn hóa response IPC dạng `{ ok, data, error }`.
- [x] Chuẩn hóa error code cơ bản.
- [x] Implement library health check cơ bản.
- [x] Implement rebuild `series-index.json`.
- [x] Tạo skeleton rebuild `search-index.json`.
- [x] Tạo `migrationService` skeleton.
- [x] Kiểm tra `schemaVersion` khi mở Library.
- [x] Implement per-resource write lock hoặc save queue nền tảng.

Ghi chú: Đã có Settings tab cơ bản để xem/đổi Library folder; các setting khác thêm khi có task tương ứng.
Ghi chú: Import source guard đã có ở API nền Phase 6: main process tạo import session từ Electron dialog và renderer chỉ scan bằng `importSessionId`.

### Tiêu chí hoàn thành

- [x] App có thể tạo và ghi vào Library folder.
- [x] App không ghi dữ liệu chính vào thư mục cài app.
- [x] Ghi file lỗi không làm mất file cũ.
- [x] Main process từ chối path nằm ngoài library root.
- [x] Library bị lệch index có thể repair/rebuild cơ bản.

---

## Phase 3 - Data model core

**Trạng thái:** `[x]`

**Mục tiêu:** Tạo mô hình dữ liệu cốt lõi cho series, category, volume và chapter LN/WN trong MVP đầu.

### Checklist

- [x] Định nghĩa schema Series metadata.
- [x] Định nghĩa schema Category metadata.
- [x] Định nghĩa schema Volume metadata.
- [x] Định nghĩa schema Chapter metadata cho LN/WN.
- [x] Ghi chú schema Chapter metadata cho Manga để chuẩn bị phase sau.
- [x] Thêm `schemaVersion` vào mọi metadata.
- [x] CRUD Series.
- [x] CRUD Category: `light-novel`, `web-novel`, `manga`.
- [x] CRUD Volume cho LN/WN.
- [x] CRUD Chapter cho LN/WN.
- [x] Hoãn CRUD Chapter Manga sang Phase 7.
- [x] Tạo `series-index.json` để load nhanh danh sách series.
- [x] Update index khi tạo/sửa/xóa series.
- [x] Validate input IPC bằng schema.
- [x] Thêm `deletedAt` hoặc move-to-trash tối thiểu cho xóa mềm.
- [x] Đảm bảo index cập nhật đồng bộ khi create/update/delete.
- [x] Có command repair index từ metadata thật.

Ghi chú: Đã test thủ công qua DevTools ngày 2026-06-30: tạo series/category/volume/chapter LN, list series, repair series index, move series vào `.trash`, và xác nhận list series rỗng sau xóa mềm.

### Tiêu chí hoàn thành

- [x] Có thể tạo thư viện truyện thủ công.
- [x] Đóng app mở lại không mất metadata.
- [x] Series có thể chứa nhiều category.
- [x] LN/WN hỗ trợ volume/chapter.
- [x] Manga có hướng schema rõ ràng nhưng chưa cần CRUD/UI đầy đủ ở MVP đầu.
- [x] Xóa mềm không làm mất dữ liệu vĩnh viễn.

---

## Phase 4 - Giao diện Library và Manager cơ bản

**Trạng thái:** `[x]`

**Mục tiêu:** Tạo giao diện quản lý và duyệt thư viện ở mức dùng được.

### Checklist

Ghi chú: Đã thay `window.prompt()` trong Manager bằng form nội bộ vì Electron không hỗ trợ prompt.
Ghi chú: 2026-07-05 đã tổ chức lại Manager: split pane kéo được, cây thư mục mặc định thu gọn, node có caret mở/đóng kiểu Explorer và chapter kéo thả được để sắp xếp trong cùng volume/category; reorder cập nhật local tree sau khi lưu, không reload toàn bộ thư viện.

- [x] Tạo trang Library.
- [x] Hiển thị series card.
- [x] Hiển thị cover, title, author, status.
- [x] Thêm filter/search nhẹ ở Library.
- [x] Tạo trang Series Detail.
- [x] Series Detail có tab theo category.
- [x] Tab LN/WN hiển thị volume và chapter.
- [x] Tab Manga có placeholder hoặc trạng thái `Sẽ làm sau`.
- [x] Tạo trang Manager.
- [x] Manager có split layout trái/phải.
- [x] Tree view hiển thị series/category/volume/chapter.
- [x] Context menu cơ bản: thêm, sửa tên, xóa mềm bằng `.trash` tối thiểu.
- [x] Hiển thị trạng thái loading.
- [x] Hiển thị trạng thái empty.
- [x] Hiển thị trạng thái error.

### Tiêu chí hoàn thành

- [x] User có thể xem thư viện ở Library.
- [x] User có thể quản lý cấu trúc truyện ở Manager.
- [x] UI không bị rối giữa chế độ đọc và chế độ quản lý.

---

## Phase 5 - Novel editor và reader

**Trạng thái:** `[x]`

**Mục tiêu:** Cho phép viết, chỉnh sửa và đọc nội dung LN/WN.

### Checklist

- [x] Tích hợp TipTap editor.
- [x] Tạo toolbar format cơ bản: bold, italic, heading, quote, list.
- [x] Lưu nội dung chapter vào `content.html`.
- [x] Sinh và lưu `content.txt` để phục vụ search.
- [x] Autosave debounce sau khi chỉnh sửa.
- [x] Ctrl+S để save ngay.
- [x] Chống race condition giữa autosave và Ctrl+S.
- [x] Không cho 2 thao tác save cùng chapter chạy song song.
- [x] Không cho save cũ ghi đè save mới.
- [x] Cảnh báo khi rời chapter còn nội dung chưa lưu.
- [x] Hiển thị trạng thái `Đang lưu`.
- [x] Hiển thị trạng thái `Đã lưu`.
- [x] Hiển thị trạng thái `Lỗi lưu`.
- [x] Cho phép insert ảnh inline.
- [x] Copy ảnh inline vào thư mục chapter assets.
- [x] Sanitize HTML trước khi lưu hoặc render.
- [x] Tạo NovelReader đọc từ `content.html`.
- [x] Tùy chỉnh font size.
- [x] Tùy chỉnh reading width.
- [x] Tùy chỉnh theme đọc.
- [x] Lưu tiến độ đọc theo scroll position.

Ghi chú: Đã thêm API nền `chapters.getContent`/`chapters.saveContent`; editor UI và autosave làm ở task sau.
Ghi chú: Đã thêm editor TipTap tối thiểu mở từ Series Detail, toolbar format cơ bản và nút Save thủ công; autosave/Ctrl+S làm ở task sau.
Ghi chú: Đã thêm autosave debounce, Ctrl+S, serialize save trong editor và cảnh báo khi rời chapter còn thay đổi chưa lưu.
Ghi chú: Đã thêm sanitize HTML tối thiểu, NovelReader đọc từ `content.html`, tùy chỉnh font/width/theme và lưu scroll progress vào `progress.json`.
Ghi chú: Đã thêm chọn ảnh inline từ editor, copy ảnh vào `chapter/assets`, lưu `content.html` với đường dẫn asset và hydrate ảnh khi mở editor/reader.
Ghi chú: Đã thêm ô title trong editor lưu thành H1 đầu nội dung, truyền tên truyện vào reader và tinh chỉnh header đọc/edit.
Ghi chú: Đã chỉnh reader chỉ hiện tên truyện căn giữa, giữ sidebar cố định khi cuộn và cho H2 áp dụng cả block đang chọn.
Ghi chú: Đã đảo cấp chữ giữa tên truyện và title, đồng thời căn giữa title trong editor/reader.
Ghi chú: 2026-07-05 đã mở rộng NovelEditor thành toolbar gần Word hơn: ribbon nhóm công cụ, font family/size, màu chữ, highlight, underline/strike/code, list số, căn lề theo vùng chọn, link, undo/redo, rule, clear format và giữ render tương ứng trong reader.
Ghi chú: 2026-07-05 đã sửa align trong NovelEditor: toolbar không làm mất selection khi bấm nút, và khi đang bôi đen text thì căn lề áp vào đúng đoạn chọn thay vì cả paragraph/chapter.

### Tiêu chí hoàn thành

- [x] User có thể tạo chapter LN/WN và viết nội dung.
- [x] Nội dung lưu được, mở lại đúng.
- [x] Reader hiển thị nội dung dễ đọc.
- [x] Autosave không làm mất dữ liệu khi thao tác bình thường.

---

## Phase 6 - Import nội dung text và PDF

**Trạng thái:** `[x]`

**Mục tiêu:** Đưa dữ liệu thật từ folder và file ngoài vào NovelWeb.

### Checklist

- [x] Tạo Import Wizard.
- [x] Chọn folder bằng Electron dialog.
- [x] Scan folder và trả về preview tree.
- [x] Detect volume folder.
- [x] Detect chapter file TXT.
- [x] Detect chapter file MD.
- [x] Detect chapter file DOCX.
- [x] Detect chapter file PDF.
- [x] Cho rename item trước khi import.
- [x] Cho bỏ chọn item không muốn import.
- [x] Import TXT.
- [x] Import MD.
- [x] Import DOCX bằng mammoth.
- [x] Import PDF bằng parser.
- [x] Nếu `pdf-parse` lỗi, thử fallback extractor.
- [x] Nếu PDF không có text, đánh dấu là scanned/unsupported.
- [x] Import source path phải đến từ dialog hoặc import session hợp lệ.
- [x] Lưu PDF gốc vào library.
- [x] Tạo PDF Split View.
- [x] PDF Split View hiển thị PDF gốc bên trái.
- [x] PDF Split View hiển thị text trích xuất/editor bên phải.
- [x] Cho sửa text trước khi import chính thức.
- [x] Hiển thị progress bar khi import.
- [x] Ghi import log.
- [x] Hiển thị report sau import.

Ghi chú: Đã thêm API nền `import.chooseSourceFolder`/`import.scan`; main process giữ import session từ Electron dialog và chỉ scan source qua `importSessionId`.
Ghi chú: Đã thêm Import Wizard 3 bước ở renderer: chọn source, preview/rename/bỏ chọn, confirm plan; chưa ghi dữ liệu import.
Ghi chú: Đã thêm import TXT/MD tối thiểu: bước confirm đọc text qua import session, cho sửa bằng textarea, tạo series LN mới, lưu `content.html`/`content.txt`, hiển thị progress và report/log. DOCX/PDF vẫn được scan nhưng sẽ bị skip ở nhóm này.
Ghi chú: Đã thêm import PDF tối thiểu không parser: tạo chapter, copy file gốc vào `original.pdf`, đặt `hasOriginalPdf`, ghi report trạng thái `unsupported` để biết text extraction/split view sẽ làm sau.
Ghi chú: Đã thêm dependency Phase 6 theo `PLAN.md`: `mammoth`, `pdf-parse`, `pdfjs-dist`; Import Wizard đọc preview text cho DOCX/PDF, cho sửa trước import, PDF parser dùng `pdf-parse` và fallback `pdfjs-dist`.
Ghi chú: Đã thêm PDF Split View trong NovelEditor: main process đọc `original.pdf` qua API hẹp, renderer hiển thị PDF gốc bên trái bằng iframe và editor text bên phải.
Ghi chú: Đã polish PDF Split View tối thiểu: ẩn menu bar Electron mặc định, tắt spellcheck trong editor, giảm chrome PDF viewer và cho hai pane dùng chiều cao viewport/cuộn độc lập.
Ghi chú: 2026-07-05 đã giảm xuống dòng đột ngột khi import text/PDF: converter nối soft line wrap thành khoảng trắng và chỉ tách paragraph theo dòng trống hoặc dấu kết câu.

### Tiêu chí hoàn thành

- [x] User có thể import folder truyện thật bằng TXT/MD/DOCX/PDF.
- [x] Import không ghi dữ liệu khi user chưa confirm.
- [x] PDF gốc luôn có thể mở lại để đối chiếu.
- [x] Import lỗi có log đủ rõ để biết file nào hỏng trong luồng import.

---

## Phase 7 - Manga management

**Trạng thái:** `[x]`

**Mục tiêu:** Quản lý manga theo chapter và page một cách nhẹ, không làm app lag.

### Checklist

- [x] Tạo manga category.
- [x] Tạo manga chapter.
- [x] Add pages từ file picker.
- [x] Add pages bằng drag & drop.
- [x] Remove page.
- [x] Remove nhiều page.
- [x] Reorder pages.
- [x] Lưu `pageOrder`.
- [x] Lưu `pageCount`.
- [x] Lưu `totalSizeBytes`.
- [x] Tạo thumbnail cache.
- [x] PageManager dùng thumbnail trong grid.
- [x] PageManager không load full-size toàn bộ ảnh cùng lúc.
- [x] Click thumbnail để preview ảnh lớn.
- [x] Confirm trước khi xóa page.

Ghi chú: Đã thêm PageManager tối thiểu trong Manager; manga pages lưu ở `chapters/{chapterId}/pages`, thumbnail cache ở `thumbnails`. Drag/drop dùng `webUtils.getPathForFile` trong preload rồi main process copy file, renderer không đọc filesystem bằng Node API.

### Tiêu chí hoàn thành

- [x] User có thể tạo manga chapter và thêm trang.
- [x] User có thể sắp xếp lại thứ tự trang.
- [x] PageManager vẫn mượt với chapter nhiều ảnh.
- [x] Metadata page luôn khớp với file thực tế.

---

## Phase 8 - Manga reader

**Trạng thái:** `[x]`

**Mục tiêu:** Đọc manga thoải mái với nhiều chế độ đọc.

### Checklist

- [x] Tạo MangaReader.
- [x] Long strip mode.
- [x] Page mode.
- [x] Chuyển hướng đọc RTL/LTR.
- [x] Fit width.
- [x] Fit height.
- [x] Zoom.
- [x] Keyboard navigation.
- [x] Chuyển chapter trước/sau.
- [x] Hiển thị progress theo trang.
- [x] Lưu trang đang đọc.
- [x] Khôi phục trang đang đọc khi mở lại.
- [x] Lazy load ảnh khi đọc long strip.

Ghi chú: Đã thêm MangaReader mở từ Series Detail, hỗ trợ long strip/page mode, RTL/LTR, fit width/height, zoom, phím điều hướng, chuyển chapter, progress theo `pageIndex` trong `progress.json`, và lazy load ảnh full-size bằng IntersectionObserver.

### Tiêu chí hoàn thành

- [x] User đọc được manga bằng cuộn dọc.
- [x] User đọc được manga bằng lật trang.
- [x] Hướng đọc RTL/LTR hoạt động đúng.
- [x] Reader không load toàn bộ ảnh nặng cùng lúc.

---

## Phase 9 - Search, bookmark, highlight, note

**Trạng thái:** `[x]`

**Mục tiêu:** Biến app thành thư viện đọc và ghi chú cá nhân hoàn chỉnh hơn.

### Nhóm triển khai

- Nhóm 1 - Search MVP: index từ `content.txt`, cập nhật khi chapter đổi, UI kết quả, highlight keyword, mở đúng chapter.
- Nhóm 2 - Recent/bookmark: recent reading, bookmark chapter, bookmark vị trí đọc.
- Nhóm 3 - Highlight/note: highlight đoạn text, chọn màu, note trên highlight, quản lý danh sách.

### Checklist

- [x] Search từ `content.txt`.
- [x] Tạo `search-index.json`.
- [x] Update search index khi chapter thay đổi.
- [x] Search result hiển thị series/volume/chapter.
- [x] Search result highlight keyword.
- [x] Click result để mở đúng chapter.
- [x] Bookmark chapter.
- [x] Bookmark vị trí đọc.
- [x] Highlight đoạn text.
- [x] Chọn màu highlight.
- [x] Note trên highlight.
- [x] Quản lý danh sách highlight/note.
- [x] Recent reading.

Ghi chú: Đã thêm nhóm 2 tối thiểu: Reader có nút bookmark tại vị trí cuộn hiện tại; Library hiển thị Recent và Bookmarks để mở lại đúng chapter/vị trí.
Ghi chú: Đã thêm nhóm 3 tối thiểu: Reader lưu đoạn text đang chọn kèm màu/note/vị trí vào `highlights.json`; Reader và Library hiển thị danh sách highlight/note, mở lại đúng chapter/vị trí và cho xóa.

### Tiêu chí hoàn thành

- [x] Search không cần quét toàn bộ file mỗi lần với thư viện vừa/lớn.
- [x] User có thể quay lại truyện đọc gần đây.
- [x] Highlight và note lưu được sau khi đóng app.

---

## Phase 10 - Export

**Trạng thái:** `[ ]`

**Mục tiêu:** Xuất nội dung thành file đọc/chia sẻ cá nhân.

### Checklist

- [ ] Export chapter ra PDF.
- [ ] Export volume ra PDF.
- [ ] Export series ra PDF.
- [ ] Export chapter ra EPUB.
- [ ] Export volume ra EPUB.
- [ ] Export series ra EPUB.
- [ ] Có cover trong export.
- [ ] Có metadata trong export.
- [ ] Có mục lục.
- [ ] Giữ heading.
- [ ] Giữ ảnh inline.
- [ ] Có page break giữa chương.
- [ ] Test font tiếng Việt.
- [ ] Test ảnh inline.
- [ ] Test heading.
- [ ] Test page break.

### Tiêu chí hoàn thành

- [ ] File PDF mở được và đọc ổn.
- [ ] File EPUB mở được bằng reader phổ biến.
- [ ] Nội dung tiếng Việt không lỗi font.
- [ ] Ảnh và mục lục xuất đúng.

---

## Phase 11 - Backup, restore, migration

**Trạng thái:** `[ ]`

**Mục tiêu:** Đảm bảo dữ liệu cá nhân có thể dùng lâu dài, không dễ mất khi app lỗi hoặc update.

### Checklist

- [ ] Metadata backup: meta, index, settings, progress, bookmarks, highlights.
- [ ] Content backup: `content.html`, `content.txt`.
- [ ] Full backup thủ công toàn bộ library gồm PDF và ảnh.
- [ ] Backup tự động theo lịch hoặc theo sự kiện quan trọng, ưu tiên metadata/content backup nhẹ.
- [ ] Restore library từ backup.
- [ ] Backup trước khi migration.
- [ ] Migration theo `schemaVersion`.
- [ ] Tạo thư mục `.trash/` nội bộ.
- [ ] Xóa series chuyển vào trash.
- [ ] Xóa chapter chuyển vào trash.
- [ ] Xóa manga page chuyển vào trash.
- [ ] Restore item từ trash.
- [ ] Xóa vĩnh viễn từ trash khi user confirm.
- [ ] Version history đơn giản cho chapter.

### Tiêu chí hoàn thành

- [ ] User có thể backup và restore dữ liệu.
- [ ] Update schema không làm hỏng thư viện cũ.
- [ ] Xóa nhầm có thể khôi phục.

---

## Phase 12 - Build và kiểm thử cuối

**Trạng thái:** `[ ]`

**Mục tiêu:** Đóng gói app và kiểm thử toàn bộ luồng sử dụng chính.

### Checklist

- [ ] Cấu hình `electron-builder`.
- [ ] Chuẩn bị icon app `.ico`.
- [ ] Build Windows `.exe`.
- [ ] Tạo shortcut desktop.
- [ ] Test mở app bằng shortcut.
- [ ] Test chọn/tạo Library folder.
- [ ] Test CRUD series/category/volume/chapter.
- [ ] Test editor và autosave.
- [ ] Test NovelReader.
- [ ] Test import TXT/MD/DOCX.
- [ ] Test import PDF với split view.
- [ ] Test manga page manager.
- [ ] Test MangaReader.
- [ ] Test search.
- [ ] Test export PDF.
- [ ] Test export EPUB.
- [ ] Test backup/restore.
- [ ] Test update app không làm mất Library folder.
- [ ] Test app mở lại được Library đã tạo từ phiên bản cũ.
- [ ] Test repair/rebuild index.
- [ ] Ghi checklist bug còn lại.
- [ ] Chốt bản ổn định đầu tiên.

### Tiêu chí hoàn thành

- [ ] App cài được trên Windows.
- [ ] App mở được như desktop app bình thường.
- [ ] Các workflow chính chạy được với dữ liệu thật.
- [ ] Không có lỗi mất dữ liệu trong các luồng kiểm thử chính.

---

## Backlog bổ sung

Các mục này không bắt buộc cho bản đầu, nhưng nên cân nhắc sau khi core ổn định.

- [ ] Duplicate detection khi import bằng hash file.
- [ ] Statistics: tổng số series, chapter, word, manga pages, dung lượng library.
- [ ] Tag tự do cho series/chapter.
- [ ] Collection: Đang đọc, Yêu thích, Cần chỉnh sửa, Đã hoàn thành.
- [ ] Import history chi tiết.
- [ ] Preview trước khi export.
- [ ] Tùy chọn nén ảnh manga hoặc giữ nguyên ảnh gốc.

---

## Ghi chú kiểm thử định kỳ

- [ ] Kiểm tra `PROGRESS.md` hiển thị tiếng Việt đúng UTF-8.
- [x] Đối chiếu phase với `PLAN.md` sau mỗi lần cập nhật lớn.
- [ ] Không bỏ sót các nhóm lớn: PDF split view, manga reader, editor, export, backup.
- [ ] Mỗi phase nên được chia nhỏ tiếp nếu checklist bắt đầu quá lớn hoặc khó kiểm soát.

Ghi chú: 2026-07-04 đã đồng bộ `README.md` với trạng thái trong `PROGRESS.md` sau Phase 6 và Phase 9.
