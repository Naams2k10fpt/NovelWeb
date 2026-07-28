import { app } from "electron";
import { copyFile, mkdir, readFile, rename, stat, writeFile, cp, rm, appendFile as nodeAppendFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SERIES_COLLECTIONS,
  SERIES_STATUSES,
  type SeriesCollection,
  type SeriesMetadata,
  type SeriesStatus
} from "../schemas/series";
import {
  CATEGORY_TYPES,
  type CategoryType
} from "../schemas/category";
import {
  NOVEL_CHAPTER_TYPES,
  TRANSLATION_STATUSES,
  type NovelChapterMetadata,
  type NovelChapterType,
  type TranslationStatus
} from "../schemas/chapter";

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export const ErrorCode = {
  LIBRARY_FOLDER_LOAD_FAILED: "LIBRARY_FOLDER_LOAD_FAILED",
  LIBRARY_FOLDER_CHOOSE_FAILED: "LIBRARY_FOLDER_CHOOSE_FAILED",
  LIBRARY_REPAIR_FAILED: "LIBRARY_REPAIR_FAILED",
  BACKUP_FAILED: "BACKUP_FAILED",
  RESTORE_FAILED: "RESTORE_FAILED",
  TRASH_FAILED: "TRASH_FAILED",
  SERIES_CRUD_FAILED: "SERIES_CRUD_FAILED",
  CATEGORY_CRUD_FAILED: "CATEGORY_CRUD_FAILED",
  VOLUME_CRUD_FAILED: "VOLUME_CRUD_FAILED",
  CHAPTER_CRUD_FAILED: "CHAPTER_CRUD_FAILED",
  IMPORT_FAILED: "IMPORT_FAILED",
  EXPORT_FAILED: "EXPORT_FAILED",
  SEARCH_FAILED: "SEARCH_FAILED",
  READING_STATE_FAILED: "READING_STATE_FAILED"
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const REQUIRED_LIBRARY_DIRECTORIES = ["index", "series", "backups", ".trash"] as const;
export const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
export const IMPORT_FILE_TYPES = {
  ".txt": "txt",
  ".md": "md",
  ".docx": "docx",
  ".pdf": "pdf"
} as const;

export const SUPPORTED_SCHEMA_VERSION = 1;
export type SupportedSchemaVersion = typeof SUPPORTED_SCHEMA_VERSION;
export const HIGHLIGHT_COLORS = ["yellow", "green", "pink", "blue"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const writeQueues = new Map<string, Promise<unknown>>();

export type VersionedMetadata = {
  schemaVersion: unknown;
};

export type AppSettings = {
  currentLibraryPath?: string;
};

export type LibraryMetadata = {
  schemaVersion: SupportedSchemaVersion;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type LibrarySettings = {
  schemaVersion: SupportedSchemaVersion;
  reading: {
    theme: "system" | "light" | "dark";
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
  };
  backup: {
    enabled: boolean;
  };
  import: {
    keepOriginalFiles: boolean;
  };
  updatedAt: string;
};

export type SeriesCard = {
  id: string;
  title: string;
  author: string | null;
  genres: string[];
  tags: string[];
  collections: SeriesCollection[];
  status: SeriesStatus;
  coverDataUrl: string | null;
};

export type SeriesDetailData = SeriesMetadata & {
  coverDataUrl: string | null;
};

export type ChapterReference = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
};

export type ReadingListEntry = ChapterReference & {
  scrollTop: number;
  updatedAt: string;
};

export type BookmarkEntry = ReadingListEntry & {
  createdAt: string;
};

export type HighlightEntry = ReadingListEntry & {
  id: string;
  text: string;
  textStart?: number;
  textEnd?: number;
  color: HighlightColor;
  note: string;
  createdAt: string;
};

export type TrashItemType = "series" | "category" | "volume" | "chapter";
export type TrashManifest = {
  schemaVersion: SupportedSchemaVersion;
  itemType: TrashItemType;
  itemId: string;
  title: string;
  deletedAt: string;
  seriesId: string | null;
  categoryId: string | null;
  volumeId: string | null;
  orderIndex: number;
};

export type ChapterContent = {
  html: string;
  text: string;
  wordCount: number;
  characterCount: number;
  updatedAt: string;
};

export type ChapterImageAsset = {
  src: string;
  dataUrl: string;
  fileName: string;
};

export type ChapterMetadata = NovelChapterMetadata;

export type ChapterOriginalPdf = {
  dataUrl: string;
  fileName: string;
};

export type ChapterOriginalText = {
  text: string;
  fileName: string;
  fileType: "md";
};

export type ChapterReadingProgress = {
  scrollTop: number;
  updatedAt: string | null;
};

export type ReadingProgressEntry = {
  scrollTop?: number;
  updatedAt: string | null;
};

export type SeriesProgress = {
  schemaVersion: SupportedSchemaVersion;
  chapters: Record<string, ReadingProgressEntry>;
};

export type SeriesBookmarks = {
  schemaVersion: SupportedSchemaVersion;
  entries: BookmarkEntry[];
};

export type SeriesHighlights = {
  schemaVersion: SupportedSchemaVersion;
  entries: HighlightEntry[];
};

export type JsonRecord = Record<string, unknown>;

export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function fail(code: ErrorCode, message: string, details?: unknown): ApiResponse<never> {
  return { ok: false, error: { code, message, details } };
}

export function assertSupportedSchemaVersion(fileName: string, metadata: VersionedMetadata): void {
  if (metadata.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion in ${fileName}: ${String(metadata.schemaVersion)}`);
  }
}

export function appSettingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export async function backupExistingFile(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function writeJsonFile(filePath: string, data: unknown, options: { backup?: boolean } = {}): Promise<void> {
  await withResourceWriteLock(filePath, async () => {
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    if (options.backup) {
      await backupExistingFile(filePath);
    }

    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  });
}

export async function writeTextFile(filePath: string, content: string, options: { backup?: boolean } = {}): Promise<void> {
  await withResourceWriteLock(filePath, async () => {
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    if (options.backup) {
      await backupExistingFile(filePath);
    }

    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  });
}

export async function withResourceWriteLock<T>(resourcePath: string, operation: () => Promise<T>): Promise<T> {
  const lockKey = resolve(resourcePath);
  const previousWrite = writeQueues.get(lockKey) ?? Promise.resolve();
  const nextWrite = previousWrite.catch(() => undefined).then(operation);

  writeQueues.set(lockKey, nextWrite);

  try {
    return await nextWrite;
  } finally {
    if (writeQueues.get(lockKey) === nextWrite) {
      writeQueues.delete(lockKey);
    }
  }
}

export async function readAppSettings(): Promise<AppSettings> {
  try {
    return await readJsonFile<AppSettings>(appSettingsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeAppSettings(settings: AppSettings): Promise<void> {
  await writeJsonFile(appSettingsPath(), settings, { backup: true });
}

export async function currentLibraryPathOrThrow(): Promise<string> {
  const settings = await readAppSettings();

  if (!settings.currentLibraryPath) {
    throw new Error("No Library folder selected.");
  }

  return settings.currentLibraryPath;
}

export async function ensureLibraryFolder(libraryPath: string): Promise<void> {
  await mkdir(libraryPath, { recursive: true });
}

export function libraryChildPath(libraryPath: string, ...parts: string[]): string {
  const libraryRoot = resolve(libraryPath);
  const targetPath = resolve(libraryRoot, ...parts);
  const relativePath = relative(libraryRoot, targetPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return targetPath;
  }

  throw new Error(`Refusing to access path outside Library root: ${targetPath}`);
}

export function assertRecord(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected object input.");
  }

  return input as JsonRecord;
}

export function readRequiredText(record: JsonRecord, fieldName: string): string {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  return value;
}

export function assertId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${fieldName} must be a safe id.`);
  }

  return value;
}

export function readRequiredString(record: JsonRecord, fieldName: string): string {
  const value = record[fieldName];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

export function readOptionalString(record: JsonRecord, fieldName: string, fallback: string): string {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  return value.trim();
}

export function readOptionalNullableString(record: JsonRecord, fieldName: string, fallback: string | null): string | null {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string or null.`);
  }

  return value.trim() || null;
}

export function readOptionalStringArray(record: JsonRecord, fieldName: string, fallback: string[]): string[] {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a string array.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

export function readRequiredIdArray(record: JsonRecord, fieldName: string): string[] {
  const value = record[fieldName];

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an id array.`);
  }

  const ids = value.map((item, index) => assertId(item, `${fieldName}[${index}]`));

  if (new Set(ids).size !== ids.length) {
    throw new Error(`${fieldName} must not contain duplicates.`);
  }

  return ids;
}

