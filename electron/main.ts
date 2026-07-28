import {
  app,
  BrowserWindow,
  dialog,
  ipcMain as electronIpcMain,
  shell,
  type OpenDialogOptions
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getExternalUrl, isTrustedRendererUrl } from "./security";
import {
  ok,
  fail,
  ErrorCode,
  readAppSettings,
  writeAppSettings,
  currentLibraryPathOrThrow,
  assertId,
  optionalVolumeId,
  type ApiResponse
} from "./services/base";
import {
  createLibraryBackup,
  activateLibraryPath,
  migrateLibrary,
  repairSeriesIndex,
  restoreFullLibraryBackup,
  type LibraryBackupResult,
  type LibraryBackupType
} from "./services/library";
import { getLibraryStatistics, type LibraryStatistics } from "./services/statistics";
import {
  listSeriesCards,
  readSeriesMetadata,
  createSeriesMetadata,
  updateSeriesMetadata,
  chooseSeriesCover,
  moveSeriesToTrash
} from "./services/series";
import {
  listCategoryMetadata,
  readCategoryMetadata,
  createCategoryMetadata,
  updateCategoryMetadata,
  moveCategoryToTrash
} from "./services/category";
import {
  listVolumeMetadata,
  readVolumeMetadata,
  createVolumeMetadata,
  updateVolumeMetadata,
  moveVolumeToTrash
} from "./services/volume";
import {
  listChapterMetadata,
  readChapterMetadata,
  createChapterMetadata,
  updateChapterMetadata,
  reorderChapterMetadata,
  moveChapterMetadata,
  getContent,
  saveContent,
  getOriginalPdf,
  getOriginalText,
  chooseImage,
  listChapterVersions,
  restoreChapterVersion,
  moveToTrash as moveChapterToTrash,
  type ChapterVersion
} from "./services/chapter";
import {
  chooseImportSourceFolder,
  chooseImportSourceFiles,
  scanImportSession,
  executeImport,
  listImportHistory
} from "./services/import";
import { searchLibrary, rebuildSearchIndex } from "./services/search";
import {
  exportChapterToEpub,
  exportChapterToPdf,
  previewChapterExport,
  previewSeriesExport,
  previewVolumeExport,
  exportSeriesToEpub,
  exportSeriesToPdf,
  exportVolumeToEpub,
  exportVolumeToPdf,
  type ExportResult
} from "./services/export";
import {
  listRecentEntries,
  listBookmarks,
  getChapterBookmark,
  toggleChapterBookmark,
  listHighlights,
  listChapterHighlights,
  createHighlight,
  deleteHighlight,
  readChapterReadingProgress,
  saveChapterReadingProgress
} from "./services/readingState";

import { type SeriesIndex } from "./services/library";
import {
  type SeriesCard,
  type SeriesDetailData,
  type ChapterContent,
  type ChapterOriginalPdf,
  type ChapterOriginalText,
  type ChapterImageAsset,
  type ChapterReadingProgress,
  type ReadingListEntry,
  type BookmarkEntry,
  type HighlightEntry
} from "./services/base";
import { type CategoryMetadata } from "./schemas/category";
import { type VolumeMetadata } from "./schemas/volume";
import { type NovelChapterMetadata as ChapterMetadata } from "./schemas/chapter";
import { type ImportPreview, type ImportReport } from "./services/import";
import { type SearchResult, type SearchIndexSummary } from "./services/search";
import { deleteTrashItem, listTrashEntries, restoreTrashItem, type TrashEntry } from "./services/trash";

const rendererFilePath = join(__dirname, "../renderer/index.html");
const rendererFileUrl = pathToFileURL(rendererFilePath).href;
type IpcHandler = Parameters<typeof electronIpcMain.handle>[1];
const ipcMain = {
  handle(channel: string, listener: IpcHandler): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      const senderUrl = event.senderFrame?.url ?? "";
      if (!isTrustedRendererUrl(senderUrl, process.env.ELECTRON_RENDERER_URL, rendererFileUrl)) {
        throw new Error("Blocked IPC from an untrusted renderer.");
      }
      return listener(event, ...args);
    });
  }
};

