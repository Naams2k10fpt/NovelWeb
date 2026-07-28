# NovelWeb QA fix backlog

Nguồn: [`qa-artifacts/NovelWeb-QA-Report-2026-07-28.md`](qa-artifacts/NovelWeb-QA-Report-2026-07-28.md)

## Release blockers

- [x] **BUG-001 / P1 — Không tự tạo lại Library đã mất đường dẫn**
  - Startup phải báo Library không khả dụng và giữ dữ liệu cũ nguyên vẹn.
  - Chỉ luồng chọn thư mục có chủ đích mới được khởi tạo Library mới.
  - Có regression test xác nhận path bị mất không được `mkdir`.

## Closed-beta fixes

- [x] **BUG-002 / P2 — Đồng bộ phiên bản PDF API/worker trong packaged build**
  - PDF hợp lệ không còn cảnh báo version mismatch.
  - PDF hỏng báo lỗi PDF thật.
  - Có packaged smoke test.
- [x] **BUG-003 / P2 — Giữ rich text và ảnh khi import DOCX**
  - Heading/bold/italic/list và ảnh embedded còn trong chapter HTML.
  - HTML vẫn đi qua sanitizer hiện có.
- [x] **BUG-004 / P2 — Khôi phục progress sau Next → Previous**
  - Chờ ảnh/layout trước khi restore scroll.
  - Direct-open và adjacent navigation đều giữ vị trí.
- [x] **UX-001 / P2 — Persist font/width/theme của reader**
  - Giữ tùy chỉnh qua Edit → Read và restart.
- [x] **UX-002 / P2 — Làm rõ Create series và Import series**
  - Empty Library có đường vào Manager.
  - Không dùng “Add series” cho hành động import.
- [x] **A11Y-001 / P2 — Chapter list có dialog semantics, focus và Escape**
- [x] **A11Y-002 / P2 — Focus indicator đạt contrast tối thiểu 3:1**

## Follow-up fixes

- [x] **UX-003 / P3 — Search không dấu và filters**
- [x] **UI-001 / P3 — Tooltip cho title bị ellipsis**
- [x] **UX-004 / P3 — Phân biệt Library title và content heading**
- [x] **INST-002 / P3 — Làm rõ chính sách giữ AppData khi uninstall**

## Manual-smoke follow-up

- [x] **UI-002 — Tên chapter rất dài không kéo vỡ layout Import**
- [x] **PERF-001 — Giảm payload và lag khi mở/đóng chapter rất lớn**
- [x] **UX-005 — Căn giữa editor và giữ toolbar sticky khi cuộn**
- [x] **BUG-005 — Back từ editor không truyền UI event thành `seriesId`**
- [x] **UI-003 — Dark reader phủ loading, settings và side toolbar**

## External/research

- [ ] **INST-001 / P2 — Ký số installer** — cần chứng thư và quy trình release, không thể hoàn tất chỉ bằng code.
- [ ] **A11Y-003 / P2 — Tagged PDF** — cần đánh giá pipeline PDF khác; cảnh báo dùng EPUB cho screen reader đã được bổ sung.

## Verification gate

- [x] `npm test` — 87/87.
- [x] `npm run build`
- [x] `npm run test:pdf`
- [x] `npm run package:dir`
- [x] `npm run test:packaged-pdf` — API/worker 6.1.200 và parse text thành công.
- [x] Packaged startup smoke: missing Library không bị tạo lại.
- [ ] Manual packaged UI smoke: DOCX import, reader state, keyboard chapter list và 5 follow-up ở trên (backend Browser hiện không attach được cửa sổ Electron).
