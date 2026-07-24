import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureLibraryFiles, repairSeriesIndex } from "../electron/services/library";
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

const TEST_LIB_DIR = join(process.cwd(), "temp-test-library");

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

async function cleanUp() {
  try {
    await rm(TEST_LIB_DIR, { recursive: true, force: true });
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
    console.log("\n\x1b[35m9. Testing Soft-Delete (.trash)\x1b[0m");
    await moveChapterToTrash(TEST_LIB_DIR, newSeries.id, category.id, null, chapter1.id);
    const chaptersAfterDelete = await listChapterMetadata(TEST_LIB_DIR, newSeries.id, category.id, null);
    assert(chaptersAfterDelete.length === 0, "Chapter removed from category list.");

    await moveSeriesToTrash(TEST_LIB_DIR, newSeries.id);
    const seriesListAfterDelete = await listSeriesCards(TEST_LIB_DIR);
    assert(seriesListAfterDelete.length === 0, "Series removed from library index list.");

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
