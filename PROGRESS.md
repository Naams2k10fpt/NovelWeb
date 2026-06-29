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

**Trạng thái:** `[~]`

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
- [ ] Implement path safety để mọi thao tác nằm trong library root.
- [ ] Cho phép đọc source import ngoài Library chỉ khi path đến từ Electron dialog/import session hợp lệ.
- [ ] Chuẩn hóa response IPC dạng `{ ok, data, error }`.
- [ ] Chuẩn hóa error code cơ bản.
- [ ] Implement library health check cơ bản.
- [ ] Implement rebuild `series-index.json`.
- [ ] Tạo skeleton rebuild `search-index.json`.
- [ ] Tạo `migrationService` skeleton.
- [ ] Kiểm tra `schemaVersion` khi mở Library.
- [ ] Implement per-resource write lock hoặc save queue nền tảng.

Ghi chú: Đã có Settings tab cơ bản để xem/đổi Library folder; các setting khác thêm khi có task tương ứng.

### Tiêu chí hoàn thành

- [ ] App có thể tạo và ghi vào Library folder.
- [ ] App không ghi dữ liệu chính vào thư mục cài app.
- [ ] Ghi file lỗi không làm mất file cũ.
- [ ] Main process từ chối path nằm ngoài library root.
- [ ] Library bị lệch index có thể repair/rebuild cơ bản.

---

## Phase 3 - Data model core

**Trạng thái:** `[ ]`

**Mục tiêu:** Tạo mô hình dữ liệu cốt lõi cho series, category, volume và chapter LN/WN trong MVP đầu.

### Checklist

- [ ] Định nghĩa schema Series metadata.
- [ ] Định nghĩa schema Category metadata.
- [ ] Định nghĩa schema Volume metadata.
- [ ] Định nghĩa schema Chapter metadata cho LN/WN.
- [ ] Ghi chú schema Chapter metadata cho Manga để chuẩn bị phase sau.
- [ ] Thêm `schemaVersion` vào mọi metadata.
- [ ] CRUD Series.
- [ ] CRUD Category: `light-novel`, `web-novel`, `manga`.
- [ ] CRUD Volume cho LN/WN.
- [ ] CRUD Chapter cho LN/WN.
- [ ] Hoãn CRUD Chapter Manga sang Phase 7.
- [ ] Tạo `series-index.json` để load nhanh danh sách series.
- [ ] Update index khi tạo/sửa/xóa series.
- [ ] Validate input IPC bằng schema.
- [ ] Thêm `deletedAt` hoặc move-to-trash tối thiểu cho xóa mềm.
- [ ] Đảm bảo index cập nhật đồng bộ khi create/update/delete.
- [ ] Có command repair index từ metadata thật.

### Tiêu chí hoàn thành

- [ ] Có thể tạo thư viện truyện thủ công.
- [ ] Đóng app mở lại không mất metadata.
- [ ] Series có thể chứa nhiều category.
- [ ] LN/WN hỗ trợ volume/chapter.
- [ ] Manga có hướng schema rõ ràng nhưng chưa cần CRUD/UI đầy đủ ở MVP đầu.
- [ ] Xóa mềm không làm mất dữ liệu vĩnh viễn.

---

## Phase 4 - Giao diện Library và Manager cơ bản

**Trạng thái:** `[ ]`

**Mục tiêu:** Tạo giao diện quản lý và duyệt thư viện ở mức dùng được.

### Checklist

- [ ] Tạo trang Library.
- [ ] Hiển thị series card.
- [ ] Hiển thị cover, title, author, status.
- [ ] Thêm filter/search nhẹ ở Library.
- [ ] Tạo trang Series Detail.
- [ ] Series Detail có tab theo category.
- [ ] Tab LN/WN hiển thị volume và chapter.
- [ ] Tab Manga có placeholder hoặc trạng thái `Sẽ làm sau`.
- [ ] Tạo trang Manager.
- [ ] Manager có split layout trái/phải.
- [ ] Tree view hiển thị series/category/volume/chapter.
- [ ] Context menu cơ bản: thêm, sửa tên, xóa mềm bằng `.trash` tối thiểu.
- [ ] Hiển thị trạng thái loading.
- [ ] Hiển thị trạng thái empty.
- [ ] Hiển thị trạng thái error.