export function readOptionalNullableNumber(record: JsonRecord, fieldName: string, fallback: number | null): number | null {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer or null.`);
  }

  return value;
}

export function readOptionalInteger(record: JsonRecord, fieldName: string, fallback: number): number {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer.`);
  }

  return value;
}

export function readOptionalNonNegativeInteger(record: JsonRecord, fieldName: string, fallback: number): number {
  const value = readOptionalInteger(record, fieldName, fallback);

  if (value < 0) {
    throw new Error(`${fieldName} must be zero or greater.`);
  }

  return value;
}

export function readOptionalBoolean(record: JsonRecord, fieldName: string, fallback: boolean): boolean {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean.`);
  }

  return value;
}

export function readSeriesStatus(record: JsonRecord, fallback: SeriesStatus): SeriesStatus {
  const value = record.status;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (SERIES_STATUSES as readonly string[]).includes(value)) {
    return value as SeriesStatus;
  }

  throw new Error("status is invalid.");
}

export function readSeriesCollections(record: JsonRecord, fallback: SeriesCollection[]): SeriesCollection[] {
  const value = record.collections;

  if (value === undefined) {
    return fallback;
  }

  if (!Array.isArray(value) || value.some((item) => !SERIES_COLLECTIONS.includes(item as SeriesCollection))) {
    throw new Error("collections is invalid.");
  }

  return [...new Set(value as SeriesCollection[])];
}

export function readCategoryType(record: JsonRecord, fallback?: CategoryType): CategoryType {
  const value = record.type;

  if (value === undefined && fallback) {
    return fallback;
  }

  if (typeof value === "string" && (CATEGORY_TYPES as readonly string[]).includes(value)) {
    return value as CategoryType;
  }

  throw new Error("type is invalid.");
}

export function readNovelChapterType(record: JsonRecord, fallback: NovelChapterType): NovelChapterType {
  const value = record.type;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (NOVEL_CHAPTER_TYPES as readonly string[]).includes(value)) {
    return value as NovelChapterType;
  }

  throw new Error("type is invalid.");
}

export function readTranslationStatus(record: JsonRecord, fallback: TranslationStatus): TranslationStatus {
  const value = record.translationStatus;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (TRANSLATION_STATUSES as readonly string[]).includes(value)) {
    return value as TranslationStatus;
  }

  throw new Error("translationStatus is invalid.");
}

export function seriesDirectoryPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(libraryPath, "series", assertId(seriesId, "seriesId"));
}

export function seriesMetaPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(libraryPath, "series", assertId(seriesId, "seriesId"), "meta.json");
}

export function seriesProgressPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(seriesDirectoryPath(libraryPath, seriesId), "progress.json");
}

export function seriesBookmarksPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(seriesDirectoryPath(libraryPath, seriesId), "bookmarks.json");
}

export function seriesHighlightsPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(seriesDirectoryPath(libraryPath, seriesId), "highlights.json");
}

export function seriesIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "series-index.json");
}

export function searchIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "search-index.json");
}

export function recentIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "recent-index.json");
}

export function importLogPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "import.log");
}

export async function appendImportLog(libraryPath: string, message: string): Promise<void> {
  const filePath = importLogPath(libraryPath);

  try {
    await withResourceWriteLock(filePath, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await nodeAppendFile(filePath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
    });
  } catch {
    // ponytail: import logging must not make import fail.
  }
}

export function trashSeriesDirectoryPath(libraryPath: string, seriesId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return libraryChildPath(libraryPath, ".trash", `series-${assertId(seriesId, "seriesId")}-${timestamp}`);
}

export function trashItemDirectoryPath(libraryPath: string, itemType: string, itemId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return libraryChildPath(libraryPath, ".trash", `${itemType}-${assertId(itemId, "itemId")}-${timestamp}`);
}

export async function moveDirectorySafely(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") {
      throw error;
    }

    // fallback copy/remove inside Library
    await cp(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true });
    await rm(sourcePath, { recursive: true });
  }
}

export async function moveDirectoryToTrash(
  sourcePath: string,
  trashPath: string,
  manifest: TrashManifest
): Promise<void> {
  const manifestPath = join(sourcePath, "trash.json");
  await writeJsonFile(manifestPath, manifest);

  try {
    await moveDirectorySafely(sourcePath, trashPath);
  } catch (error) {
    await rm(manifestPath, { force: true });
    throw error;
  }
}

export function categoryDirectoryPath(libraryPath: string, seriesId: string, categoryId: string): string {
  return libraryChildPath(
    libraryPath,
    "series",
    assertId(seriesId, "seriesId"),
    "categories",
    assertId(categoryId, "categoryId")
  );
}

export function categoryMetaPath(libraryPath: string, seriesId: string, categoryId: string): string {
  return libraryChildPath(
    libraryPath,
    "series",
    assertId(seriesId, "seriesId"),
    "categories",
    assertId(categoryId, "categoryId"),
    "meta.json"
  );
}

export function volumeDirectoryPath(libraryPath: string, seriesId: string, categoryId: string, volumeId: string): string {
  return libraryChildPath(
    libraryPath,
    "series",
    assertId(seriesId, "seriesId"),
    "categories",
    assertId(categoryId, "categoryId"),
    "volumes",
    assertId(volumeId, "volumeId")
  );
}

export function volumeMetaPath(libraryPath: string, seriesId: string, categoryId: string, volumeId: string): string {
  return libraryChildPath(
    libraryPath,
    "series",
    assertId(seriesId, "seriesId"),
    "categories",
    assertId(categoryId, "categoryId"),
    "volumes",
    assertId(volumeId, "volumeId"),
    "meta.json"
  );
}

export function optionalVolumeId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return assertId(value, "volumeId");
}

export function chapterDirectoryPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  const baseParts = ["series", assertId(seriesId, "seriesId"), "categories", assertId(categoryId, "categoryId")];
  const chapterParts = volumeId
    ? ["volumes", assertId(volumeId, "volumeId"), "chapters", assertId(chapterId, "chapterId")]
    : ["chapters", assertId(chapterId, "chapterId")];

  return libraryChildPath(libraryPath, ...baseParts, ...chapterParts);
}

export function chapterMetaPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  return libraryChildPath(
    chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId),
    "meta.json"
  );
}

export function chapterContentPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  fileName: string
): string {
  return libraryChildPath(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), basename(fileName));
}

export function chapterAssetsDirectoryPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  return libraryChildPath(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), "assets");
}

export function chapterAssetPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  fileName: string
): string {
  return libraryChildPath(
    chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId),
    basename(fileName)
  );
}

export function pdfImageCheckPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  return libraryChildPath(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), ".pdf-images-checked");
}

export function isSafeImageFileName(fileName: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(fileName) && IMAGE_FILE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export function assertSafeImageFileName(fileName: string): string {
  if (!isSafeImageFileName(fileName)) {
    throw new Error("Image file name is invalid.");
  }

  return fileName;
}

export function chapterAssetSource(fileName: string): string {
  if (!isSafeImageFileName(fileName)) {
    throw new Error("Image file name is invalid.");
  }

  return `assets/${fileName}`;
}

export function imageFileNameFromAssetSource(source: string | null): string | null {
  if (!source) {
    return null;
  }

  const normalizedSource = source.replace(/\\/g, "/");
  const prefix = "assets/";

  if (!normalizedSource.startsWith(prefix)) {
    return null;
  }

  const fileName = normalizedSource.slice(prefix.length);
  return fileName === basename(fileName) && isSafeImageFileName(fileName) ? fileName : null;
}

export async function ensureLibraryDirectory(libraryPath: string, directoryName: string): Promise<void> {
  await mkdir(libraryChildPath(libraryPath, directoryName), { recursive: true });
}

export async function assertDirectory(directoryPath: string): Promise<void> {
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Expected directory: ${directoryPath}`);
  }
}