function registerLibraryIpc(): void {
  ipcMain.handle("library:statistics", async (): Promise<ApiResponse<LibraryStatistics>> => {
    try {
      return ok(await getLibraryStatistics(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.LIBRARY_FOLDER_LOAD_FAILED, "Could not calculate Library statistics.", String(error));
    }
  });

  ipcMain.handle("library:getCurrent", async (): Promise<ApiResponse<{ path: string | null }>> => {
    try {
      const settings = await readAppSettings();
      const currentLibraryPath = settings.currentLibraryPath ?? null;

      if (currentLibraryPath) {
        await migrateLibrary(currentLibraryPath);
      }

      return ok({ path: currentLibraryPath });
    } catch (error) {
      return fail(
        ErrorCode.LIBRARY_FOLDER_LOAD_FAILED,
        "The saved Library folder is unavailable. Locate it or choose another folder in Settings.",
        String(error)
      );
    }
  });

  ipcMain.handle("library:chooseFolder", async (event): Promise<ApiResponse<{ path: string | null }>> => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        title: "Choose NovelWeb Library folder",
        properties: ["openDirectory", "createDirectory"]
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

      if (result.canceled || !result.filePaths[0]) {
        return ok({ path: null });
      }

      const currentLibraryPath = await activateLibraryPath(result.filePaths[0]);

      return ok({ path: currentLibraryPath });
    } catch (error) {
      return fail(ErrorCode.LIBRARY_FOLDER_CHOOSE_FAILED, "Could not choose Library folder.", String(error));
    }
  });

  ipcMain.handle("library:repairSeriesIndex", async (): Promise<ApiResponse<SeriesIndex>> => {
    try {
      // Note: we fetch path and rebuild via repairSeriesIndex
      const libraryPath = await currentLibraryPathOrThrow();
      return ok(await repairSeriesIndex(libraryPath));
    } catch (error) {
      return fail(ErrorCode.LIBRARY_REPAIR_FAILED, "Could not repair series index.", String(error));
    }
  });

  ipcMain.handle(
    "library:createBackup",
    async (_event, type: unknown): Promise<ApiResponse<LibraryBackupResult>> => {
      try {
        if (type !== "metadata" && type !== "content" && type !== "full") {
          throw new Error("Backup type is invalid.");
        }
        return ok(await createLibraryBackup(await currentLibraryPathOrThrow(), type as LibraryBackupType));
      } catch (error) {
        return fail(ErrorCode.BACKUP_FAILED, "Could not back up the Library.", String(error));
      }
    }
  );

  ipcMain.handle(
    "library:restoreFullBackup",
    async (event): Promise<ApiResponse<{ path: string | null }>> => {
      try {
        const currentLibraryPath = await currentLibraryPathOrThrow();
        const window = BrowserWindow.fromWebContents(event.sender);
        const showFolderDialog = (options: OpenDialogOptions) =>
          window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
        const backupResult = await showFolderDialog({
          title: "Choose a full Library backup",
          defaultPath: join(currentLibraryPath, "backups"),
          properties: ["openDirectory"]
        });

        if (backupResult.canceled || !backupResult.filePaths[0]) {
          return ok({ path: null });
        }

        const destinationResult = await showFolderDialog({
          title: "Choose an empty folder for the restored Library",
          properties: ["openDirectory", "createDirectory"]
        });

        if (destinationResult.canceled || !destinationResult.filePaths[0]) {
          return ok({ path: null });
        }

        const restored = await restoreFullLibraryBackup(
          currentLibraryPath,
          backupResult.filePaths[0],
          destinationResult.filePaths[0]
        );
        const settings = await readAppSettings();
        await writeAppSettings({ ...settings, currentLibraryPath: restored.path });
        return ok(restored);
      } catch (error) {
        return fail(ErrorCode.RESTORE_FAILED, "Could not restore the Library.", String(error));
      }
    }
  );

}