### Tiêu chí hoàn thành

- [ ] User có thể xem thư viện ở Library.
- [ ] User có thể quản lý cấu trúc truyện ở Manager.
- [ ] UI không bị rối giữa chế độ đọc và chế độ quản lý.

---

## Phase 5 - Novel editor và reader

**Trạng thái:** `[ ]`

**Mục tiêu:** Cho phép viết, chỉnh sửa và đọc nội dung LN/WN.

### Checklist

- [ ] Tích hợp TipTap editor.
- [ ] Tạo toolbar format cơ bản: bold, italic, heading, quote, list.
- [ ] Lưu nội dung chapter vào `content.html`.
- [ ] Sinh và lưu `content.txt` để phục vụ search.
- [ ] Autosave debounce sau khi chỉnh sửa.
- [ ] Ctrl+S để save ngay.
- [ ] Chống race condition giữa autosave và Ctrl+S.
- [ ] Không cho 2 thao tác save cùng chapter chạy song song.
- [ ] Không cho save cũ ghi đè save mới.
- [ ] Cảnh báo khi rời chapter còn nội dung chưa lưu.
- [ ] Hiển thị trạng thái `Đang lưu`.
- [ ] Hiển thị trạng thái `Đã lưu`.
- [ ] Hiển thị trạng thái `Lỗi lưu`.
- [ ] Cho phép insert ảnh inline.
- [ ] Copy ảnh inline vào thư mục chapter assets.
- [ ] Sanitize HTML trước khi lưu hoặc render.
- [ ] Tạo NovelReader đọc từ `content.html`.
- [ ] Tùy chỉnh font size.
- [ ] Tùy chỉnh reading width.
- [ ] Tùy chỉnh theme đọc.
- [ ] Lưu tiến độ đọc theo scroll position.

### Tiêu chí hoàn thành

- [ ] User có thể tạo chapter LN/WN và viết nội dung.
- [ ] Nội dung lưu được, mở lại đúng.
- [ ] Reader hiển thị nội dung dễ đọc.
- [ ] Autosave không làm mất dữ liệu khi thao tác bình thường.

---

## Phase 6 - Import nội dung text và PDF

**Trạng thái:** `[ ]`

**Mục tiêu:** Đưa dữ liệu thật từ folder và file ngoài vào NovelWeb.

### Checklist

- [ ] Tạo Import Wizard.
- [ ] Chọn folder bằng Electron dialog.
- [ ] Scan folder và trả về preview tree.
- [ ] Detect volume folder.
- [ ] Detect chapter file TXT.
- [ ] Detect chapter file MD.
- [ ] Detect chapter file DOCX.
- [ ] Detect chapter file PDF.
- [ ] Cho rename item trước khi import.
- [ ] Cho bỏ chọn item không muốn import.
- [ ] Import TXT.
- [ ] Import MD.
- [ ] Import DOCX bằng mammoth.
- [ ] Import PDF bằng parser.
- [ ] Nếu `pdf-parse` lỗi, thử fallback extractor.
- [ ] Nếu PDF không có text, đánh dấu là scanned/unsupported.
- [ ] Import source path phải đến từ dialog hoặc import session hợp lệ.
- [ ] Lưu PDF gốc vào library.
- [ ] Tạo PDF Split View.
- [ ] PDF Split View hiển thị PDF gốc bên trái.
- [ ] PDF Split View hiển thị text trích xuất/editor bên phải.
- [ ] Cho sửa text trước khi import chính thức.
- [ ] Hiển thị progress bar khi import.
- [ ] Ghi import log.
- [ ] Hiển thị report sau import.

### Tiêu chí hoàn thành

