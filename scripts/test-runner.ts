import { access, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createFullLibraryBackup,
  createLibraryBackup,
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
import { listTrashEntries, restoreTrashItem } from "../electron/services/trash";

const TEST_LIB_DIR = join(process.cwd(), "temp-test-library");
const RESTORED_TEST_LIB_DIR = join(process.cwd(), "temp-test-restored-library");

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

async function cleanUp() {
  try {
    await rm(TEST_LIB_DIR, { recursive: true, force: true });
    await rm(RESTORED_TEST_LIB_DIR, { recursive: true, force: true });
  } catch (err) {}
}

async function runTests() {
  console.log("\x1b[36m=== NovelWeb Integration Test Suite ===\x1b[0m\n");

  await cleanUp();
  await mkdir(TEST_LIB_DIR, { recursive: true });

  try {
    // ----------------------------------------------------
    console.log("\x1b[35m1. Testing Library Initialization & Health\x1b[0m");
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
    console.log("\n\x1b[35m6. Testing Reading Progress & Recents\x1b[0m");
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
    console.log("\n\x1b[35m7. Testing Bookmarks & Highlights\x1b[0m");
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
    console.log("\n\x1b[35m8. Testing Search Index & Queries\x1b[0m");
    await rebuildSearchIndex(TEST_LIB_DIR);
    assert(true, "Search index rebuilt successfully.");

    const searchResults = await searchLibrary(TEST_LIB_DIR, "bold test");
    assert(searchResults.length === 1, "Search query returned exactly 1 match.");
    assert(searchResults[0].chapterId === chapter1.id, "Search result matches correct chapter.");
    assert(searchResults[0].snippet.includes("bold test"), "Search snippet contains queried text.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m9. Testing Full Library Backup\x1b[0m");
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
    console.log("\n\x1b[35m10. Testing Selective Backups\x1b[0m");
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
    console.log("\n\x1b[35m11. Testing Full Library Restore\x1b[0m");
    const restored = await restoreFullLibraryBackup(TEST_LIB_DIR, backup.path, RESTORED_TEST_LIB_DIR);
    const restoredContent = await readFile(
      join(restored.path, "series", newSeries.id, "categories", category.id, "chapters", chapter1.id, "content.html"),
      "utf8"
    );
    assert(restoredContent === testHtml, "Full restore preserves chapter content.");

    // ----------------------------------------------------
    console.log("\n\x1b[35m12. Testing Schema Migration\x1b[0m");
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
    console.log("\n\x1b[35m13. Testing Trash Restore\x1b[0m");
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
