import { access, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createFullLibraryBackup,
  createLibraryBackup,
  activateLibraryPath,
  ensureLibraryFiles,
  migrateLibrary,
  repairSeriesIndex,
  restoreFullLibraryBackup
} from "../electron/services/library";
import {
  createSeriesMetadata,
  readSeriesMetadata,
  listSeriesCards,
  updateSeriesMetadata,
  readSeriesCoverDataUrl,
  moveSeriesToTrash
} from "../electron/services/series";
import {
  createCategoryMetadata,
  readCategoryMetadata,
  listCategoryMetadata,
  updateCategoryMetadata,
  moveCategoryToTrash
} from "../electron/services/category";
import {
  createVolumeMetadata,
  readVolumeMetadata,
  listVolumeMetadata,
  updateVolumeMetadata,
  moveVolumeToTrash
} from "../electron/services/volume";
import {
  createChapterMetadata,
  readChapterMetadata,
  listChapterMetadata,
  updateChapterMetadata,
  saveContent,
  getContent,
  listChapterVersions,
  restoreChapterVersion,
  moveToTrash as moveChapterToTrash
} from "../electron/services/chapter";
import {
  rebuildSearchIndex,
  searchLibrary
} from "../electron/services/search";
import {
  readChapterReadingProgress,
  saveChapterReadingProgress,
  toggleChapterBookmark,
  createHighlight,
  listBookmarks,
  listHighlights,
  listRecentEntries
} from "../electron/services/readingState";
import { deleteTrashItem, listTrashEntries, restoreTrashItem } from "../electron/services/trash";
import { currentLibraryPathOrThrow } from "../electron/services/base";
import JSZip from "jszip";
import {
  buildChapterPdfHtml,
  buildChapterEpub,
  buildSeriesEpub,
  buildSeriesPdfHtml,
  buildVolumeEpub,
  buildVolumePdfHtml,
  safeExportFileName
} from "../electron/services/export";
import {
  executeImport,
  importFileId,
  importSessions,
  scanImportSession
} from "../electron/services/import";