- [ ] User có thể import folder truyện thật.
- [ ] Import không ghi dữ liệu khi user chưa confirm.
- [ ] PDF gốc luôn có thể mở lại để đối chiếu.
- [ ] Import lỗi có log đủ rõ để biết file nào hỏng.

---

## Phase 7 - Manga management

**Trạng thái:** `[ ]`

**Mục tiêu:** Quản lý manga theo chapter và page một cách nhẹ, không làm app lag.

### Checklist

- [ ] Tạo manga category.
- [ ] Tạo manga chapter.
- [ ] Add pages từ file picker.
- [ ] Add pages bằng drag & drop.
- [ ] Remove page.
- [ ] Remove nhiều page.
- [ ] Reorder pages.
- [ ] Lưu `pageOrder`.
- [ ] Lưu `pageCount`.
- [ ] Lưu `totalSizeBytes`.
- [ ] Tạo thumbnail cache.
- [ ] PageManager dùng thumbnail trong grid.
- [ ] PageManager không load full-size toàn bộ ảnh cùng lúc.
- [ ] Click thumbnail để preview ảnh lớn.
- [ ] Confirm trước khi xóa page.

### Tiêu chí hoàn thành

- [ ] User có thể tạo manga chapter và thêm trang.
- [ ] User có thể sắp xếp lại thứ tự trang.
- [ ] PageManager vẫn mượt với chapter nhiều ảnh.
- [ ] Metadata page luôn khớp với file thực tế.

---

## Phase 8 - Manga reader

**Trạng thái:** `[ ]`

**Mục tiêu:** Đọc manga thoải mái với nhiều chế độ đọc.

### Checklist

- [ ] Tạo MangaReader.
- [ ] Long strip mode.
- [ ] Page mode.
- [ ] Chuyển hướng đọc RTL/LTR.
- [ ] Fit width.
- [ ] Fit height.
- [ ] Zoom.
- [ ] Keyboard navigation.
- [ ] Chuyển chapter trước/sau.
- [ ] Hiển thị progress theo trang.
- [ ] Lưu trang đang đọc.
- [ ] Khôi phục trang đang đọc khi mở lại.
- [ ] Lazy load ảnh khi đọc long strip.

### Tiêu chí hoàn thành

- [ ] User đọc được manga bằng cuộn dọc.
- [ ] User đọc được manga bằng lật trang.
- [ ] Hướng đọc RTL/LTR hoạt động đúng.
- [ ] Reader không load toàn bộ ảnh nặng cùng lúc.

---

## Phase 9 - Search, bookmark, highlight, note

**Trạng thái:** `[ ]`

**Mục tiêu:** Biến app thành thư viện đọc và ghi chú cá nhân hoàn chỉnh hơn.

### Checklist

- [ ] Search từ `content.txt`.
- [ ] Tạo `search-index.json`.
- [ ] Update search index khi chapter thay đổi.
- [ ] Search result hiển thị series/volume/chapter.
- [ ] Search result highlight keyword.
- [ ] Click result để mở đúng chapter.
- [ ] Bookmark chapter.
- [ ] Bookmark vị trí đọc.
- [ ] Highlight đoạn text.
- [ ] Chọn màu highlight.
- [ ] Note trên highlight.
- [ ] Quản lý danh sách highlight/note.
- [ ] Recent reading.

### Tiêu chí hoàn thành

- [ ] Search không cần quét toàn bộ file mỗi lần với thư viện vừa/lớn.
- [ ] User có thể quay lại truyện đọc gần đây.
- [ ] Highlight và note lưu được sau khi đóng app.

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
- [ ] Đối chiếu phase với `PLAN.md` sau mỗi lần cập nhật lớn.
- [ ] Không bỏ sót các nhóm lớn: PDF split view, manga reader, editor, export, backup.
- [ ] Mỗi phase nên được chia nhỏ tiếp nếu checklist bắt đầu quá lớn hoặc khó kiểm soát.