function registerSeriesIpc(): void {
  ipcMain.handle("series:list", async (): Promise<ApiResponse<SeriesCard[]>> => {
    try {
      return ok(await listSeriesCards(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not list series.", String(error));
    }
  });

  ipcMain.handle("series:get", async (_event, seriesId: unknown): Promise<ApiResponse<SeriesDetailData>> => {
    try {
      const libraryPath = await currentLibraryPathOrThrow();
      const metadata = await readSeriesMetadata(libraryPath, assertId(seriesId, "seriesId"));
      const coverDataUrl = await chooseSeriesCoverDataUrl(libraryPath, { id: metadata.id, coverImage: metadata.coverImage });
      return ok({ ...metadata, coverDataUrl });
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not load series.", String(error));
    }
  });

  ipcMain.handle("series:create", async (_event, input: unknown): Promise<ApiResponse<SeriesDetailData>> => {
    try {
      const libraryPath = await currentLibraryPathOrThrow();
      const metadata = await createSeriesMetadata(libraryPath, input);
      return ok({ ...metadata, coverDataUrl: null });
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not create series.", String(error));
    }
  });

  ipcMain.handle("series:update", async (_event, seriesId: unknown, input: unknown): Promise<ApiResponse<SeriesDetailData>> => {
    try {
      const libraryPath = await currentLibraryPathOrThrow();
      const metadata = await updateSeriesMetadata(libraryPath, assertId(seriesId, "seriesId"), input);
      const coverDataUrl = await chooseSeriesCoverDataUrl(libraryPath, { id: metadata.id, coverImage: metadata.coverImage });
      return ok({ ...metadata, coverDataUrl });
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not update series.", String(error));
    }
  });

  ipcMain.handle("series:chooseCover", async (event, seriesId: unknown): Promise<ApiResponse<SeriesDetailData | null>> => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      return ok(await chooseSeriesCover(window, await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId")));
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not choose series cover.", String(error));
    }
  });

  ipcMain.handle("series:moveToTrash", async (_event, seriesId: unknown): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
    try {
      return ok(await moveSeriesToTrash(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId")));
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not move series to trash.", String(error));
    }
  });
}

function registerTrashIpc(): void {
  ipcMain.handle("trash:list", async (): Promise<ApiResponse<TrashEntry[]>> => {
    try {
      return ok(await listTrashEntries(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.TRASH_FAILED, "Could not list trash.", String(error));
    }
  });

  ipcMain.handle("trash:restore", async (_event, trashId: unknown): Promise<ApiResponse<TrashEntry>> => {
    try {
      return ok(await restoreTrashItem(await currentLibraryPathOrThrow(), assertId(trashId, "trashId")));
    } catch (error) {
      return fail(ErrorCode.TRASH_FAILED, "Could not restore trash item.", String(error));
    }
  });

  ipcMain.handle("trash:delete", async (_event, trashId: unknown): Promise<ApiResponse<TrashEntry>> => {
    try {
      return ok(await deleteTrashItem(await currentLibraryPathOrThrow(), assertId(trashId, "trashId")));
    } catch (error) {
      return fail(ErrorCode.TRASH_FAILED, "Could not permanently delete trash item.", String(error));
    }
  });
}

import { readSeriesCoverDataUrl as chooseSeriesCoverDataUrl } from "./services/series";

function registerCategoryIpc(): void {
  ipcMain.handle("categories:list", async (_event, seriesId: unknown): Promise<ApiResponse<CategoryMetadata[]>> => {
    try {
      return ok(await listCategoryMetadata(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId")));
    } catch (error) {
      return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not list categories.", String(error));
    }
  });

  ipcMain.handle("categories:get", async (_event, seriesId: unknown, categoryId: unknown): Promise<ApiResponse<CategoryMetadata>> => {
    try {
      return ok(
        await readCategoryMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not load category.", String(error));
    }
  });

  ipcMain.handle("categories:create", async (_event, seriesId: unknown, input: unknown): Promise<ApiResponse<CategoryMetadata>> => {
    try {
      return ok(await createCategoryMetadata(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId"), input));
    } catch (error) {
      return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not create category.", String(error));
    }
  });

  ipcMain.handle("categories:update", async (_event, seriesId: unknown, categoryId: unknown, input: unknown): Promise<ApiResponse<CategoryMetadata>> => {
    try {
      return ok(
        await updateCategoryMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not update category.", String(error));
    }
  });

  ipcMain.handle("categories:moveToTrash", async (_event, seriesId: unknown, categoryId: unknown): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
    try {
      return ok(
        await moveCategoryToTrash(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not move category to trash.", String(error));
    }
  });
}

function registerVolumeIpc(): void {
  ipcMain.handle("volumes:list", async (_event, seriesId: unknown, categoryId: unknown): Promise<ApiResponse<VolumeMetadata[]>> => {
    try {
      return ok(
        await listVolumeMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.VOLUME_CRUD_FAILED, "Could not list volumes.", String(error));
    }
  });

  ipcMain.handle("volumes:get", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<VolumeMetadata>> => {
    try {
      return ok(
        await readVolumeMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          assertId(volumeId, "volumeId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.VOLUME_CRUD_FAILED, "Could not load volume.", String(error));
    }
  });

  ipcMain.handle("volumes:create", async (_event, seriesId: unknown, categoryId: unknown, input: unknown): Promise<ApiResponse<VolumeMetadata>> => {
    try {
      return ok(
        await createVolumeMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.VOLUME_CRUD_FAILED, "Could not create volume.", String(error));
    }
  });

  ipcMain.handle("volumes:update", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, input: unknown): Promise<ApiResponse<VolumeMetadata>> => {
    try {
      return ok(
        await updateVolumeMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          assertId(volumeId, "volumeId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.VOLUME_CRUD_FAILED, "Could not update volume.", String(error));
    }
  });

  ipcMain.handle("volumes:moveToTrash", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
    try {
      return ok(
        await moveVolumeToTrash(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          assertId(volumeId, "volumeId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.VOLUME_CRUD_FAILED, "Could not move volume to trash.", String(error));
    }
  });
}

function registerChapterIpc(): void {
  ipcMain.handle("chapters:list", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<ChapterMetadata[]>> => {
    try {
      return ok(
        await listChapterMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId)
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not list chapters.", String(error));
    }
  });

  ipcMain.handle("chapters:get", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<ChapterMetadata>> => {
    try {
      return ok(
        await readChapterMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not load chapter.", String(error));
    }
  });

  ipcMain.handle("chapters:create", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, input: unknown): Promise<ApiResponse<ChapterMetadata>> => {
    try {
      return ok(
        await createChapterMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not create chapter.", String(error));
    }
  });

  ipcMain.handle("chapters:update", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, input: unknown): Promise<ApiResponse<ChapterMetadata>> => {
    try {
      return ok(
        await updateChapterMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not update chapter.", String(error));
    }
  });

  ipcMain.handle("chapters:reorder", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, input: unknown): Promise<ApiResponse<ChapterMetadata[]>> => {
    try {
      return ok(
        await reorderChapterMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not reorder chapters.", String(error));
    }
  });

  ipcMain.handle("chapters:move", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, input: unknown): Promise<ApiResponse<ChapterMetadata>> => {
    try {
      return ok(
        await moveChapterMetadata(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not move chapter.", String(error));
    }
  });

  ipcMain.handle("chapters:getContent", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<Pick<ChapterContent, "html">>> => {
    try {
      const content = await getContent(
        await currentLibraryPathOrThrow(),
        assertId(seriesId, "seriesId"),
        assertId(categoryId, "categoryId"),
        optionalVolumeId(volumeId),
        assertId(chapterId, "chapterId"),
        { includeText: false }
      );
      return ok({ html: content.html });
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not load chapter content.", String(error));
    }
  });

  ipcMain.handle("chapters:saveContent", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, input: unknown): Promise<ApiResponse<ChapterContent>> => {
    try {
      return ok(
        await saveContent(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not save chapter content.", String(error));
    }
  });

  ipcMain.handle("chapters:listVersions", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<ChapterVersion[]>> => {
    try {
      return ok(
        await listChapterVersions(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not list chapter versions.", String(error));
    }
  });

  ipcMain.handle("chapters:restoreVersion", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, versionId: unknown): Promise<ApiResponse<ChapterContent>> => {
    try {
      return ok(
        await restoreChapterVersion(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          assertId(versionId, "versionId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not restore chapter version.", String(error));
    }
  });

  ipcMain.handle("chapters:getOriginalPdf", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<ChapterOriginalPdf | null>> => {
    try {
      return ok(
        await getOriginalPdf(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not load chapter PDF.", String(error));
    }
  });

  ipcMain.handle("chapters:getOriginalText", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<ChapterOriginalText | null>> => {
    try {
      return ok(
        await getOriginalText(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not load original text.", String(error));
    }
  });

  ipcMain.handle("chapters:chooseImage", async (event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<ChapterImageAsset | null>> => {
    try {
      return ok(
        await chooseImage(
          BrowserWindow.fromWebContents(event.sender),
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not insert chapter image.", String(error));
    }
  });

  ipcMain.handle("chapters:getProgress", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<ChapterReadingProgress>> => {
    try {
      return ok(
        await readChapterReadingProgress(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not load chapter progress.", String(error));
    }
  });

  ipcMain.handle("chapters:saveProgress", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, input: unknown): Promise<ApiResponse<ChapterReadingProgress>> => {
    try {
      return ok(
        await saveChapterReadingProgress(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not save chapter progress.", String(error));
    }
  });

  ipcMain.handle("chapters:moveToTrash", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
    try {
      return ok(
        await moveChapterToTrash(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not move chapter to trash.", String(error));
    }
  });
}

function registerImportIpc(): void {
  ipcMain.handle("import:history", async (): Promise<ApiResponse<Awaited<ReturnType<typeof listImportHistory>>>> => {
    try {
      return ok(await listImportHistory(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.IMPORT_FAILED, "Could not load import history.", String(error));
    }
  });

  ipcMain.handle("import:chooseSourceFolder", async (event): Promise<ApiResponse<{ importSessionId: string; path: string; name: string } | null>> => {
    try {
      return ok(await chooseImportSourceFolder(BrowserWindow.fromWebContents(event.sender)));
    } catch (error) {
      return fail(ErrorCode.IMPORT_FAILED, "Could not choose import source folder.", String(error));
    }
  });

  ipcMain.handle("import:chooseSourceFiles", async (event): Promise<ApiResponse<{ importSessionId: string; path: string; name: string } | null>> => {
    try {
      return ok(await chooseImportSourceFiles(BrowserWindow.fromWebContents(event.sender)));
    } catch (error) {
      return fail(ErrorCode.IMPORT_FAILED, "Could not choose import chapter files.", String(error));
    }
  });

  ipcMain.handle("import:scan", async (_event, importSessionId: unknown): Promise<ApiResponse<ImportPreview>> => {
    try {
      return ok(await scanImportSession(importSessionId));
    } catch (error) {
      return fail(ErrorCode.IMPORT_FAILED, "Could not scan import source folder.", String(error));
    }
  });

  ipcMain.handle("import:execute", async (_event, importSessionId: unknown, input: unknown): Promise<ApiResponse<ImportReport>> => {
    try {
      return ok(await executeImport(await currentLibraryPathOrThrow(), importSessionId, input));
    } catch (error) {
      return fail(ErrorCode.IMPORT_FAILED, "Could not import selected chapters.", String(error));
    }
  });
}

function registerExportIpc(): void {
  ipcMain.handle(
    "export:chapterPreview",
    async (event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<null>> => {
      try {
        await previewChapterExport(
          BrowserWindow.fromWebContents(event.sender),
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        );
        return ok(null);
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not preview chapter export.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:volumePreview",
    async (event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<null>> => {
      try {
        await previewVolumeExport(
          BrowserWindow.fromWebContents(event.sender),
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          assertId(volumeId, "volumeId")
        );
        return ok(null);
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not preview volume export.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:seriesPreview",
    async (event, seriesId: unknown): Promise<ApiResponse<null>> => {
      try {
        await previewSeriesExport(
          BrowserWindow.fromWebContents(event.sender),
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId")
        );
        return ok(null);
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not preview series export.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:chapterPdf",
    async (
      event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ExportResult | null>> => {
      try {
        return ok(
          await exportChapterToPdf(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            optionalVolumeId(volumeId),
            assertId(chapterId, "chapterId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not export chapter to PDF.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:chapterEpub",
    async (
      event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ExportResult | null>> => {
      try {
        return ok(
          await exportChapterToEpub(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            optionalVolumeId(volumeId),
            assertId(chapterId, "chapterId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not export chapter to EPUB.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:volumePdf",
    async (event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<ExportResult | null>> => {
      try {
        return ok(
          await exportVolumeToPdf(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            assertId(volumeId, "volumeId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not export volume to PDF.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:volumeEpub",
    async (event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<ExportResult | null>> => {
      try {
        return ok(
          await exportVolumeToEpub(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            assertId(volumeId, "volumeId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not export volume to EPUB.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:seriesPdf",
    async (event, seriesId: unknown): Promise<ApiResponse<ExportResult | null>> => {
      try {
        return ok(
          await exportSeriesToPdf(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not export series to PDF.", String(error));
      }
    }
  );

  ipcMain.handle(
    "export:seriesEpub",
    async (event, seriesId: unknown): Promise<ApiResponse<ExportResult | null>> => {
      try {
        return ok(
          await exportSeriesToEpub(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.EXPORT_FAILED, "Could not export series to EPUB.", String(error));
      }
    }
  );
}

function registerSearchIpc(): void {
  ipcMain.handle("search:query", async (_event, query: unknown): Promise<ApiResponse<SearchResult[]>> => {
    try {
      return ok(await searchLibrary(await currentLibraryPathOrThrow(), query));
    } catch (error) {
      return fail(ErrorCode.SEARCH_FAILED, "Could not search library.", String(error));
    }
  });

  ipcMain.handle("search:rebuild", async (): Promise<ApiResponse<SearchIndexSummary>> => {
    try {
      return ok(summarizeSearchIndex(await rebuildSearchIndex(await currentLibraryPathOrThrow())));
    } catch (error) {
      return fail(ErrorCode.SEARCH_FAILED, "Could not rebuild search index.", String(error));
    }
  });
}

import { summarizeSearchIndex } from "./services/search";

function registerReadingStateIpc(): void {
  ipcMain.handle("reading:listRecent", async (): Promise<ApiResponse<ReadingListEntry[]>> => {
    try {
      return ok(await listRecentEntries(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list recent reading.", String(error));
    }
  });

  ipcMain.handle("bookmarks:list", async (): Promise<ApiResponse<BookmarkEntry[]>> => {
    try {
      return ok(await listBookmarks(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list bookmarks.", String(error));
    }
  });

  ipcMain.handle("bookmarks:get", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<BookmarkEntry | null>> => {
    try {
      return ok(
        await getChapterBookmark(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not load bookmark.", String(error));
    }
  });

  ipcMain.handle("bookmarks:toggle", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, input: unknown): Promise<ApiResponse<BookmarkEntry | null>> => {
    try {
      return ok(
        await toggleChapterBookmark(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not toggle bookmark.", String(error));
    }
  });

  ipcMain.handle("highlights:list", async (): Promise<ApiResponse<HighlightEntry[]>> => {
    try {
      return ok(await listHighlights(await currentLibraryPathOrThrow()));
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list highlights.", String(error));
    }
  });

  ipcMain.handle("highlights:listForChapter", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown): Promise<ApiResponse<HighlightEntry[]>> => {
    try {
      return ok(
        await listChapterHighlights(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list chapter highlights.", String(error));
    }
  });

  ipcMain.handle("highlights:create", async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown, chapterId: unknown, input: unknown): Promise<ApiResponse<HighlightEntry>> => {
    try {
      return ok(
        await createHighlight(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(categoryId, "categoryId"),
          optionalVolumeId(volumeId),
          assertId(chapterId, "chapterId"),
          input
        )
      );
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not create highlight.", String(error));
    }
  });

  ipcMain.handle("highlights:delete", async (_event, seriesId: unknown, highlightId: unknown): Promise<ApiResponse<{ id: string }>> => {
    try {
      return ok(
        await deleteHighlight(
          await currentLibraryPathOrThrow(),
          assertId(seriesId, "seriesId"),
          assertId(highlightId, "highlightId")
        )
      );
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not delete highlight.", String(error));
    }
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url, process.env.ELECTRON_RENDERER_URL, rendererFileUrl)) {
      return;
    }

    event.preventDefault();
    const externalUrl = getExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(rendererFilePath);
  }
}

void app.whenReady().then(() => {
  registerLibraryIpc();
  registerSeriesIpc();
  registerCategoryIpc();
  registerVolumeIpc();
  registerChapterIpc();
  registerImportIpc();
  registerExportIpc();
  registerSearchIpc();
  registerReadingStateIpc();
  registerTrashIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