const TEST_LIB_DIR = join(process.cwd(), "temp-test-library");
const RESTORED_TEST_LIB_DIR = join(process.cwd(), "temp-test-restored-library");
const SELECTED_TEST_LIB_DIR = join(process.cwd(), "temp-test-selected-library");
const TEST_APP_DATA_DIR = join(process.cwd(), "temp-test-app-data");
const TEST_IMPORT_DIR = join(process.cwd(), "temp-test-import");

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  \x1b[32m[PASS]\x1b[0m ${message}`);
  } else {
    console.error(`  \x1b[31m[FAIL]\x1b[0m ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeTestDocx(filePath: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX import content.</w:t></w:r></w:p></w:body></w:document>'
  );
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writeTestPdf(filePath: string): Promise<void> {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 52 >>\nstream\nBT /F1 18 Tf 72 720 Td (PDF import content.) Tj ET\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  await writeFile(filePath, pdf, "ascii");
}

async function cleanUp() {
  try {
    await rm(TEST_LIB_DIR, { recursive: true, force: true });
    await rm(RESTORED_TEST_LIB_DIR, { recursive: true, force: true });
    await rm(SELECTED_TEST_LIB_DIR, { recursive: true, force: true });
    await rm(TEST_APP_DATA_DIR, { recursive: true, force: true });
    await rm(TEST_IMPORT_DIR, { recursive: true, force: true });
  } catch (err) {}
}

async function runTests() {
  console.log("\x1b[36m=== NovelWeb Integration Test Suite ===\x1b[0m\n");

  await cleanUp();
  await mkdir(TEST_LIB_DIR, { recursive: true });

  try {
    // ----------------------------------------------------
    console.log("\x1b[35m1. Testing Library Selection, Initialization & Health\x1b[0m");
    await activateLibraryPath(SELECTED_TEST_LIB_DIR);
    assert(
      (await currentLibraryPathOrThrow()) === SELECTED_TEST_LIB_DIR,
      "Selected Library path persists in app settings."
    );
    assert(
      await fileExists(join(SELECTED_TEST_LIB_DIR, "library.json")),
      "Selecting a new folder initializes its Library files."
    );
    await ensureLibraryFiles(TEST_LIB_DIR);
    assert(true, "Library files initialized successfully.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m2. Testing Series CRUD\x1b[0m");
    const newSeries = await createSeriesMetadata(TEST_LIB_DIR, {
      title: "Test Novel Series",
      originalTitle: "Original Test Title",
      originalAuthor: "Test Author",
      status: "translating",
      language: "vi",
      description: "This is a test description."
    });
    assert(newSeries.title === "Test Novel Series", "Series created with correct title.");
    assert(newSeries.status === "translating", "Series created with correct status.");

    const seriesList = await listSeriesCards(TEST_LIB_DIR);
    assert(seriesList.length === 1, "Series index contains exactly 1 series.");
    assert(seriesList[0].title === "Test Novel Series", "Series card lists correct title.");

    const loadedSeries = await readSeriesMetadata(TEST_LIB_DIR, newSeries.id);
    assert(loadedSeries.originalAuthor === "Test Author", "Loaded series metadata matches.");

    const updatedSeries = await updateSeriesMetadata(TEST_LIB_DIR, newSeries.id, {
      title: "Updated Novel Title",
      originalAuthor: "Updated Author"
    });
    assert(updatedSeries.title === "Updated Novel Title", "Series title updated successfully.");
    assert(updatedSeries.originalAuthor === "Updated Author", "Series author updated successfully.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m3. Testing Category CRUD\x1b[0m");
    const category = await createCategoryMetadata(TEST_LIB_DIR, newSeries.id, {
      title: "Web Novel Category",
      type: "web-novel"
    });
    assert(category.title === "Web Novel Category", "Category created successfully.");
    assert(category.type === "web-novel", "Category type matches.");

    const categories = await listCategoryMetadata(TEST_LIB_DIR, newSeries.id);
    assert(categories.length === 1, "Category list contains exactly 1 category.");

    const updatedCategory = await updateCategoryMetadata(TEST_LIB_DIR, newSeries.id, category.id, {
      title: "Updated Category Title"
    });
    assert(updatedCategory.title === "Updated Category Title", "Category title updated successfully.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m4. Testing Volume CRUD\x1b[0m");
    // Change category type to light-novel for volume testing
    const lnCategory = await createCategoryMetadata(TEST_LIB_DIR, newSeries.id, {
      title: "Light Novel Category",
      type: "light-novel"
    });
    const volume = await createVolumeMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id, {
      title: "Volume 1: The Beginning"
    });
    assert(volume.title === "Volume 1: The Beginning", "Volume created successfully.");

    const volumes = await listVolumeMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id);
    assert(volumes.length === 1, "Volume list contains exactly 1 volume.");

    const updatedVolume = await updateVolumeMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id, {
      title: "Volume 1: Updated Title"
    });
    assert(updatedVolume.title === "Volume 1: Updated Title", "Volume title updated successfully.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m5. Testing Chapter CRUD & Content\x1b[0m");
    // Web novel chapter (directly under category)
    const chapter1 = await createChapterMetadata(TEST_LIB_DIR, newSeries.id, category.id, null, {
      title: "Chapter 1: The Awakening",
      order: 1
    });
    assert(chapter1.title === "Chapter 1: The Awakening", "Web Novel Chapter created successfully.");

    const chapters = await listChapterMetadata(TEST_LIB_DIR, newSeries.id, category.id, null);
    assert(chapters.length === 1, "Chapter list contains exactly 1 chapter.");

    // Editor Save & Load html content
    const testHtml = "<p>This is <strong>bold</strong> test content of chapter 1.</p>";
    await saveContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
      html: testHtml
    });
    assert(true, "Chapter content saved without errors.");

    const loadedContent = await getContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id);
    assert(loadedContent.html === testHtml, "Loaded HTML content matches saved content.");
    assert(loadedContent.text.includes("This is bold test content of chapter 1."), "Plain-text content correctly extracted.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m6. Testing Chapter Version History & Autosave Serialization\x1b[0m");
    await saveContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
      html: "<p>Changed chapter content.</p>"
    });
    const versions = await listChapterVersions(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id);
    assert(versions.length === 1, "Saving changed content creates one chapter version.");
    await restoreChapterVersion(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, versions[0].id);
    assert(
      (await getContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id)).html === testHtml &&
        (await listChapterVersions(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id)).length === 2,
      "Restoring a version preserves the replaced content in history."
    );
    await Promise.all([
      saveContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
        html: "<h1>Autosave</h1><p>First draft.</p>"
      }),
      saveContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
        html: "<h1>Autosave</h1><p>Latest draft.</p>"
      })
    ]);
    assert(
      (await getContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id)).text.includes("Latest draft."),
      "Overlapping autosaves serialize and preserve the latest editor content."
    );
    await saveContent(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, { html: testHtml });

    // ----------------------------------------------------
    console.log("\n\x1b[35m7. Testing Chapter PDF Export Document\x1b[0m");
    const exportHtml = buildChapterPdfHtml(
      "Truyện thử tiếng Việt",
      'Chương 1: "Thức tỉnh"',
      `<h1>Old title</h1>${testHtml}<img src="data:image/png;base64,AA==">`,
      "data:image/jpeg;base64,AA=="
    );
    assert(
      exportHtml.includes('charset="utf-8"') &&
        exportHtml.includes("Truyện thử tiếng Việt") &&
        exportHtml.includes("This is <strong>bold</strong>") &&
        exportHtml.includes("data:image/png;base64,AA==") &&
        exportHtml.includes('class="cover"'),
      "PDF document preserves Vietnamese text, cover, formatting, and inline images."
    );
    assert(
      (exportHtml.match(/<h1/g) ?? []).length === 1 &&
        safeExportFileName('Chương 1: "Thức tỉnh"?') === "Chương 1_ _Thức tỉnh__",
      "PDF document uses one chapter heading and a Windows-safe file name."
    );
    const volumeExportHtml = buildVolumePdfHtml("Truyện thử", "Tập 1", [
      { title: "Chương 1", html: testHtml },
      { title: "Chương 2", html: "<h1>Duplicate title</h1><p>Nội dung chương 2.</p>" }
    ]);
    assert(
      volumeExportHtml.includes('href="#chapter-1"') &&
        volumeExportHtml.includes('id="chapter-2"') &&
        (volumeExportHtml.match(/class="chapter"/g) ?? []).length === 2 &&
        !volumeExportHtml.includes("Duplicate title"),
      "Volume PDF document includes an ordered table of contents and page-broken chapters."
    );
    const seriesExportHtml = buildSeriesPdfHtml(
      {
        title: "Truyện thử",
        originalTitle: "Test Novel",
        originalAuthor: "Tác giả",
        translator: "Dịch giả",
        description: "Mô tả"
      },
      [
        { title: "Web Novel", chapters: [{ title: "Chương 1", html: testHtml }] },
        { title: "Light Novel - Tập 1", chapters: [{ title: "Chương 2", html: "<p>Nội dung.</p>" }] }
      ]
    );
    assert(
      seriesExportHtml.includes("Original title:") &&
        seriesExportHtml.includes('href="#part-2-chapter-1"') &&
        (seriesExportHtml.match(/class="series-part"/g) ?? []).length === 2,
      "Series PDF document includes metadata and ordered category/volume chapter groups."
    );
    const epubBuffer = await buildChapterEpub({
      identifier: `urn:uuid:${chapter1.id}`,
      title: "Chương 1",
      seriesTitle: "Truyện thử",
      language: "vi",
      creator: "Tác giả",
      html: `${testHtml}<img src="data:image/png;base64,AA==">`,
      modifiedAt: chapter1.updatedAt,
      coverDataUrl: "data:image/jpeg;base64,AA=="
    });
    const epub = await JSZip.loadAsync(epubBuffer);
    assert(
      epubBuffer.readUInt16LE(8) === 0 &&
        epubBuffer.subarray(30, 38).toString("utf8") === "mimetype" &&
        await epub.file("mimetype")!.async("string") === "application/epub+zip" &&
        !!epub.file("META-INF/container.xml") &&
        !!epub.file("OEBPS/content.opf") &&
        !!epub.file("OEBPS/nav.xhtml") &&
        !!epub.file("OEBPS/cover.xhtml") &&
        !!epub.file("OEBPS/images/cover.jpg") &&
        !!epub.file("OEBPS/chapter-1.xhtml") &&
        !!epub.file("OEBPS/images/chapter-1-image-1.png") &&
        (await epub.file("OEBPS/chapter-1.xhtml")!.async("string")).includes('src="images/chapter-1-image-1.png"'),
      "Chapter EPUB contains valid package files, navigation, XHTML, and extracted inline images."
    );
    const volumeEpub = await JSZip.loadAsync(
      await buildVolumeEpub({
        identifier: `urn:uuid:${volume.id}`,
        title: "Tập 1",
        seriesTitle: "Truyện thử",
        language: "vi",
        creator: "Tác giả",
        chapters: [
          { title: "Chương 1", html: testHtml },
          { title: "Chương 2", html: "<p>Nội dung chương 2.</p>" }
        ],
        modifiedAt: volume.updatedAt
      })
    );
    const volumeOpf = await volumeEpub.file("OEBPS/content.opf")!.async("string");
    const volumeNav = await volumeEpub.file("OEBPS/nav.xhtml")!.async("string");
    assert(
      !!volumeEpub.file("OEBPS/chapter-2.xhtml") &&
        volumeOpf.includes('<itemref idref="chapter-2"/>') &&
        volumeNav.includes('href="chapter-2.xhtml"'),
      "Volume EPUB contains ordered chapter documents, spine entries, and navigation."
    );
    const seriesEpub = await JSZip.loadAsync(
      await buildSeriesEpub({
        identifier: `urn:uuid:${newSeries.id}`,
        title: "Truyện thử",
        seriesTitle: "Truyện thử",
        language: "vi",
        creator: "Tác giả",
        groups: [
          { title: "Web Novel", chapters: [{ title: "Chương 1", html: testHtml }] },
          { title: "Light Novel - Tập 1", chapters: [{ title: "Chương 2", html: "<p>Nội dung.</p>" }] }
        ],
        modifiedAt: newSeries.updatedAt
      })
    );
    const seriesNav = await seriesEpub.file("OEBPS/nav.xhtml")!.async("string");
    assert(
      !!seriesEpub.file("OEBPS/chapter-2.xhtml") &&
        seriesNav.includes("Web Novel - Chương 1") &&
        seriesNav.includes("Light Novel - Tập 1 - Chương 2"),
      "Series EPUB preserves category/volume order in its chapter documents and navigation."
    );

    // ----------------------------------------------------
    console.log("\n\x1b[35m8. Testing NovelReader Navigation, Progress & Recents\x1b[0m");
    const readerChapter1 = await createChapterMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id, {
      title: "Reader Chapter 1",
      order: 1
    });
    const readerChapter2 = await createChapterMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id, {
      title: "Reader Chapter 2",
      order: 2
    });
    await saveContent(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id, readerChapter2.id, {
      html: "<p>Reader next chapter content.</p>"
    });
    const readerChapters = await listChapterMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id);
    assert(
      readerChapters.map((chapter) => chapter.id).join(",") === `${readerChapter1.id},${readerChapter2.id}`,
      "NovelReader chapter navigation follows volume order."
    );
    assert(
      (await getContent(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id, readerChapter2.id)).text ===
        "Reader next chapter content.",
      "NovelReader loads the selected next chapter content."
    );
    const initialProgress = await readChapterReadingProgress(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id);
    assert(initialProgress.scrollTop === 0, "Initial progress scroll top is 0.");

    await saveChapterReadingProgress(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
      scrollTop: 350
    });
    const updatedProgress = await readChapterReadingProgress(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id);
    assert(updatedProgress.scrollTop === 350, "Reading progress saved and retrieved correctly.");

    const recents = await listRecentEntries(TEST_LIB_DIR);
    assert(recents.length === 1, "Recent reading carousel contains exactly 1 entry.");
    assert(recents[0].chapterId === chapter1.id, "Recent entry references correct chapter.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m9. Testing TXT, Markdown, DOCX & PDF Import\x1b[0m");
    await mkdir(TEST_IMPORT_DIR, { recursive: true });
    await writeFile(join(TEST_IMPORT_DIR, "chapter.txt"), "TXT import content.", "utf8");
    await writeFile(join(TEST_IMPORT_DIR, "chapter.md"), "# Markdown\n\n**Markdown import content.**", "utf8");
    await writeTestDocx(join(TEST_IMPORT_DIR, "chapter.docx"));
    await writeTestPdf(join(TEST_IMPORT_DIR, "chapter.pdf"));
    const importSessionId = "integration-import-session";
    importSessions.set(importSessionId, {
      id: importSessionId,
      sourceFolderPath: TEST_IMPORT_DIR,
      createdAt: new Date().toISOString()
    });
    const importPreview = await scanImportSession(importSessionId);
    assert(
      importPreview.counts.chapters === 4 &&
        importPreview.counts.txt === 1 &&
        importPreview.counts.md === 1 &&
        importPreview.counts.docx === 1 &&
        importPreview.counts.pdf === 1,
      "Import scan detects TXT, Markdown, DOCX, and PDF chapters."
    );
    const importReport = await executeImport(TEST_LIB_DIR, importSessionId, {
      target: {
        mode: "existing",
        seriesId: newSeries.id,
        categoryId: lnCategory.id,
        volumeMode: "source"
      },
      chapters: [
        { fileId: importFileId("chapter.txt"), title: "Imported TXT", volumeTitle: "Import Tests" },
        { fileId: importFileId("chapter.md"), title: "Imported Markdown", volumeTitle: "Import Tests" },
        { fileId: importFileId("chapter.docx"), title: "Imported DOCX", volumeTitle: "Import Tests" },
        { fileId: importFileId("chapter.pdf"), title: "Imported PDF", volumeTitle: "Import Tests" }
      ]
    });
    const importVolume = (await listVolumeMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id)).find(
      (item) => item.title === "Import Tests"
    )!;
    const importedChapters = await listChapterMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id, importVolume.id);
    const importedText = new Map(
      await Promise.all(
        importedChapters.map(async (chapter) => [
          chapter.title,
          (await getContent(TEST_LIB_DIR, newSeries.id, lnCategory.id, importVolume.id, chapter.id)).text
        ] as const)
      )
    );
    assert(
      importReport.imported === 4 && importReport.failed === 0 && importedChapters.length === 4,
      "Import execution creates all four chapters without failures."
    );
    assert(
      importedText.get("Imported TXT") === "TXT import content." &&
        importedText.get("Imported Markdown")?.includes("Markdown import content.") &&
        importedText.get("Imported DOCX") === "DOCX import content." &&
        importedText.get("Imported PDF")?.includes("PDF import content."),
      "Imported TXT, Markdown, DOCX, and PDF content remains readable."
    );

    // ----------------------------------------------------
    console.log("\n\x1b[35m10. Testing Bookmarks & Highlights\x1b[0m");
    const bookmarked = await toggleChapterBookmark(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
      scrollTop: 350
    });
    assert(bookmarked !== null, "Bookmark toggled ON.");

    const bookmarks = await listBookmarks(TEST_LIB_DIR);
    assert(bookmarks.length === 1, "Bookmarks list contains exactly 1 bookmark.");
    assert(bookmarks[0].chapterId === chapter1.id, "Bookmark references correct chapter.");

    // Highlight text with note
    const highlight = await createHighlight(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id, {
      text: "bold test content",
      note: "Important definition",
      color: "yellow",
      scrollTop: 350
    });
    assert(highlight.text === "bold test content", "Highlight created with correct text.");
    assert(highlight.note === "Important definition", "Highlight note matches.");

    const highlights = await listHighlights(TEST_LIB_DIR);
    assert(highlights.length === 1, "Highlights list contains exactly 1 highlight.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m11. Testing Search Index & Queries\x1b[0m");
    await rebuildSearchIndex(TEST_LIB_DIR);
    assert(true, "Search index rebuilt successfully.");

    const searchResults = await searchLibrary(TEST_LIB_DIR, "bold test");
    assert(searchResults.length === 1, "Search query returned exactly 1 match.");
    assert(searchResults[0].chapterId === chapter1.id, "Search result matches correct chapter.");
    assert(searchResults[0].snippet.includes("bold test"), "Search snippet contains queried text.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m12. Testing Full Library Backup\x1b[0m");
    const backup = await createFullLibraryBackup(TEST_LIB_DIR);
    const backupManifest = JSON.parse(await readFile(join(backup.path, "backup.json"), "utf8")) as {
      schemaVersion: number;
      type: string;
    };
    const backedUpContent = await readFile(
      join(backup.path, "series", newSeries.id, "categories", category.id, "chapters", chapter1.id, "content.html"),
      "utf8"
    );
    assert(backupManifest.schemaVersion === 1 && backupManifest.type === "full", "Backup manifest is valid.");
    assert(backedUpContent === testHtml, "Full backup preserves chapter content.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m13. Testing Selective Backups\x1b[0m");
    const metadataBackup = await createLibraryBackup(TEST_LIB_DIR, "metadata");
    const contentBackup = await createLibraryBackup(TEST_LIB_DIR, "content");
    const chapterRelativePath = join(
      "series",
      newSeries.id,
      "categories",
      category.id,
      "chapters",
      chapter1.id
    );
    assert(
      await fileExists(join(metadataBackup.path, chapterRelativePath, "meta.json")) &&
        !(await fileExists(join(metadataBackup.path, chapterRelativePath, "content.html"))),
      "Metadata backup excludes chapter content."
    );
    assert(
      await fileExists(join(contentBackup.path, chapterRelativePath, "content.html")) &&
        !(await fileExists(join(contentBackup.path, chapterRelativePath, "meta.json"))),
      "Content backup excludes metadata."
    );

    // ----------------------------------------------------
    console.log("\n\x1b[35m14. Testing Full Library Restore\x1b[0m");
    const restored = await restoreFullLibraryBackup(TEST_LIB_DIR, backup.path, RESTORED_TEST_LIB_DIR);
    const restoredContent = await readFile(
      join(restored.path, "series", newSeries.id, "categories", category.id, "chapters", chapter1.id, "content.html"),
      "utf8"
    );
    assert(restoredContent === testHtml, "Full restore preserves chapter content.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m15. Testing Schema Migration\x1b[0m");
    const restoredLibraryJsonPath = join(restored.path, "library.json");
    const restoredLibraryJson = JSON.parse(await readFile(restoredLibraryJsonPath, "utf8")) as Record<string, unknown>;
    delete restoredLibraryJson.schemaVersion;
    await writeFile(restoredLibraryJsonPath, `${JSON.stringify(restoredLibraryJson, null, 2)}\n`, "utf8");

    const migration = await migrateLibrary(restored.path);
    const migratedLibraryJson = JSON.parse(await readFile(restoredLibraryJsonPath, "utf8")) as {
      schemaVersion?: number;
    };
    const preMigrationLibraryJson = JSON.parse(
      await readFile(join(migration.backupPath!, "library.json"), "utf8")
    ) as { schemaVersion?: number };
    assert(
      migration.fromVersion === 0 &&
        migration.toVersion === 1 &&
        migration.migratedFiles === 1 &&
        migratedLibraryJson.schemaVersion === 1,
      "Schema migration upgrades version 0 metadata."
    );
    assert(
      migration.backupPath !== null && preMigrationLibraryJson.schemaVersion === undefined,
      "Migration creates a full pre-migration backup."
    );

    // ----------------------------------------------------
    console.log("\n\x1b[35m16. Testing Trash Restore\x1b[0m");
    await moveChapterToTrash(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id);
    const chaptersAfterDelete = await listChapterMetadata(TEST_LIB_DIR, newSeries.id, category.id, null);
    assert(chaptersAfterDelete.length === 0, "Chapter removed from category list.");
    const chapterTrash = (await listTrashEntries(TEST_LIB_DIR)).find((entry) => entry.itemId === chapter1.id);
    await restoreTrashItem(TEST_LIB_DIR, chapterTrash!.trashId);
    assert(
      (await listChapterMetadata(TEST_LIB_DIR, newSeries.id, category.id, null))[0]?.id === chapter1.id,
      "Chapter restored to its original category."
    );

    await moveVolumeToTrash(TEST_LIB_DIR, newSeries.id, lnCategory.id, volume.id);
    const volumeTrash = (await listTrashEntries(TEST_LIB_DIR)).find((entry) => entry.itemId === volume.id);
    await restoreTrashItem(TEST_LIB_DIR, volumeTrash!.trashId);
    assert(
      (await listVolumeMetadata(TEST_LIB_DIR, newSeries.id, lnCategory.id))[0]?.id === volume.id,
      "Volume restored to its original category."
    );

    await moveCategoryToTrash(TEST_LIB_DIR, newSeries.id, category.id);
    const categoryTrash = (await listTrashEntries(TEST_LIB_DIR)).find((entry) => entry.itemId === category.id);
    await restoreTrashItem(TEST_LIB_DIR, categoryTrash!.trashId);
    assert(
      (await listCategoryMetadata(TEST_LIB_DIR, newSeries.id)).some((item) => item.id === category.id),
      "Category restored to its original series."
    );

    await moveSeriesToTrash(TEST_LIB_DIR, newSeries.id);
    const seriesListAfterDelete = await listSeriesCards(TEST_LIB_DIR);
    assert(seriesListAfterDelete.length === 0, "Series removed from library index list.");
    const seriesTrash = (await listTrashEntries(TEST_LIB_DIR)).find((entry) => entry.itemId === newSeries.id);
    await restoreTrashItem(TEST_LIB_DIR, seriesTrash!.trashId);
    assert(
      (await listSeriesCards(TEST_LIB_DIR))[0]?.id === newSeries.id && (await listTrashEntries(TEST_LIB_DIR)).length === 0,
      "Series restored and Trash is empty."
    );

    // Rebuild indexes after trashing
    await repairSeriesIndex(TEST_LIB_DIR);
    assert(true, "Library indexes repaired successfully.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m17. Testing Permanent Trash Delete\x1b[0m");
    const disposableChapter = await createChapterMetadata(TEST_LIB_DIR, newSeries.id, category.id, null, {
      title: "Disposable Chapter"
    });
    await moveChapterToTrash(TEST_LIB_DIR, newSeries.id, category.id, null, disposableChapter.id);
    const disposableTrash = (await listTrashEntries(TEST_LIB_DIR)).find(
      (entry) => entry.itemId === disposableChapter.id
    );
    await deleteTrashItem(TEST_LIB_DIR, disposableTrash!.trashId);
    assert(
      !(await fileExists(join(TEST_LIB_DIR, ".trash", disposableTrash!.trashId))) &&
        (await listTrashEntries(TEST_LIB_DIR)).length === 0,
      "Trash item is permanently deleted."
    );

    // ----------------------------------------------------
    console.log("\n\x1b[32m=== All Tests Passed Successfully! ===\x1b[0m");
    console.log(`Total assertions: ${passedTests} / ${totalTests}`);
  } catch (error) {
    console.error("\n\x1b[31m=== Test Execution Failed! ===\x1b[0m");
    console.error(error);
    process.exit(1);
  } finally {
    await cleanUp();
  }
}

void runTests();
