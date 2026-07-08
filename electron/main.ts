import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import mammoth from "mammoth";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import { OPS, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  SERIES_METADATA_SCHEMA_VERSION,
  SERIES_STATUSES,
  type SeriesMetadata,
  type SeriesStatus
} from "./schemas/series";
import {
  CATEGORY_METADATA_SCHEMA_VERSION,
  CATEGORY_TYPES,
  type CategoryMetadata,
  type CategoryType
} from "./schemas/category";
import { VOLUME_METADATA_SCHEMA_VERSION, type VolumeMetadata } from "./schemas/volume";
import {
  CHAPTER_METADATA_SCHEMA_VERSION,
  NOVEL_CHAPTER_TYPES,
  TRANSLATION_STATUSES,
  type NovelChapterMetadata,
  type NovelChapterType,
  type TranslationStatus
} from "./schemas/chapter";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const ErrorCode = {
  LIBRARY_FOLDER_LOAD_FAILED: "LIBRARY_FOLDER_LOAD_FAILED",
  LIBRARY_FOLDER_CHOOSE_FAILED: "LIBRARY_FOLDER_CHOOSE_FAILED",
  LIBRARY_REPAIR_FAILED: "LIBRARY_REPAIR_FAILED",
  SERIES_CRUD_FAILED: "SERIES_CRUD_FAILED",
  CATEGORY_CRUD_FAILED: "CATEGORY_CRUD_FAILED",
  VOLUME_CRUD_FAILED: "VOLUME_CRUD_FAILED",
  CHAPTER_CRUD_FAILED: "CHAPTER_CRUD_FAILED",
  IMPORT_FAILED: "IMPORT_FAILED",
  SEARCH_FAILED: "SEARCH_FAILED",
  READING_STATE_FAILED: "READING_STATE_FAILED"
} as const;

const REQUIRED_LIBRARY_DIRECTORIES = ["index", "series", "backups", ".trash"] as const;
const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const IMPORT_FILE_TYPES = {
  ".txt": "txt",
  ".md": "md",
  ".docx": "docx",
  ".pdf": "pdf"
} as const;
const PDF_IMAGE_RENDER_SCALE = 2;
const PDF_IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat
]);
const SUPPORTED_SCHEMA_VERSION = 1;
const MAX_SEARCH_RESULTS = 50;
const SEARCH_SNIPPET_RADIUS = 90;
const MAX_RECENT_ENTRIES = 50;
const HIGHLIGHT_COLORS = ["yellow", "green", "pink", "blue"] as const;
const importSessions = new Map<string, ImportSession>();
const writeQueues = new Map<string, Promise<unknown>>();

type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
type SupportedSchemaVersion = typeof SUPPORTED_SCHEMA_VERSION;
type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
type VersionedMetadata = {
  schemaVersion: unknown;
};

type AppSettings = {
  currentLibraryPath?: string;
};

type LibraryMetadata = {
  schemaVersion: SupportedSchemaVersion;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type LibrarySettings = {
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

type ImportSession = {
  id: string;
  sourceFolderPath?: string;
  sourceFiles?: ImportSessionFile[];
  createdAt: string;
};

type ImportSessionFile = {
  fileId: string;
  name: string;
  relativePath: string;
  sourcePath: string;
  fileType: ImportFileType;
  sizeBytes: number;
};

type ImportTextFileType = (typeof IMPORT_FILE_TYPES)[keyof typeof IMPORT_FILE_TYPES];
type ImportFileType = ImportTextFileType | "images";

type ImportPreviewNode = {
  id: string;
  name: string;
  relativePath: string;
  kind: "volume" | "folder" | "chapter";
  fileType?: ImportFileType;
  sizeBytes?: number;
  children?: ImportPreviewNode[];
};

type ImportPreview = {
  importSessionId: string;
  sourceFolderName: string;
  generatedAt: string;
  nodes: ImportPreviewNode[];
  counts: {
    volumes: number;
    chapters: number;
    txt: number;
    md: number;
    docx: number;
    pdf: number;
    images: number;
  };
};

type ImportSourceFile = {
  fileId: string;
  relativePath: string;
  sourcePath: string;
  fileType: ImportFileType | null;
};

type ImportTextPreview = {
  fileId: string;
  sourceName: string;
  fileType: ImportTextFileType;
  text: string;
};

type ImportPlanChapter = {
  fileId: string;
  title: string;
  volumeTitle: string;
  text: string;
};

type PdfCanvas = {
  width: number;
  height: number;
  toBuffer(mimeType: "image/png"): Buffer;
};

type PdfCanvasEntry = {
  canvas: PdfCanvas;
  context: CanvasRenderingContext2D;
};

type PdfCanvasFactory = {
  create(width: number, height: number): PdfCanvasEntry;
  destroy(entry: PdfCanvasEntry): void;
};

type PdfImageImportResult = {
  html: string;
  count: number;
  error: string | null;
};

type ImportVolumeMode = "source" | "existing" | "none";

type ImportTarget =
  | {
      mode: "new";
      seriesTitle: string;
    }
  | {
      mode: "existing";
      seriesId: string;
      categoryId: string;
      volumeMode: ImportVolumeMode;
      volumeId: string | null;
    };

type ImportLogEntry = {
  status: "imported" | "unsupported" | "skipped" | "failed";
  fileId: string;
  title: string;
  message: string;
};

type ImportReport = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  imported: number;
  unsupported: number;
  skipped: number;
  failed: number;
  logs: ImportLogEntry[];
};

type SeriesIndex = {
  schemaVersion: SupportedSchemaVersion;
  generatedAt: string;
  series: Array<{
    id: string;
    title: string;
    author?: string | null;
    genres?: string[];
    status?: SeriesStatus;
    coverImage?: string | null;
    updatedAt?: string;
  }>;
};

type SeriesIndexEntry = SeriesIndex["series"][number];
type SeriesCard = {
  id: string;
  title: string;
  author: string | null;
  genres: string[];
  status: SeriesStatus;
  coverDataUrl: string | null;
};

type SeriesDetailData = SeriesMetadata & {
  coverDataUrl: string | null;
};

type SearchIndex = {
  schemaVersion: SupportedSchemaVersion;
  generatedAt: string;
  documents: SearchDocument[];
};

type SearchDocument = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
  text: string;
  updatedAt: string;
};

type SearchResult = Omit<SearchDocument, "text"> & {
  snippet: string;
};

type SearchIndexSummary = {
  documentCount: number;
  generatedAt: string;
};

type ChapterReference = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
};

type ReadingListEntry = ChapterReference & {
  scrollTop: number;
  updatedAt: string;
};

type RecentIndex = {
  schemaVersion: SupportedSchemaVersion;
  generatedAt: string;
  entries: ReadingListEntry[];
};

type BookmarkEntry = ReadingListEntry & {
  createdAt: string;
};

type SeriesBookmarks = {
  schemaVersion: SupportedSchemaVersion;
  entries: BookmarkEntry[];
};

type HighlightEntry = ReadingListEntry & {
  id: string;
  text: string;
  textStart?: number;
  textEnd?: number;
  color: HighlightColor;
  note: string;
  createdAt: string;
};

type SeriesHighlights = {
  schemaVersion: SupportedSchemaVersion;
  entries: HighlightEntry[];
};

type ChapterContent = {
  html: string;
  text: string;
  wordCount: number;
  characterCount: number;
  updatedAt: string;
};

type ChapterImageAsset = {
  src: string;
  dataUrl: string;
  fileName: string;
};

type ChapterMetadata = NovelChapterMetadata;

type ChapterOriginalPdf = {
  dataUrl: string;
  fileName: string;
};

type ChapterOriginalText = {
  text: string;
  fileName: string;
  fileType: "md";
};

type ChapterReadingProgress = {
  scrollTop: number;
  updatedAt: string | null;
};

type ReadingProgressEntry = {
  scrollTop?: number;
  updatedAt: string | null;
};

type SeriesProgress = {
  schemaVersion: SupportedSchemaVersion;
  chapters: Record<string, ReadingProgressEntry>;
};

type JsonRecord = Record<string, unknown>;

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail(code: ErrorCode, message: string, details?: unknown): ApiResponse<never> {
  return { ok: false, error: { code, message, details } };
}

function assertSupportedSchemaVersion(fileName: string, metadata: VersionedMetadata): void {
  if (metadata.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion in ${fileName}: ${String(metadata.schemaVersion)}`);
  }
}

function appSettingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function backupExistingFile(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeJsonFile(filePath: string, data: unknown, options: { backup?: boolean } = {}): Promise<void> {
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

async function writeTextFile(filePath: string, content: string, options: { backup?: boolean } = {}): Promise<void> {
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

async function withResourceWriteLock<T>(resourcePath: string, operation: () => Promise<T>): Promise<T> {
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

async function readAppSettings(): Promise<AppSettings> {
  try {
    return await readJsonFile<AppSettings>(appSettingsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeAppSettings(settings: AppSettings): Promise<void> {
  await writeJsonFile(appSettingsPath(), settings, { backup: true });
}

async function currentLibraryPathOrThrow(options: { ensureFiles?: boolean } = {}): Promise<string> {
  const settings = await readAppSettings();

  if (!settings.currentLibraryPath) {
    throw new Error("No Library folder selected.");
  }

  if (options.ensureFiles ?? true) {
    await ensureLibraryFiles(settings.currentLibraryPath);
  }

  return settings.currentLibraryPath;
}

async function ensureLibraryFolder(libraryPath: string): Promise<void> {
  await mkdir(libraryPath, { recursive: true });
}

function libraryChildPath(libraryPath: string, ...parts: string[]): string {
  const libraryRoot = resolve(libraryPath);
  const targetPath = resolve(libraryRoot, ...parts);
  const relativePath = relative(libraryRoot, targetPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return targetPath;
  }

  throw new Error(`Refusing to access path outside Library root: ${targetPath}`);
}

function assertRecord(input: unknown): JsonRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected object input.");
  }

  return input as JsonRecord;
}

function readRequiredText(record: JsonRecord, fieldName: string): string {
  const value = record[fieldName];

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  return value;
}

function assertId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${fieldName} must be a safe id.`);
  }

  return value;
}

function readRequiredString(record: JsonRecord, fieldName: string): string {
  const value = record[fieldName];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

function readOptionalString(record: JsonRecord, fieldName: string, fallback: string): string {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  return value.trim();
}

function readOptionalNullableString(record: JsonRecord, fieldName: string, fallback: string | null): string | null {
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

function readOptionalStringArray(record: JsonRecord, fieldName: string, fallback: string[]): string[] {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a string array.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function readRequiredIdArray(record: JsonRecord, fieldName: string): string[] {
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

function readOptionalNullableNumber(record: JsonRecord, fieldName: string, fallback: number | null): number | null {
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

function readOptionalInteger(record: JsonRecord, fieldName: string, fallback: number): number {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer.`);
  }

  return value;
}

function readOptionalNonNegativeInteger(record: JsonRecord, fieldName: string, fallback: number): number {
  const value = readOptionalInteger(record, fieldName, fallback);

  if (value < 0) {
    throw new Error(`${fieldName} must be zero or greater.`);
  }

  return value;
}

function readOptionalBoolean(record: JsonRecord, fieldName: string, fallback: boolean): boolean {
  const value = record[fieldName];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean.`);
  }

  return value;
}

function readSeriesStatus(record: JsonRecord, fallback: SeriesStatus): SeriesStatus {
  const value = record.status;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (SERIES_STATUSES as readonly string[]).includes(value)) {
    return value as SeriesStatus;
  }

  throw new Error("status is invalid.");
}

function readCategoryType(record: JsonRecord, fallback?: CategoryType): CategoryType {
  const value = record.type;

  if (value === undefined && fallback) {
    return fallback;
  }

  if (typeof value === "string" && (CATEGORY_TYPES as readonly string[]).includes(value)) {
    return value as CategoryType;
  }

  throw new Error("type is invalid.");
}

function readNovelChapterType(record: JsonRecord, fallback: NovelChapterType): NovelChapterType {
  const value = record.type;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (NOVEL_CHAPTER_TYPES as readonly string[]).includes(value)) {
    return value as NovelChapterType;
  }

  throw new Error("type is invalid.");
}

function readTranslationStatus(record: JsonRecord, fallback: TranslationStatus): TranslationStatus {
  const value = record.translationStatus;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value === "string" && (TRANSLATION_STATUSES as readonly string[]).includes(value)) {
    return value as TranslationStatus;
  }

  throw new Error("translationStatus is invalid.");
}

function seriesDirectoryPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(libraryPath, "series", assertId(seriesId, "seriesId"));
}

function seriesMetaPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(libraryPath, "series", assertId(seriesId, "seriesId"), "meta.json");
}

function seriesProgressPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(seriesDirectoryPath(libraryPath, seriesId), "progress.json");
}

function seriesBookmarksPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(seriesDirectoryPath(libraryPath, seriesId), "bookmarks.json");
}

function seriesHighlightsPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(seriesDirectoryPath(libraryPath, seriesId), "highlights.json");
}

function seriesIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "series-index.json");
}

function searchIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "search-index.json");
}

function recentIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "recent-index.json");
}

function trashSeriesDirectoryPath(libraryPath: string, seriesId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return libraryChildPath(libraryPath, ".trash", `series-${assertId(seriesId, "seriesId")}-${timestamp}`);
}

function trashItemDirectoryPath(libraryPath: string, itemType: string, itemId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return libraryChildPath(libraryPath, ".trash", `${itemType}-${assertId(itemId, "itemId")}-${timestamp}`);
}

function categoryDirectoryPath(libraryPath: string, seriesId: string, categoryId: string): string {
  return libraryChildPath(
    libraryPath,
    "series",
    assertId(seriesId, "seriesId"),
    "categories",
    assertId(categoryId, "categoryId")
  );
}

function categoryMetaPath(libraryPath: string, seriesId: string, categoryId: string): string {
  return libraryChildPath(
    libraryPath,
    "series",
    assertId(seriesId, "seriesId"),
    "categories",
    assertId(categoryId, "categoryId"),
    "meta.json"
  );
}

function volumeDirectoryPath(libraryPath: string, seriesId: string, categoryId: string, volumeId: string): string {
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

function volumeMetaPath(libraryPath: string, seriesId: string, categoryId: string, volumeId: string): string {
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

function optionalVolumeId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return assertId(value, "volumeId");
}

function chapterDirectoryPath(
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

function chapterMetaPath(
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

function chapterContentPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  fileName: string
): string {
  return libraryChildPath(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), basename(fileName));
}

function chapterAssetsDirectoryPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  return libraryChildPath(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), "assets");
}

function chapterAssetPath(
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

function isSafeImageFileName(fileName: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(fileName) && IMAGE_FILE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function assertSafeImageFileName(fileName: string): string {
  if (!isSafeImageFileName(fileName)) {
    throw new Error("Image file name is invalid.");
  }

  return fileName;
}

function chapterAssetSource(fileName: string): string {
  if (!isSafeImageFileName(fileName)) {
    throw new Error("Image file name is invalid.");
  }

  return `assets/${fileName}`;
}

function imageFileNameFromAssetSource(source: string | null): string | null {
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

async function ensureLibraryDirectory(libraryPath: string, directoryName: string): Promise<void> {
  await mkdir(libraryChildPath(libraryPath, directoryName), { recursive: true });
}

async function assertDirectory(directoryPath: string): Promise<void> {
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Expected directory: ${directoryPath}`);
  }
}

function sourceChildPath(sourceRootPath: string, ...parts: string[]): string {
  const sourceRoot = resolve(sourceRootPath);
  const targetPath = resolve(sourceRoot, ...parts);
  const relativePath = relative(sourceRoot, targetPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return targetPath;
  }

  throw new Error(`Refusing to access path outside import source: ${targetPath}`);
}

function importFileType(fileName: string): ImportFileType | null {
  return IMPORT_FILE_TYPES[extname(fileName).toLowerCase() as keyof typeof IMPORT_FILE_TYPES] ?? null;
}

function importFileId(relativeFilePath: string): string {
  return Buffer.from(relativeFilePath, "utf8").toString("base64url");
}

function importRelativePathFromId(fileId: unknown): string {
  const safeFileId = assertId(fileId, "fileId");
  const relativeFilePath = Buffer.from(safeFileId, "base64url").toString("utf8");
  const parts = relativeFilePath.split("/");

  if (
    !relativeFilePath ||
    relativeFilePath.includes("\\") ||
    relativeFilePath.includes("\0") ||
    isAbsolute(relativeFilePath) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Import file id is invalid.");
  }

  return relativeFilePath;
}

function isImportTextFileType(fileType: ImportFileType | null): fileType is ImportTextFileType {
  return fileType === "txt" || fileType === "md" || fileType === "docx" || fileType === "pdf";
}

function isImportableFileType(fileType: ImportFileType | null): fileType is ImportFileType {
  return isImportTextFileType(fileType) || fileType === "images";
}

function toImportRelativePath(parts: string[]): string {
  return parts.join("/");
}

function isIllustrationsDirectoryName(name: string): boolean {
  return /^illustrations?$/i.test(name.trim());
}

async function listImportImageFiles(directoryPath: string): Promise<Array<{ name: string; path: string; sizeBytes: number }>> {
  const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const files: Array<{ name: string; path: string; sizeBytes: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_FILE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue;
    }

    const path = join(directoryPath, entry.name);
    files.push({ name: entry.name, path, sizeBytes: (await stat(path)).size });
  }

  return files;
}

function hasChapterNode(node: ImportPreviewNode): boolean {
  return node.kind === "chapter" || (node.children?.some(hasChapterNode) ?? false);
}

function countImportPreview(nodes: ImportPreviewNode[]): ImportPreview["counts"] {
  const counts: ImportPreview["counts"] = { volumes: 0, chapters: 0, txt: 0, md: 0, docx: 0, pdf: 0, images: 0 };

  for (const node of nodes) {
    if (node.kind === "volume") {
      counts.volumes += 1;
    }

    if (node.kind === "chapter" && node.fileType) {
      counts.chapters += 1;
      counts[node.fileType] += 1;
    }

    if (node.children) {
      const childCounts = countImportPreview(node.children);
      counts.volumes += childCounts.volumes;
      counts.chapters += childCounts.chapters;
      counts.txt += childCounts.txt;
      counts.md += childCounts.md;
      counts.docx += childCounts.docx;
      counts.pdf += childCounts.pdf;
      counts.images += childCounts.images;
    }
  }

  return counts;
}

async function scanImportDirectory(sourceRootPath: string, parts: string[] = []): Promise<ImportPreviewNode[]> {
  const directoryPath = sourceChildPath(sourceRootPath, ...parts);
  const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const nodes: ImportPreviewNode[] = [];

  for (const entry of entries) {
    const childParts = [...parts, entry.name];
    const relativePath = toImportRelativePath(childParts);

    if (entry.isDirectory()) {
      if (isIllustrationsDirectoryName(entry.name)) {
        const imageFiles = await listImportImageFiles(sourceChildPath(sourceRootPath, ...childParts));

        if (imageFiles.length > 0) {
          nodes.push({
            id: importFileId(relativePath),
            name: entry.name,
            relativePath,
            kind: "chapter",
            fileType: "images",
            sizeBytes: imageFiles.reduce((total, file) => total + file.sizeBytes, 0)
          });
          continue;
        }
      }

      const children = await scanImportDirectory(sourceRootPath, childParts);

      if (children.length > 0) {
        nodes.push({
          id: importFileId(relativePath),
          name: entry.name,
          relativePath,
          kind: children.some((child) => child.kind === "chapter") ? "volume" : "folder",
          children
        });
      }

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileType = importFileType(entry.name);

    if (!fileType) {
      continue;
    }

    nodes.push({
      id: importFileId(relativePath),
      name: entry.name,
      relativePath,
      kind: "chapter",
      fileType,
      sizeBytes: (await stat(sourceChildPath(sourceRootPath, ...childParts))).size
    });
  }

  return nodes.filter(hasChapterNode);
}

function readImportSession(importSessionId: unknown): ImportSession {
  const session = importSessions.get(assertId(importSessionId, "importSessionId"));

  if (!session) {
    throw new Error("Import session not found.");
  }

  return session;
}

async function chooseImportSourceFolder(window: BrowserWindow | null): Promise<{ importSessionId: string; path: string; name: string } | null> {
  const options: OpenDialogOptions = {
    title: "Choose import source folder",
    properties: ["openDirectory"]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const sourceFolderPath = resolve(result.filePaths[0]);
  await assertDirectory(sourceFolderPath);

  const session: ImportSession = {
    id: randomUUID(),
    sourceFolderPath,
    createdAt: new Date().toISOString()
  };
  importSessions.set(session.id, session);

  return {
    importSessionId: session.id,
    path: sourceFolderPath,
    name: basename(sourceFolderPath)
  };
}

function uniqueImportRelativePath(filePath: string, usedPaths: Set<string>): string {
  const fileName = basename(filePath);

  if (!usedPaths.has(fileName)) {
    usedPaths.add(fileName);
    return fileName;
  }

  const extension = extname(fileName);
  const nameWithoutExtension = fileName.slice(0, fileName.length - extension.length);
  let index = 2;

  while (usedPaths.has(`${nameWithoutExtension} (${index})${extension}`)) {
    index += 1;
  }

  const relativePath = `${nameWithoutExtension} (${index})${extension}`;
  usedPaths.add(relativePath);
  return relativePath;
}

async function chooseImportSourceFiles(window: BrowserWindow | null): Promise<{ importSessionId: string; path: string; name: string } | null> {
  const options: OpenDialogOptions = {
    title: "Choose chapter files",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Novel chapter files", extensions: ["txt", "md", "docx", "pdf"] }]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const usedPaths = new Set<string>();
  const sourceFiles: ImportSessionFile[] = [];

  for (const filePath of result.filePaths.map((item) => resolve(item))) {
    const fileType = importFileType(filePath);
    const sourceStat = await stat(filePath);

    if (!fileType || !sourceStat.isFile()) {
      continue;
    }

    const relativePath = uniqueImportRelativePath(filePath, usedPaths);
    sourceFiles.push({
      fileId: importFileId(relativePath),
      name: basename(filePath),
      relativePath,
      sourcePath: filePath,
      fileType,
      sizeBytes: sourceStat.size
    });
  }

  if (sourceFiles.length === 0) {
    throw new Error("No supported chapter files were selected.");
  }

  const session: ImportSession = {
    id: randomUUID(),
    sourceFiles,
    createdAt: new Date().toISOString()
  };
  importSessions.set(session.id, session);

  return {
    importSessionId: session.id,
    path: sourceFiles.length === 1 ? sourceFiles[0].sourcePath : dirname(sourceFiles[0].sourcePath),
    name: sourceFiles.length === 1 ? sourceFiles[0].name : `${sourceFiles.length} chapter files`
  };
}

function scanImportFiles(session: ImportSession): ImportPreviewNode[] {
  return (session.sourceFiles ?? []).map((sourceFile) => ({
    id: sourceFile.fileId,
    name: sourceFile.name,
    relativePath: sourceFile.relativePath,
    kind: "chapter",
    fileType: sourceFile.fileType,
    sizeBytes: sourceFile.sizeBytes
  }));
}

async function scanImportSession(importSessionId: unknown): Promise<ImportPreview> {
  const session = readImportSession(importSessionId);
  const nodes = session.sourceFolderPath ? await scanImportDirectory(session.sourceFolderPath) : scanImportFiles(session);
  const sourceName = session.sourceFolderPath
    ? basename(session.sourceFolderPath)
    : session.sourceFiles?.length === 1
      ? session.sourceFiles[0].name
      : `${session.sourceFiles?.length ?? 0} chapter files`;

  return {
    importSessionId: session.id,
    sourceFolderName: sourceName,
    generatedAt: new Date().toISOString(),
    nodes,
    counts: countImportPreview(nodes)
  };
}

async function readImportSourceFile(session: ImportSession, fileId: unknown): Promise<ImportSourceFile> {
  const safeFileId = assertId(fileId, "fileId");

  if (session.sourceFiles) {
    const sourceFile = session.sourceFiles.find((item) => item.fileId === safeFileId);

    if (!sourceFile) {
      throw new Error("Import source file not found.");
    }

    return {
      fileId: safeFileId,
      relativePath: sourceFile.relativePath,
      sourcePath: sourceFile.sourcePath,
      fileType: sourceFile.fileType
    };
  }

  if (!session.sourceFolderPath) {
    throw new Error("Import session has no source folder.");
  }

  const relativePath = importRelativePathFromId(safeFileId);
  const sourcePath = sourceChildPath(session.sourceFolderPath, ...relativePath.split("/"));
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory() && isIllustrationsDirectoryName(basename(relativePath))) {
    const imageFiles = await listImportImageFiles(sourcePath);

    if (imageFiles.length > 0) {
      return {
        fileId: safeFileId,
        relativePath,
        sourcePath,
        fileType: "images"
      };
    }
  }

  if (!sourceStat.isFile()) {
    throw new Error("Import source is not a file.");
  }

  return {
    fileId: safeFileId,
    relativePath,
    sourcePath,
    fileType: importFileType(relativePath)
  };
}

function normalizeImportText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function stripPdfPageMarkers(text: string): string {
  const lines = normalizeImportText(text).split("\n");
  const removeIndexes = new Set<number>();
  const pageMarkerPattern = /^[-\s]*(?:page\s*)?(\d+)\s*(?:of|\/)\s*(\d+)[-\s]*$/i;

  lines.forEach((line, index) => {
    const match = line.trim().match(pageMarkerPattern);
    if (!match) {
      return;
    }

    removeIndexes.add(index);

    for (const neighbor of [index - 2, index - 1, index + 1, index + 2]) {
      if (lines[neighbor]?.trim() === match[1]) {
        removeIndexes.add(neighbor);
      }
    }
  });

  return lines.filter((_, index) => !removeIndexes.has(index)).join("\n");
}

async function extractPdfTextWithPdfParse(sourcePath: string): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(await readFile(sourcePath)) });

  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

function isPdfTextItem(item: unknown): item is { str: string } {
  return !!item && typeof item === "object" && typeof (item as { str?: unknown }).str === "string";
}

async function extractPdfTextWithPdfjs(sourcePath: string): Promise<string> {
  const loadingTask = getDocument({ data: new Uint8Array(await readFile(sourcePath)) });
  const pdf = await loadingTask.promise;

  try {
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = (textContent.items.filter(isPdfTextItem) as Array<{ str: string }>)
        .map((item) => item.str)
        .join(" ")
        .trim();

      if (pageText) {
        pages.push(pageText);
      }
    }

    return pages.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

async function extractPdfText(sourcePath: string): Promise<string> {
  try {
    return stripPdfPageMarkers(await extractPdfTextWithPdfParse(sourcePath));
  } catch {
    // ponytail: fallback only when the primary parser throws; richer diagnostics can wait for import history.
    return stripPdfPageMarkers(await extractPdfTextWithPdfjs(sourcePath));
  }
}

async function readImportSourceText(sourceFile: ImportSourceFile): Promise<string> {
  if (sourceFile.fileType === "txt" || sourceFile.fileType === "md") {
    return readFile(sourceFile.sourcePath, "utf8");
  }

  if (sourceFile.fileType === "docx") {
    return (await mammoth.extractRawText({ path: sourceFile.sourcePath })).value;
  }

  if (sourceFile.fileType === "pdf") {
    return extractPdfText(sourceFile.sourcePath);
  }

  throw new Error("Import file type is not supported.");
}

async function readImportTextPreview(importSessionId: unknown, fileId: unknown): Promise<ImportTextPreview> {
  const sourceFile = await readImportSourceFile(readImportSession(importSessionId), fileId);

  if (!isImportTextFileType(sourceFile.fileType)) {
    throw new Error("Only TXT, MD, DOCX, and PDF files can be edited in this import step.");
  }

  return {
    fileId: sourceFile.fileId,
    sourceName: basename(sourceFile.relativePath),
    fileType: sourceFile.fileType,
    text: normalizeImportText(await readImportSourceText(sourceFile))
  };
}

function escapeImportText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownInlineToHtml(text: string): string {
  return escapeImportText(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"'<]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, '$1<a href="$2">$2</a>');
}

function markdownImageToHtml(line: string): string | null {
  const image = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s"'<]+)\)$/);

  return image ? `<p><img alt="${escapeHtmlAttribute(image[1])}" src="${escapeHtmlAttribute(image[2])}"></p>` : null;
}

function endsWithSentenceBreak(line: string): boolean {
  return /[.!?…。！？]["')\]}»”’]*$/.test(line.trim());
}

function importBlockToParagraphs(block: string): string[] {
  const paragraphs: string[] = [];
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let paragraph = "";

  for (const line of lines) {
    if (!paragraph) {
      paragraph = line;
      continue;
    }

    if (endsWithSentenceBreak(paragraph)) {
      paragraphs.push(paragraph);
      paragraph = line;
      continue;
    }

    paragraph = `${paragraph} ${line}`;
  }

  if (paragraph) {
    paragraphs.push(paragraph);
  }

  return paragraphs;
}

function importTextToHtml(text: string): string {
  const normalized = normalizeImportText(text).trim();

  if (!normalized) {
    return "<p></p>";
  }

  return normalized
    .split(/\n{2,}/)
    .flatMap(importBlockToParagraphs)
    .map((paragraph) => `<p>${escapeImportText(paragraph)}</p>`)
    .join("\n");
}

function importMarkdownToHtml(text: string): string {
  // ponytail: basic Markdown for chapter imports; use a real parser if tables, nested lists, or Obsidian embeds matter.
  const normalized = normalizeImportText(text).trim();

  if (!normalized) {
    return "<p></p>";
  }

  const html: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }

    html.push(`<p>${markdownInlineToHtml(paragraphLines.join(" "))}</p>`);
    paragraphLines = [];
  };
  const flushList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushCodeBlock = (): void => {
    html.push(`<pre><code>${escapeImportText(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    inCodeBlock = false;
  };

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const imageHtml = markdownImageToHtml(line);
    if (imageHtml) {
      flushParagraph();
      flushList();
      html.push(imageHtml);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h${heading[1].length}>${markdownInlineToHtml(heading[2].trim())}</h${heading[1].length}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      html.push(`<blockquote><p>${markdownInlineToHtml(line.slice(2).trim())}</p></blockquote>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    const nextListType = unordered ? "ul" : ordered ? "ol" : null;
    if (nextListType) {
      flushParagraph();
      if (listType !== nextListType) {
        flushList();
        listType = nextListType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${markdownInlineToHtml((unordered?.[1] ?? ordered?.[1] ?? "").trim())}</li>`);
      continue;
    }

    paragraphLines.push(line);
  }

  if (inCodeBlock) {
    flushCodeBlock();
  }
  flushParagraph();
  flushList();

  return html.join("\n");
}

function importChapterTextToHtml(text: string, fileType: ImportFileType | null): string {
  return fileType === "md" ? importMarkdownToHtml(text) : importTextToHtml(text);
}

function readImportPlanChapter(input: unknown): ImportPlanChapter {
  const record = assertRecord(input);
  const fileId = assertId(record.fileId, "fileId");
  const fallbackTitle = basename(importRelativePathFromId(fileId)).replace(/\.[^.]+$/, "");

  return {
    fileId,
    title: readRequiredText(record, "title").trim() || fallbackTitle,
    volumeTitle: readRequiredText(record, "volumeTitle").trim() || "Imported",
    text: readRequiredText(record, "text")
  };
}

function readImportVolumeMode(value: unknown): ImportVolumeMode {
  if (value === undefined) {
    return "source";
  }

  if (value === "source" || value === "existing" || value === "none") {
    return value;
  }

  throw new Error("volumeMode is invalid.");
}

function readImportTarget(rootRecord: JsonRecord): ImportTarget {
  if (rootRecord.target === undefined) {
    return { mode: "new", seriesTitle: readRequiredString(rootRecord, "seriesTitle") };
  }

  const record = assertRecord(rootRecord.target);
  const mode = readRequiredText(record, "mode").trim();

  if (mode === "new") {
    const seriesTitle =
      typeof record.seriesTitle === "string" && record.seriesTitle.trim()
        ? record.seriesTitle.trim()
        : readRequiredString(rootRecord, "seriesTitle");
    return { mode, seriesTitle };
  }

  if (mode === "existing") {
    const volumeMode = readImportVolumeMode(record.volumeMode);
    return {
      mode,
      seriesId: assertId(record.seriesId, "seriesId"),
      categoryId: assertId(record.categoryId, "categoryId"),
      volumeMode,
      volumeId: volumeMode === "existing" ? assertId(record.volumeId, "volumeId") : null
    };
  }

  throw new Error("target.mode is invalid.");
}

function readImportPlan(input: unknown): { target: ImportTarget; chapters: ImportPlanChapter[] } {
  const record = assertRecord(input);
  const chapters = record.chapters;

  if (!Array.isArray(chapters)) {
    throw new Error("chapters must be an array.");
  }

  return {
    target: readImportTarget(record),
    chapters: chapters.map(readImportPlanChapter)
  };
}

async function copyImportedPdf(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourcePath: string
): Promise<void> {
  const targetPath = chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.pdf");
  const tmpPath = `${targetPath}.tmp`;

  await copyFile(sourcePath, tmpPath);
  await rename(tmpPath, targetPath);
}

function pdfCanvasFactory(pdf: PDFDocumentProxy): PdfCanvasFactory {
  const factory = pdf.canvasFactory as Partial<PdfCanvasFactory>;

  if (typeof factory.create !== "function" || typeof factory.destroy !== "function") {
    throw new Error("PDF canvas factory is not available.");
  }

  return factory as PdfCanvasFactory;
}

async function pdfPageHasImages(page: PDFPageProxy): Promise<boolean> {
  const operatorList = await page.getOperatorList();
  return operatorList.fnArray.some((operator) => PDF_IMAGE_OPERATORS.has(operator));
}

async function importPdfPageImages(
  factory: PdfCanvasFactory,
  page: PDFPageProxy,
  pageNumber: number,
  writeImage: (fileName: string, image: Buffer) => Promise<void>
): Promise<string[]> {
  try {
    if (!(await pdfPageHasImages(page))) {
      return [];
    }

    const viewport = page.getViewport({ scale: PDF_IMAGE_RENDER_SCALE });
    const pageCanvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));

    try {
      const renderTask = page.render({
        canvas: pageCanvas.canvas as unknown as HTMLCanvasElement,
        canvasContext: pageCanvas.context,
        viewport
      });
      await renderTask.promise;

      const fileName = `${randomUUID()}.png`;
      await writeImage(fileName, pageCanvas.canvas.toBuffer("image/png"));
      return [`<p><img alt="PDF page ${pageNumber}" src="${escapeHtmlAttribute(chapterAssetSource(fileName))}"></p>`];
    } finally {
      factory.destroy(pageCanvas);
    }
  } finally {
    page.cleanup();
  }
}

async function copyImportedPdfImages(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourcePath: string
): Promise<PdfImageImportResult> {
  try {
    const loadingTask = getDocument({ data: new Uint8Array(await readFile(sourcePath)) });
    const pdf = await loadingTask.promise;

    try {
      const factory = pdfCanvasFactory(pdf);
      const html: string[] = [];
      await mkdir(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), { recursive: true });

      const writeImage = async (fileName: string, image: Buffer): Promise<void> => {
        const targetPath = chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
        const tmpPath = `${targetPath}.tmp`;

        await writeFile(tmpPath, image);
        await rename(tmpPath, targetPath);
      };

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        html.push(...(await importPdfPageImages(factory, await pdf.getPage(pageNumber), pageNumber, writeImage)));
      }

      return { html: html.join("\n"), count: html.length, error: null };
    } finally {
      await loadingTask.destroy();
    }
  } catch (error) {
    // ponytail: PDF images are best-effort; original.pdf remains the fallback source.
    return { html: "", count: 0, error: String(error) };
  }
}

async function copyImportedMarkdown(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourcePath: string
): Promise<void> {
  const targetPath = chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.md");
  const tmpPath = `${targetPath}.tmp`;

  await copyFile(sourcePath, tmpPath);
  await rename(tmpPath, targetPath);
}

async function copyImportedIllustrations(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourceDirectoryPath: string
): Promise<string> {
  const imageFiles = await listImportImageFiles(sourceDirectoryPath);

  if (imageFiles.length === 0) {
    throw new Error("Illustrations folder has no supported images.");
  }

  await mkdir(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), { recursive: true });

  const html: string[] = [];
  for (const image of imageFiles) {
    const extension = extname(image.name).toLowerCase();
    const fileName = `${randomUUID()}${extension}`;
    const targetPath = chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
    const tmpPath = `${targetPath}.tmp`;

    await copyFile(image.path, tmpPath);
    await rename(tmpPath, targetPath);
    html.push(
      `<p><img alt="${escapeHtmlAttribute(basename(image.name, extension))}" src="${escapeHtmlAttribute(chapterAssetSource(fileName))}"></p>`
    );
  }

  return html.join("\n");
}

async function prepareImportDestination(
  libraryPath: string,
  target: ImportTarget
): Promise<{
  series: SeriesMetadata;
  category: CategoryMetadata;
  volumeMode: ImportVolumeMode;
  fixedVolume: VolumeMetadata | null;
  volumes: Map<string, VolumeMetadata>;
}> {
  if (target.mode === "new") {
    const series = await createSeriesMetadata(libraryPath, { title: target.seriesTitle });
    const category = await createCategoryMetadata(libraryPath, series.id, { type: "light-novel", title: "Light Novel" });
    return { series, category, volumeMode: "source", fixedVolume: null, volumes: new Map() };
  }

  const series = await readSeriesMetadata(libraryPath, target.seriesId);
  const category = await readCategoryMetadata(libraryPath, series.id, target.categoryId);

  if (target.volumeMode === "none") {
    if (category.type !== "web-novel") {
      throw new Error("Direct category import is only for web-novel categories.");
    }

    return { series, category, volumeMode: "none", fixedVolume: null, volumes: new Map() };
  }

  if (target.volumeMode === "existing") {
    if (!target.volumeId) {
      throw new Error("volumeId is required when importing into an existing volume.");
    }

    const fixedVolume = await readVolumeMetadata(libraryPath, series.id, category.id, target.volumeId);
    return { series, category, volumeMode: "existing", fixedVolume, volumes: new Map([[fixedVolume.title, fixedVolume]]) };
  }

  const volumes = new Map((await listVolumeMetadata(libraryPath, series.id, category.id)).map((volume) => [volume.title, volume]));
  return { series, category, volumeMode: "source", fixedVolume: null, volumes };
}

async function executeImport(libraryPath: string, importSessionId: unknown, input: unknown): Promise<ImportReport> {
  const session = readImportSession(importSessionId);
  const plan = readImportPlan(input);
  const logs: ImportLogEntry[] = [];
  const importableChapters: Array<ImportPlanChapter & { sourceFile: ImportSourceFile }> = [];

  for (const chapter of plan.chapters) {
    try {
      const sourceFile = await readImportSourceFile(session, chapter.fileId);

      if (!isImportableFileType(sourceFile.fileType)) {
        logs.push({
          status: "skipped",
          fileId: chapter.fileId,
          title: chapter.title,
          message: `${sourceFile.relativePath} is not supported in this step.`
        });
        continue;
      }

      importableChapters.push({ ...chapter, sourceFile });
    } catch (error) {
      logs.push({
        status: "failed",
        fileId: chapter.fileId,
        title: chapter.title,
        message: String(error)
      });
    }
  }

  if (importableChapters.length === 0) {
    throw new Error("No TXT, MD, DOCX, PDF, or illustrations chapters could be imported.");
  }

  const destination = await prepareImportDestination(libraryPath, plan.target);
  const { series, category, volumes } = destination;
  let imported = 0;

  for (const chapter of importableChapters) {
    try {
      let volume: VolumeMetadata | null = destination.fixedVolume;

      if (!volume && destination.volumeMode === "source") {
        volume = volumes.get(chapter.volumeTitle) ?? null;
      }

      if (!volume && destination.volumeMode === "source") {
        volume = await createVolumeMetadata(libraryPath, series.id, category.id, { title: chapter.volumeTitle });
        volumes.set(chapter.volumeTitle, volume);
      }

      const volumeId = volume?.id ?? null;

      const metadata = await createNovelChapterMetadata(libraryPath, series.id, category.id, volumeId, {
        title: chapter.title,
        translationStatus: "draft",
        hasOriginalPdf: chapter.sourceFile.fileType === "pdf",
        originalFileName:
          chapter.sourceFile.fileType === "pdf" || chapter.sourceFile.fileType === "md"
            ? basename(chapter.sourceFile.relativePath)
            : null
      });

      let html = importChapterTextToHtml(chapter.text, chapter.sourceFile.fileType);
      let pdfImages: PdfImageImportResult = { html: "", count: 0, error: null };

      if (chapter.sourceFile.fileType === "images") {
        html = await copyImportedIllustrations(
          libraryPath,
          series.id,
          category.id,
          volumeId,
          metadata.id,
          chapter.sourceFile.sourcePath
        );
      } else if (chapter.sourceFile.fileType === "pdf") {
        await copyImportedPdf(libraryPath, series.id, category.id, volumeId, metadata.id, chapter.sourceFile.sourcePath);
        pdfImages = await copyImportedPdfImages(
          libraryPath,
          series.id,
          category.id,
          volumeId,
          metadata.id,
          chapter.sourceFile.sourcePath
        );
        html = [pdfImages.html, html].filter(Boolean).join("\n");
      } else if (chapter.sourceFile.fileType === "md") {
        await copyImportedMarkdown(libraryPath, series.id, category.id, volumeId, metadata.id, chapter.sourceFile.sourcePath);
      }

      await saveNovelChapterContent(libraryPath, series.id, category.id, volumeId, metadata.id, {
        html
      });
      imported += 1;
      const unsupportedPdf =
        chapter.sourceFile.fileType === "pdf" && normalizeImportText(chapter.text).trim() === "" && pdfImages.count === 0;
      logs.push({
        status: unsupportedPdf ? "unsupported" : "imported",
        fileId: chapter.fileId,
        title: chapter.title,
        message:
          chapter.sourceFile.fileType === "pdf"
            ? unsupportedPdf
              ? `Saved original PDF ${chapter.sourceFile.relativePath}; no extractable text or images were found.`
              : `Imported ${chapter.sourceFile.relativePath} and saved original PDF${pdfImages.count > 0 ? ` with ${pdfImages.count} image pages` : ""}.${pdfImages.error ? ` Image extraction warning: ${pdfImages.error}` : ""}`
            : chapter.sourceFile.fileType === "images"
              ? `Imported illustrations from ${chapter.sourceFile.relativePath}.`
            : `Imported ${chapter.sourceFile.relativePath}.`
      });
    } catch (error) {
      logs.push({
        status: "failed",
        fileId: chapter.fileId,
        title: chapter.title,
        message: String(error)
      });
    }
  }

  return {
    seriesId: series.id,
    seriesTitle: series.title,
    categoryId: category.id,
    imported,
    unsupported: logs.filter((entry) => entry.status === "unsupported").length,
    skipped: logs.filter((entry) => entry.status === "skipped").length,
    failed: logs.filter((entry) => entry.status === "failed").length,
    logs
  };
}

async function ensureJsonFile(filePath: string, createData: () => unknown): Promise<void> {
  try {
    await readJsonFile(filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await writeJsonFile(filePath, createData());
}

async function ensureLibraryJson(libraryPath: string): Promise<void> {
  await ensureLibraryFolder(libraryPath);

  const filePath = libraryChildPath(libraryPath, "library.json");
  await ensureJsonFile(filePath, (): LibraryMetadata => {
    const now = new Date().toISOString();

    return {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      name: basename(libraryPath),
      createdAt: now,
      updatedAt: now
    };
  });
}

async function ensureLibrarySettingsJson(libraryPath: string): Promise<void> {
  await ensureLibraryFolder(libraryPath);

  const filePath = libraryChildPath(libraryPath, "settings.json");
  await ensureJsonFile(filePath, (): LibrarySettings => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    reading: {
      theme: "system",
      fontFamily: "system",
      fontSize: 18,
      lineHeight: 1.7
    },
    backup: {
      enabled: false
    },
    import: {
      keepOriginalFiles: true
    },
    updatedAt: new Date().toISOString()
  }));
}

async function ensureLibraryFiles(libraryPath: string): Promise<void> {
  await ensureLibraryJson(libraryPath);
  await ensureLibrarySettingsJson(libraryPath);
  for (const directoryName of REQUIRED_LIBRARY_DIRECTORIES) {
    await ensureLibraryDirectory(libraryPath, directoryName);
  }
  await ensureSearchIndexJson(libraryPath);
  await ensureRecentIndexJson(libraryPath);
  await checkLibraryHealth(libraryPath);
  await rebuildSeriesIndex(libraryPath);
}

async function checkLibraryHealth(libraryPath: string): Promise<void> {
  const libraryMetadata = await readJsonFile<VersionedMetadata>(libraryChildPath(libraryPath, "library.json"));
  const librarySettings = await readJsonFile<VersionedMetadata>(libraryChildPath(libraryPath, "settings.json"));

  assertSupportedSchemaVersion("library.json", libraryMetadata);
  assertSupportedSchemaVersion("settings.json", librarySettings);

  for (const directoryName of REQUIRED_LIBRARY_DIRECTORIES) {
    await assertDirectory(libraryChildPath(libraryPath, directoryName));
  }
}

async function rebuildSeriesIndex(libraryPath: string): Promise<void> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const series: SeriesIndex["series"] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readJsonFile<Record<string, unknown>>(
        libraryChildPath(libraryPath, "series", entry.name, "meta.json")
      );
      if (typeof metadata.id === "string" && typeof metadata.title === "string") {
        series.push({
          id: metadata.id,
          title: metadata.title,
          author:
            typeof metadata.originalAuthor === "string"
              ? metadata.originalAuthor
              : typeof metadata.translator === "string"
                ? metadata.translator
                : null,
          genres: Array.isArray(metadata.genres)
            ? metadata.genres.filter((genre): genre is string => typeof genre === "string")
            : [],
          status:
            typeof metadata.status === "string" && (SERIES_STATUSES as readonly string[]).includes(metadata.status)
              ? (metadata.status as SeriesStatus)
              : "planning",
          coverImage: typeof metadata.coverImage === "string" ? metadata.coverImage : null,
          updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : undefined
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await writeJsonFile(seriesIndexPath(libraryPath), {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    series: series.sort((left, right) => left.title.localeCompare(right.title))
  } satisfies SeriesIndex);
}

async function ensureSearchIndexJson(libraryPath: string): Promise<void> {
  await ensureJsonFile(searchIndexPath(libraryPath), (): SearchIndex => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documents: []
  }));
}

async function ensureRecentIndexJson(libraryPath: string): Promise<void> {
  await ensureJsonFile(recentIndexPath(libraryPath), (): RecentIndex => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    entries: []
  }));
}

function summarizeSearchIndex(index: SearchIndex): SearchIndexSummary {
  return {
    documentCount: index.documents.length,
    generatedAt: index.generatedAt
  };
}

function compareSearchDocuments(left: SearchDocument, right: SearchDocument): number {
  return (
    left.seriesTitle.localeCompare(right.seriesTitle) ||
    left.categoryTitle.localeCompare(right.categoryTitle) ||
    (left.volumeTitle ?? "").localeCompare(right.volumeTitle ?? "") ||
    left.chapterTitle.localeCompare(right.chapterTitle)
  );
}

async function readSearchIndex(libraryPath: string): Promise<SearchIndex> {
  try {
    const index = await readJsonFile<SearchIndex>(searchIndexPath(libraryPath));
    assertSupportedSchemaVersion("search-index.json", index);
    return Array.isArray(index.documents) ? index : { ...index, documents: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return rebuildSearchIndex(libraryPath);
  }
}

async function toSearchDocument(
  libraryPath: string,
  series: SeriesMetadata,
  category: CategoryMetadata,
  volume: VolumeMetadata | null,
  chapter: NovelChapterMetadata
): Promise<SearchDocument> {
  return {
    seriesId: series.id,
    seriesTitle: series.title,
    categoryId: category.id,
    categoryTitle: category.title,
    volumeId: volume?.id ?? null,
    volumeTitle: volume?.title ?? null,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    text: await readOptionalTextFile(
      chapterContentPath(libraryPath, series.id, category.id, volume?.id ?? null, chapter.id, chapter.plainTextFile)
    ),
    updatedAt: chapter.updatedAt
  };
}

async function rebuildSearchIndex(libraryPath: string): Promise<SearchIndex> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const documents: SearchDocument[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const series = await readSeriesMetadata(libraryPath, entry.name);
      const categories = await listCategoryMetadata(libraryPath, series.id);

      for (const category of categories) {
        if (category.type === "web-novel") {
          const chapters = await listNovelChapterMetadata(libraryPath, series.id, category.id, null);
          for (const chapter of chapters) {
            documents.push(await toSearchDocument(libraryPath, series, category, null, chapter));
          }
        }

        const volumes = await listVolumeMetadata(libraryPath, series.id, category.id);
        for (const volume of volumes) {
          const chapters = await listNovelChapterMetadata(libraryPath, series.id, category.id, volume.id);
          for (const chapter of chapters) {
            documents.push(await toSearchDocument(libraryPath, series, category, volume, chapter));
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const index: SearchIndex = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documents: documents.sort(compareSearchDocuments)
  };

  await writeJsonFile(searchIndexPath(libraryPath), index, { backup: true });
  return index;
}

async function upsertSearchDocument(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapter: NovelChapterMetadata,
  text: string
): Promise<void> {
  const [series, category, volume] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    readCategoryMetadata(libraryPath, seriesId, categoryId),
    volumeId ? readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId) : Promise.resolve(null)
  ]);
  const filePath = searchIndexPath(libraryPath);

  await ensureSearchIndexJson(libraryPath);
  await withResourceWriteLock(filePath, async () => {
    const current = await readJsonFile<SearchIndex>(filePath);
    assertSupportedSchemaVersion("search-index.json", current);

    const document: SearchDocument = {
      seriesId: series.id,
      seriesTitle: series.title,
      categoryId: category.id,
      categoryTitle: category.title,
      volumeId: volume?.id ?? null,
      volumeTitle: volume?.title ?? null,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      text,
      updatedAt: chapter.updatedAt
    };
    const index: SearchIndex = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      documents: [
        ...current.documents.filter(
          (item) =>
            item.seriesId !== series.id ||
            item.categoryId !== category.id ||
            item.volumeId !== (volume?.id ?? null) ||
            item.chapterId !== chapter.id
        ),
        document
      ].sort(compareSearchDocuments)
    };
    const tmpPath = `${filePath}.tmp`;

    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  });
}

function searchSnippet(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIndex + queryLength + SEARCH_SNIPPET_RADIUS);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`;
}

async function searchLibrary(libraryPath: string, queryInput: unknown): Promise<SearchResult[]> {
  if (typeof queryInput !== "string") {
    throw new Error("query must be a string.");
  }

  const query = queryInput.trim();
  if (!query) {
    return [];
  }

  let index = await readSearchIndex(libraryPath);
  if (index.documents.length === 0) {
    index = await rebuildSearchIndex(libraryPath);
  }

  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const document of index.documents) {
    const searchable = [
      document.seriesTitle,
      document.categoryTitle,
      document.volumeTitle ?? "",
      document.chapterTitle,
      document.text
    ]
      .join("\n")
      .toLowerCase();

    if (!searchable.includes(lowerQuery)) {
      continue;
    }

    const textIndex = document.text.toLowerCase().indexOf(lowerQuery);
    const { text: _text, ...result } = document;
    results.push({
      ...result,
      snippet:
        textIndex >= 0
          ? searchSnippet(document.text, textIndex, query.length)
          : document.chapterTitle || document.volumeTitle || document.seriesTitle
    });

    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }

  return results;
}

function compareReadingListEntries(left: ReadingListEntry, right: ReadingListEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function sameChapterReference(left: ChapterReference, right: ChapterReference): boolean {
  return (
    left.seriesId === right.seriesId &&
    left.categoryId === right.categoryId &&
    left.volumeId === right.volumeId &&
    left.chapterId === right.chapterId
  );
}

function parseChapterProgressKey(key: string): { categoryId: string; volumeId: string | null; chapterId: string } | null {
  const parts = key.split("/");

  if (parts.length !== 3) {
    return null;
  }

  const [categoryId, volumePart, chapterId] = parts;
  const safeId = /^[a-zA-Z0-9_-]+$/;

  if (!safeId.test(categoryId) || !safeId.test(chapterId) || (volumePart !== "direct" && !safeId.test(volumePart))) {
    return null;
  }

  return { categoryId, volumeId: volumePart === "direct" ? null : volumePart, chapterId };
}

async function readChapterReference(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterReference> {
  const [series, category, chapter] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    readCategoryMetadata(libraryPath, seriesId, categoryId),
    readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId)
  ]);
  const volume = volumeId ? await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId) : null;

  return {
    seriesId: series.id,
    seriesTitle: series.title,
    categoryId: category.id,
    categoryTitle: category.title,
    volumeId: volume?.id ?? null,
    volumeTitle: volume?.title ?? null,
    chapterId: chapter.id,
    chapterTitle: chapter.title
  };
}

async function rebuildRecentIndex(libraryPath: string): Promise<RecentIndex> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const recentEntries: ReadingListEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      await readSeriesMetadata(libraryPath, entry.name);
      const progress = await readSeriesProgress(libraryPath, entry.name);

      for (const [key, item] of Object.entries(progress.chapters)) {
        const target = parseChapterProgressKey(key);

        if (!target || !item.updatedAt || typeof item.scrollTop !== "number") {
          continue;
        }

        try {
          recentEntries.push({
            ...(await readChapterReference(libraryPath, entry.name, target.categoryId, target.volumeId, target.chapterId)),
            scrollTop: item.scrollTop,
            updatedAt: item.updatedAt
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const index: RecentIndex = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    entries: recentEntries.sort(compareReadingListEntries).slice(0, MAX_RECENT_ENTRIES)
  };

  await writeJsonFile(recentIndexPath(libraryPath), index, { backup: true });
  return index;
}

async function readRecentIndex(libraryPath: string): Promise<RecentIndex> {
  try {
    const index = await readJsonFile<RecentIndex>(recentIndexPath(libraryPath));
    assertSupportedSchemaVersion("recent-index.json", index);
    return Array.isArray(index.entries) ? index : { ...index, entries: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return rebuildRecentIndex(libraryPath);
  }
}

async function listRecentEntries(libraryPath: string): Promise<ReadingListEntry[]> {
  let index = await readRecentIndex(libraryPath);

  if (index.entries.length === 0) {
    index = await rebuildRecentIndex(libraryPath);
  }

  return index.entries;
}

async function upsertRecentEntry(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  progress: ChapterReadingProgress
): Promise<void> {
  if (!progress.updatedAt) {
    return;
  }

  const entry: ReadingListEntry = {
    ...(await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId)),
    scrollTop: progress.scrollTop,
    updatedAt: progress.updatedAt
  };
  const filePath = recentIndexPath(libraryPath);

  await ensureRecentIndexJson(libraryPath);
  await withResourceWriteLock(filePath, async () => {
    const current = await readJsonFile<RecentIndex>(filePath);
    assertSupportedSchemaVersion("recent-index.json", current);

    const index: RecentIndex = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      entries: [entry, ...(current.entries ?? []).filter((item) => !sameChapterReference(item, entry))]
        .sort(compareReadingListEntries)
        .slice(0, MAX_RECENT_ENTRIES)
    };
    const tmpPath = `${filePath}.tmp`;

    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  });
}

async function readSeriesBookmarks(libraryPath: string, seriesId: string): Promise<SeriesBookmarks> {
  try {
    const bookmarks = await readJsonFile<SeriesBookmarks>(seriesBookmarksPath(libraryPath, seriesId));
    assertSupportedSchemaVersion("bookmarks.json", bookmarks);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: Array.isArray(bookmarks.entries) ? bookmarks.entries : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: [] };
    }

    throw error;
  }
}

async function getChapterBookmark(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<BookmarkEntry | null> {
  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const bookmarks = await readSeriesBookmarks(libraryPath, seriesId);
  const entry = bookmarks.entries.find((item) => sameChapterReference(item, reference));

  return entry ? { ...entry, ...reference } : null;
}

async function toggleChapterBookmark(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<BookmarkEntry | null> {
  const record = assertRecord(input);
  const scrollTop = Number(record.scrollTop);

  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new Error("scrollTop must be a non-negative number.");
  }

  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const filePath = seriesBookmarksPath(libraryPath, seriesId);

  return withResourceWriteLock(filePath, async () => {
    const bookmarks = await readSeriesBookmarks(libraryPath, seriesId);
    const existing = bookmarks.entries.find((item) => sameChapterReference(item, reference));
    const now = new Date().toISOString();
    const createdBookmark: BookmarkEntry | null = existing
      ? null
      : {
          ...reference,
          scrollTop,
          createdAt: now,
          updatedAt: now
        };
    const nextEntries = createdBookmark
      ? [createdBookmark, ...bookmarks.entries]
      : bookmarks.entries.filter((item) => !sameChapterReference(item, reference));
    const next: SeriesBookmarks = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      entries: nextEntries.sort(compareReadingListEntries)
    };
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);

    return createdBookmark;
  });
}

async function listBookmarks(libraryPath: string): Promise<BookmarkEntry[]> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const bookmarks: BookmarkEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const seriesBookmarks = await readSeriesBookmarks(libraryPath, entry.name);

      for (const bookmark of seriesBookmarks.entries) {
        try {
          bookmarks.push({
            ...bookmark,
            ...(await readChapterReference(
              libraryPath,
              bookmark.seriesId,
              bookmark.categoryId,
              bookmark.volumeId,
              bookmark.chapterId
            ))
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return bookmarks.sort(compareReadingListEntries);
}

function readHighlightColor(record: JsonRecord): HighlightColor {
  const color = readOptionalString(record, "color", "yellow");

  if ((HIGHLIGHT_COLORS as readonly string[]).includes(color)) {
    return color as HighlightColor;
  }

  throw new Error("color is invalid.");
}

function readHighlightScrollTop(record: JsonRecord): number {
  const scrollTop = Number(record.scrollTop ?? 0);

  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new Error("scrollTop must be a non-negative number.");
  }

  return scrollTop;
}

function readHighlightTextRange(record: JsonRecord): { textStart?: number; textEnd?: number } {
  if (record.textStart === undefined && record.textEnd === undefined) {
    return {};
  }

  if (record.textStart === undefined || record.textEnd === undefined) {
    throw new Error("textStart and textEnd must be provided together.");
  }

  const textStart = readOptionalNonNegativeInteger(record, "textStart", 0);
  const textEnd = readOptionalNonNegativeInteger(record, "textEnd", 0);

  if (textEnd <= textStart) {
    throw new Error("textEnd must be greater than textStart.");
  }

  return { textStart, textEnd };
}

async function readSeriesHighlights(libraryPath: string, seriesId: string): Promise<SeriesHighlights> {
  try {
    const highlights = await readJsonFile<SeriesHighlights>(seriesHighlightsPath(libraryPath, seriesId));
    assertSupportedSchemaVersion("highlights.json", highlights);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: Array.isArray(highlights.entries) ? highlights.entries : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: [] };
    }

    throw error;
  }
}

async function createHighlight(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<HighlightEntry> {
  const record = assertRecord(input);
  const text = readRequiredText(record, "text").replace(/\s+/g, " ").trim();
  const note = readOptionalString(record, "note", "");

  if (!text) {
    throw new Error("text is required.");
  }

  if (text.length > 2000) {
    throw new Error("text is too long.");
  }

  if (note.length > 2000) {
    throw new Error("note is too long.");
  }

  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const filePath = seriesHighlightsPath(libraryPath, seriesId);

  return withResourceWriteLock(filePath, async () => {
    const highlights = await readSeriesHighlights(libraryPath, seriesId);
    const now = new Date().toISOString();
    const textRange = readHighlightTextRange(record);
    const entry: HighlightEntry = {
      ...reference,
      id: randomUUID(),
      text,
      ...textRange,
      color: readHighlightColor(record),
      note,
      scrollTop: readHighlightScrollTop(record),
      createdAt: now,
      updatedAt: now
    };
    const next: SeriesHighlights = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      entries: [entry, ...highlights.entries].sort(compareReadingListEntries)
    };
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);

    return entry;
  });
}

async function listChapterHighlights(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<HighlightEntry[]> {
  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const highlights = await readSeriesHighlights(libraryPath, seriesId);

  return highlights.entries
    .filter((item) => sameChapterReference(item, reference))
    .map((item) => ({ ...item, ...reference }))
    .sort(compareReadingListEntries);
}

async function listHighlights(libraryPath: string): Promise<HighlightEntry[]> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const highlights: HighlightEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const seriesHighlights = await readSeriesHighlights(libraryPath, entry.name);

      for (const highlight of seriesHighlights.entries) {
        try {
          highlights.push({
            ...highlight,
            ...(await readChapterReference(
              libraryPath,
              highlight.seriesId,
              highlight.categoryId,
              highlight.volumeId,
              highlight.chapterId
            ))
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return highlights.sort(compareReadingListEntries);
}

async function deleteHighlight(libraryPath: string, seriesId: string, highlightId: string): Promise<{ id: string }> {
  const filePath = seriesHighlightsPath(libraryPath, seriesId);

  return withResourceWriteLock(filePath, async () => {
    const highlights = await readSeriesHighlights(libraryPath, seriesId);
    const next: SeriesHighlights = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      entries: highlights.entries.filter((item) => item.id !== highlightId)
    };
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);

    return { id: highlightId };
  });
}

function moveReadingEntryReference<T extends ReadingListEntry>(
  entry: T,
  oldReference: ChapterReference,
  newReference: ChapterReference
): T {
  return sameChapterReference(entry, oldReference) ? { ...entry, ...newReference } : entry;
}

async function updateChapterReadingReferences(
  libraryPath: string,
  oldReference: ChapterReference,
  newReference: ChapterReference
): Promise<void> {
  const oldProgressKey = chapterProgressKey(oldReference.categoryId, oldReference.volumeId, oldReference.chapterId);
  const newProgressKey = chapterProgressKey(newReference.categoryId, newReference.volumeId, newReference.chapterId);
  const progress = await readSeriesProgress(libraryPath, oldReference.seriesId);

  if (progress.chapters[oldProgressKey]) {
    const chapters = { ...progress.chapters, [newProgressKey]: progress.chapters[oldProgressKey] };
    delete chapters[oldProgressKey];
    await writeJsonFile(seriesProgressPath(libraryPath, oldReference.seriesId), { ...progress, chapters }, { backup: true });
  }

  const bookmarks = await readSeriesBookmarks(libraryPath, oldReference.seriesId);
  if (bookmarks.entries.some((entry) => sameChapterReference(entry, oldReference))) {
    await writeJsonFile(
      seriesBookmarksPath(libraryPath, oldReference.seriesId),
      {
        ...bookmarks,
        entries: bookmarks.entries
          .map((entry) => moveReadingEntryReference(entry, oldReference, newReference))
          .sort(compareReadingListEntries)
      } satisfies SeriesBookmarks,
      { backup: true }
    );
  }

  const highlights = await readSeriesHighlights(libraryPath, oldReference.seriesId);
  if (highlights.entries.some((entry) => sameChapterReference(entry, oldReference))) {
    await writeJsonFile(
      seriesHighlightsPath(libraryPath, oldReference.seriesId),
      {
        ...highlights,
        entries: highlights.entries
          .map((entry) => moveReadingEntryReference(entry, oldReference, newReference))
          .sort(compareReadingListEntries)
      } satisfies SeriesHighlights,
      { backup: true }
    );
  }
}

function parseSeriesCreateInput(input: unknown): SeriesMetadata {
  const record = assertRecord(input);
  const now = new Date().toISOString();

  return {
    schemaVersion: SERIES_METADATA_SCHEMA_VERSION,
    id: randomUUID(),
    title: readRequiredString(record, "title"),
    originalTitle: readOptionalNullableString(record, "originalTitle", null),
    originalAuthor: readOptionalNullableString(record, "originalAuthor", null),
    translator: readOptionalNullableString(record, "translator", null),
    genres: readOptionalStringArray(record, "genres", []),
    tags: readOptionalStringArray(record, "tags", []),
    status: readSeriesStatus(record, "planning"),
    publisher: readOptionalNullableString(record, "publisher", null),
    year: readOptionalNullableNumber(record, "year", null),
    language: readOptionalString(record, "language", "vi") || "vi",
    sourceLanguage: readOptionalNullableString(record, "sourceLanguage", null),
    description: readOptionalString(record, "description", ""),
    categoryOrder: [],
    coverImage: readOptionalNullableString(record, "coverImage", null),
    createdAt: now,
    updatedAt: now,
    lastReadAt: null
  };
}

function parseSeriesUpdateInput(input: unknown, current: SeriesMetadata): SeriesMetadata {
  const record = assertRecord(input);

  return {
    ...current,
    title: record.title === undefined ? current.title : readRequiredString(record, "title"),
    originalTitle: readOptionalNullableString(record, "originalTitle", current.originalTitle),
    originalAuthor: readOptionalNullableString(record, "originalAuthor", current.originalAuthor),
    translator: readOptionalNullableString(record, "translator", current.translator),
    genres: readOptionalStringArray(record, "genres", current.genres),
    tags: readOptionalStringArray(record, "tags", current.tags),
    status: readSeriesStatus(record, current.status),
    publisher: readOptionalNullableString(record, "publisher", current.publisher),
    year: readOptionalNullableNumber(record, "year", current.year),
    language: readOptionalString(record, "language", current.language) || current.language,
    sourceLanguage: readOptionalNullableString(record, "sourceLanguage", current.sourceLanguage),
    description: readOptionalString(record, "description", current.description),
    coverImage: readOptionalNullableString(record, "coverImage", current.coverImage),
    lastReadAt: readOptionalNullableString(record, "lastReadAt", current.lastReadAt),
    updatedAt: new Date().toISOString()
  };
}

async function readSeriesMetadata(libraryPath: string, seriesId: string): Promise<SeriesMetadata> {
  const metadata = await readJsonFile<SeriesMetadata>(seriesMetaPath(libraryPath, seriesId));
  assertSupportedSchemaVersion(`series/${seriesId}/meta.json`, metadata);
  return metadata;
}

async function readSeriesIndex(libraryPath: string): Promise<SeriesIndex> {
  try {
    const index = await readJsonFile<SeriesIndex>(seriesIndexPath(libraryPath));
    assertSupportedSchemaVersion("series-index.json", index);

    if (index.series.some((entry) => !Array.isArray(entry.genres))) {
      await rebuildSeriesIndex(libraryPath);
      return readJsonFile<SeriesIndex>(seriesIndexPath(libraryPath));
    }

    return index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await rebuildSeriesIndex(libraryPath);
    return readJsonFile<SeriesIndex>(seriesIndexPath(libraryPath));
  }
}

async function repairSeriesIndex(libraryPath: string): Promise<SeriesIndex> {
  await rebuildSeriesIndex(libraryPath);
  return readSeriesIndex(libraryPath);
}

function imageMimeType(fileName: string): string {
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.endsWith(".png")) {
    return "image/png";
  }

  if (lowerFileName.endsWith(".webp")) {
    return "image/webp";
  }

  if (lowerFileName.endsWith(".gif")) {
    return "image/gif";
  }

  return "image/jpeg";
}

async function readImageDataUrl(filePath: string, fileName: string): Promise<string> {
  const image = await readFile(filePath);
  return `data:${imageMimeType(fileName)};base64,${image.toString("base64")}`;
}

async function readSeriesCoverDataUrl(libraryPath: string, entry: SeriesIndexEntry): Promise<string | null> {
  if (!entry.coverImage) {
    return null;
  }

  try {
    const fileName = basename(entry.coverImage);
    // ponytail: data URLs are enough for MVP; add thumbnails/protocol if cover loading gets slow.
    return readImageDataUrl(libraryChildPath(libraryPath, "series", entry.id, fileName), fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function toSeriesCard(libraryPath: string, entry: SeriesIndexEntry): Promise<SeriesCard> {
  return {
    id: entry.id,
    title: entry.title,
    author: entry.author ?? null,
    genres: entry.genres ?? [],
    status: entry.status ?? "planning",
    coverDataUrl: await readSeriesCoverDataUrl(libraryPath, entry)
  };
}

async function toSeriesDetailData(libraryPath: string, metadata: SeriesMetadata): Promise<SeriesDetailData> {
  return {
    ...metadata,
    coverDataUrl: await readSeriesCoverDataUrl(libraryPath, {
      id: metadata.id,
      title: metadata.title,
      coverImage: metadata.coverImage
    })
  };
}

async function listSeriesCards(libraryPath: string): Promise<SeriesCard[]> {
  const index = await readSeriesIndex(libraryPath);
  return Promise.all(index.series.map((entry) => toSeriesCard(libraryPath, entry)));
}

async function createSeriesMetadata(libraryPath: string, input: unknown): Promise<SeriesMetadata> {
  const metadata = parseSeriesCreateInput(input);
  await mkdir(seriesDirectoryPath(libraryPath, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(libraryPath, "series", metadata.id, "categories"), { recursive: true });
  await writeJsonFile(seriesMetaPath(libraryPath, metadata.id), metadata);
  await rebuildSeriesIndex(libraryPath);
  return metadata;
}

async function updateSeriesMetadata(libraryPath: string, seriesId: string, input: unknown): Promise<SeriesMetadata> {
  const current = await readSeriesMetadata(libraryPath, seriesId);
  const metadata = parseSeriesUpdateInput(input, current);
  await writeJsonFile(seriesMetaPath(libraryPath, seriesId), metadata, { backup: true });
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

async function chooseSeriesCover(
  window: BrowserWindow | null,
  libraryPath: string,
  seriesId: string
): Promise<SeriesDetailData | null> {
  await readSeriesMetadata(libraryPath, seriesId);

  const options: OpenDialogOptions = {
    title: "Choose series cover",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const sourcePath = result.filePaths[0];
  const sourceStat = await stat(sourcePath);

  if (!sourceStat.isFile()) {
    throw new Error("Selected cover is not a file.");
  }

  const extension = extname(sourcePath).toLowerCase();

  if (!IMAGE_FILE_EXTENSIONS.has(extension)) {
    throw new Error("Selected cover type is not supported.");
  }

  return withResourceWriteLock(seriesDirectoryPath(libraryPath, seriesId), async () => {
    const fileName = `cover${extension}`;
    const targetPath = libraryChildPath(libraryPath, "series", seriesId, fileName);
    const tmpPath = `${targetPath}.tmp`;

    await copyFile(sourcePath, tmpPath);
    await rename(tmpPath, targetPath);

    return toSeriesDetailData(libraryPath, await updateSeriesMetadata(libraryPath, seriesId, { coverImage: fileName }));
  });
}

async function moveSeriesToTrash(libraryPath: string, seriesId: string): Promise<{ id: string; trashPath: string }> {
  const id = assertId(seriesId, "seriesId");
  await readSeriesMetadata(libraryPath, id);

  const trashPath = trashSeriesDirectoryPath(libraryPath, id);
  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await rename(seriesDirectoryPath(libraryPath, id), trashPath);
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id, trashPath };
}

function parseCategoryCreateInput(input: unknown): CategoryMetadata {
  const record = assertRecord(input);
  const now = new Date().toISOString();

  return {
    schemaVersion: CATEGORY_METADATA_SCHEMA_VERSION,
    id: randomUUID(),
    type: readCategoryType(record),
    title: readRequiredString(record, "title"),
    volumeOrder: [],
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
}

function parseCategoryUpdateInput(input: unknown, current: CategoryMetadata): CategoryMetadata {
  const record = assertRecord(input);

  return {
    ...current,
    title: record.title === undefined ? current.title : readRequiredString(record, "title"),
    updatedAt: new Date().toISOString()
  };
}

async function readCategoryMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string
): Promise<CategoryMetadata> {
  const metadata = await readJsonFile<CategoryMetadata>(categoryMetaPath(libraryPath, seriesId, categoryId));
  assertSupportedSchemaVersion(`series/${seriesId}/categories/${categoryId}/meta.json`, metadata);
  return metadata;
}

async function listCategoryMetadata(libraryPath: string, seriesId: string): Promise<CategoryMetadata[]> {
  const series = await readSeriesMetadata(libraryPath, seriesId);
  const categoryDirectory = libraryChildPath(libraryPath, "series", series.id, "categories");
  const entries = await readdir(categoryDirectory, { withFileTypes: true });
  const categories = new Map<string, CategoryMetadata>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readCategoryMetadata(libraryPath, series.id, entry.name);
      categories.set(metadata.id, metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return [
    ...series.categoryOrder.map((categoryId) => categories.get(categoryId)).filter((item): item is CategoryMetadata => !!item),
    ...[...categories.values()].filter((category) => !series.categoryOrder.includes(category.id))
  ];
}

async function createCategoryMetadata(
  libraryPath: string,
  seriesId: string,
  input: unknown
): Promise<CategoryMetadata> {
  const series = await readSeriesMetadata(libraryPath, seriesId);
  const metadata = parseCategoryCreateInput(input);
  const now = new Date().toISOString();

  await mkdir(categoryDirectoryPath(libraryPath, series.id, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(libraryPath, "series", series.id, "categories", metadata.id, "volumes"), {
    recursive: true
  });
  await mkdir(libraryChildPath(libraryPath, "series", series.id, "categories", metadata.id, "chapters"), {
    recursive: true
  });
  await writeJsonFile(categoryMetaPath(libraryPath, series.id, metadata.id), metadata);
  await writeJsonFile(
    seriesMetaPath(libraryPath, series.id),
    { ...series, categoryOrder: [...series.categoryOrder, metadata.id], updatedAt: now } satisfies SeriesMetadata,
    { backup: true }
  );
  await rebuildSeriesIndex(libraryPath);

  return metadata;
}

async function updateCategoryMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  input: unknown
): Promise<CategoryMetadata> {
  const current = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  const metadata = parseCategoryUpdateInput(input, current);
  await writeJsonFile(categoryMetaPath(libraryPath, seriesId, categoryId), metadata, { backup: true });
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

async function moveCategoryToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string
): Promise<{ id: string; trashPath: string }> {
  const series = await readSeriesMetadata(libraryPath, seriesId);
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  const trashPath = trashItemDirectoryPath(libraryPath, "category", category.id);
  const now = new Date().toISOString();

  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await rename(categoryDirectoryPath(libraryPath, series.id, category.id), trashPath);
  await writeJsonFile(
    seriesMetaPath(libraryPath, series.id),
    { ...series, categoryOrder: series.categoryOrder.filter((id) => id !== category.id), updatedAt: now } satisfies SeriesMetadata,
    { backup: true }
  );
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id: category.id, trashPath };
}

function parseVolumeCreateInput(input: unknown, orderFallback: number): VolumeMetadata {
  const record = assertRecord(input);
  const now = new Date().toISOString();

  return {
    schemaVersion: VOLUME_METADATA_SCHEMA_VERSION,
    id: randomUUID(),
    title: readRequiredString(record, "title"),
    order: readOptionalInteger(record, "order", orderFallback),
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
}

function parseVolumeUpdateInput(input: unknown, current: VolumeMetadata): VolumeMetadata {
  const record = assertRecord(input);

  return {
    ...current,
    title: record.title === undefined ? current.title : readRequiredString(record, "title"),
    order: readOptionalInteger(record, "order", current.order),
    updatedAt: new Date().toISOString()
  };
}

async function readVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string
): Promise<VolumeMetadata> {
  const metadata = await readJsonFile<VolumeMetadata>(volumeMetaPath(libraryPath, seriesId, categoryId, volumeId));
  assertSupportedSchemaVersion(`series/${seriesId}/categories/${categoryId}/volumes/${volumeId}/meta.json`, metadata);
  return metadata;
}

async function listVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string
): Promise<VolumeMetadata[]> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  const volumeDirectory = libraryChildPath(libraryPath, "series", seriesId, "categories", categoryId, "volumes");
  const entries = await readdir(volumeDirectory, { withFileTypes: true });
  const volumes = new Map<string, VolumeMetadata>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readVolumeMetadata(libraryPath, seriesId, categoryId, entry.name);
      volumes.set(metadata.id, metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return [
    ...category.volumeOrder.map((volumeId) => volumes.get(volumeId)).filter((item): item is VolumeMetadata => !!item),
    ...[...volumes.values()].filter((volume) => !category.volumeOrder.includes(volume.id))
  ];
}

async function createVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  input: unknown
): Promise<VolumeMetadata> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  const metadata = parseVolumeCreateInput(input, category.volumeOrder.length + 1);
  const now = new Date().toISOString();

  await mkdir(volumeDirectoryPath(libraryPath, seriesId, categoryId, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(libraryPath, "series", seriesId, "categories", categoryId, "volumes", metadata.id, "chapters"), {
    recursive: true
  });
  await writeJsonFile(volumeMetaPath(libraryPath, seriesId, categoryId, metadata.id), metadata);
  await writeJsonFile(
    categoryMetaPath(libraryPath, seriesId, categoryId),
    { ...category, volumeOrder: [...category.volumeOrder, metadata.id], updatedAt: now } satisfies CategoryMetadata,
    { backup: true }
  );

  return metadata;
}

async function updateVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string,
  input: unknown
): Promise<VolumeMetadata> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  const current = await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId);
  const metadata = parseVolumeUpdateInput(input, current);
  await writeJsonFile(volumeMetaPath(libraryPath, seriesId, categoryId, volumeId), metadata, { backup: true });
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

async function moveVolumeToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string
): Promise<{ id: string; trashPath: string }> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  const volume = await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId);
  const trashPath = trashItemDirectoryPath(libraryPath, "volume", volume.id);
  const now = new Date().toISOString();

  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await rename(volumeDirectoryPath(libraryPath, seriesId, categoryId, volume.id), trashPath);
  await writeJsonFile(
    categoryMetaPath(libraryPath, seriesId, categoryId),
    { ...category, volumeOrder: category.volumeOrder.filter((id) => id !== volume.id), updatedAt: now } satisfies CategoryMetadata,
    { backup: true }
  );
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id: volume.id, trashPath };
}

async function assertNovelChapterScope(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null
): Promise<{ category: CategoryMetadata; volume: VolumeMetadata | null }> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  if (!volumeId) {
    if (category.type !== "web-novel") {
      throw new Error("Direct category chapters are only for web-novel categories.");
    }

    return { category, volume: null };
  }

  return { category, volume: await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId) };
}

function parseNovelChapterCreateInput(input: unknown, orderFallback: number): NovelChapterMetadata {
  const record = assertRecord(input);
  const now = new Date().toISOString();

  return {
    schemaVersion: CHAPTER_METADATA_SCHEMA_VERSION,
    id: randomUUID(),
    title: readRequiredString(record, "title"),
    type: readNovelChapterType(record, "chapter"),
    order: readOptionalInteger(record, "order", orderFallback),
    wordCount: readOptionalNonNegativeInteger(record, "wordCount", 0),
    characterCount: readOptionalNonNegativeInteger(record, "characterCount", 0),
    translationStatus: readTranslationStatus(record, "draft"),
    hasOriginalPdf: readOptionalBoolean(record, "hasOriginalPdf", false),
    originalFileName: readOptionalNullableString(record, "originalFileName", null),
    contentFile: "content.html",
    plainTextFile: "content.txt",
    createdAt: now,
    updatedAt: now
  };
}

function parseNovelChapterUpdateInput(input: unknown, current: NovelChapterMetadata): NovelChapterMetadata {
  const record = assertRecord(input);

  return {
    ...current,
    title: record.title === undefined ? current.title : readRequiredString(record, "title"),
    type: readNovelChapterType(record, current.type),
    order: readOptionalInteger(record, "order", current.order),
    wordCount: readOptionalNonNegativeInteger(record, "wordCount", current.wordCount),
    characterCount: readOptionalNonNegativeInteger(record, "characterCount", current.characterCount),
    translationStatus: readTranslationStatus(record, current.translationStatus),
    hasOriginalPdf: readOptionalBoolean(record, "hasOriginalPdf", current.hasOriginalPdf),
    originalFileName: readOptionalNullableString(record, "originalFileName", current.originalFileName),
    updatedAt: new Date().toISOString()
  };
}

async function readNovelChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<NovelChapterMetadata> {
  await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
  const metadata = await readJsonFile<NovelChapterMetadata>(
    chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, chapterId)
  );
  assertSupportedSchemaVersion(`series/${seriesId}/categories/${categoryId}/chapters/${chapterId}/meta.json`, metadata);
  return metadata;
}

async function listNovelChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null
): Promise<NovelChapterMetadata[]> {
  const { category, volume } = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
  const order = volume ? volume.chapterOrder : category.chapterOrder;
  const chapterDirectory = volumeId
    ? libraryChildPath(libraryPath, "series", seriesId, "categories", categoryId, "volumes", volumeId, "chapters")
    : libraryChildPath(libraryPath, "series", seriesId, "categories", categoryId, "chapters");
  const entries = await readdir(chapterDirectory, { withFileTypes: true });
  const chapters = new Map<string, NovelChapterMetadata>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, entry.name);
      chapters.set(metadata.id, metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return [
    ...order.map((chapterId) => chapters.get(chapterId)).filter((item): item is NovelChapterMetadata => !!item),
    ...[...chapters.values()].filter((chapter) => !order.includes(chapter.id))
  ];
}

async function createNovelChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  input: unknown
): Promise<NovelChapterMetadata> {
  const { category, volume } = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
  const order = volume ? volume.chapterOrder : category.chapterOrder;
  const metadata = parseNovelChapterCreateInput(input, order.length + 1);
  const now = new Date().toISOString();

  await mkdir(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, metadata.id), "assets"), {
    recursive: true
  });
  await writeJsonFile(chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, metadata.id), metadata);

  if (volume) {
    await writeJsonFile(
      volumeMetaPath(libraryPath, seriesId, categoryId, volume.id),
      { ...volume, chapterOrder: [...volume.chapterOrder, metadata.id], updatedAt: now } satisfies VolumeMetadata,
      { backup: true }
    );
  } else {
    await writeJsonFile(
      categoryMetaPath(libraryPath, seriesId, categoryId),
      { ...category, chapterOrder: [...category.chapterOrder, metadata.id], updatedAt: now } satisfies CategoryMetadata,
      { backup: true }
    );
  }

  return metadata;
}

async function updateNovelChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<NovelChapterMetadata> {
  const current = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const metadata = parseNovelChapterUpdateInput(input, current);
  await writeJsonFile(chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, chapterId), metadata, {
    backup: true
  });
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

function htmlToPlainText(html: string): string {
  // ponytail: simple HTML-to-text for MVP search text; use a parser when formatting edge cases matter.
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeNovelHtml(html: string): string {
  // ponytail: allowlist sanitizer for TipTap MVP HTML; use DOMPurify if import/paste HTML gets broader.
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(iframe|object|embed|form|input|button|select|textarea|svg|math|meta|link|base)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript:|data:text\/html)[\s\S]*?\2/gi, "")
    .replace(/\s+(href|src)\s*=\s*(?:javascript:|data:text\/html)[^\s>]*/gi, "");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function readHtmlAttribute(tag: string, attributeName: string): string | null {
  const match = tag.match(new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function removeHtmlAttribute(tag: string, attributeName: string): string {
  return tag.replace(new RegExp(`\\s${attributeName}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "");
}

function setHtmlAttribute(tag: string, attributeName: string, value: string): string {
  const escapedValue = escapeHtmlAttribute(value);
  const pattern = new RegExp(`(\\s${attributeName}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");

  if (pattern.test(tag)) {
    return tag.replace(pattern, (_match, prefix: string) => `${prefix}"${escapedValue}"`);
  }

  return tag.replace(/\s*\/?>$/, (ending) => ` ${attributeName}="${escapedValue}"${ending.trimStart()}`);
}

async function readChapterAssetDataUrl(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  fileName: string
): Promise<string> {
  const image = await readFile(chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName));
  return `data:${imageMimeType(fileName)};base64,${image.toString("base64")}`;
}

async function hydrateNovelImageTag(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  tag: string
): Promise<string> {
  const fileName = imageFileNameFromAssetSource(readHtmlAttribute(tag, "src"));

  if (!fileName) {
    return tag;
  }

  try {
    const dataUrl = await readChapterAssetDataUrl(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
    return setHtmlAttribute(setHtmlAttribute(tag, "src", dataUrl), "data-asset-src", chapterAssetSource(fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return tag;
    }

    throw error;
  }
}

async function hydrateNovelAssetImages(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  html: string
): Promise<string> {
  let result = "";
  let cursor = 0;

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const index = match.index ?? cursor;
    result += html.slice(cursor, index);
    result += await hydrateNovelImageTag(libraryPath, seriesId, categoryId, volumeId, chapterId, match[0]);
    cursor = index + match[0].length;
  }

  return result + html.slice(cursor);
}

function persistNovelAssetImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const fileName = imageFileNameFromAssetSource(readHtmlAttribute(tag, "data-asset-src"));
    return fileName ? setHtmlAttribute(removeHtmlAttribute(tag, "data-asset-src"), "src", chapterAssetSource(fileName)) : tag;
  });
}

function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

async function readOptionalTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function readNovelChapterContent(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterContent> {
  const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const storedHtml = sanitizeNovelHtml(
    await readOptionalTextFile(chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.contentFile))
  );
  const html = await hydrateNovelAssetImages(libraryPath, seriesId, categoryId, volumeId, chapterId, storedHtml);
  const text = await readOptionalTextFile(
    chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.plainTextFile)
  );

  return {
    html,
    text,
    wordCount: metadata.wordCount,
    characterCount: metadata.characterCount,
    updatedAt: metadata.updatedAt
  };
}

async function readNovelChapterOriginalPdf(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterOriginalPdf | null> {
  const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);

  if (!metadata.hasOriginalPdf) {
    return null;
  }

  const pdf = await readFile(chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.pdf"));

  return {
    // ponytail: data URL keeps the preload API tiny; use a custom protocol if large PDFs get slow.
    dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    fileName: metadata.originalFileName ?? "original.pdf"
  };
}

async function readNovelChapterOriginalText(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterOriginalText | null> {
  const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);

  if (metadata.hasOriginalPdf || extname(metadata.originalFileName ?? "").toLowerCase() !== ".md") {
    return null;
  }

  try {
    return {
      text: normalizeImportText(
        await readFile(chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.md"), "utf8")
      ),
      fileName: metadata.originalFileName ?? "original.md",
      fileType: "md"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function saveNovelChapterContent(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterContent> {
  return withResourceWriteLock(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), async () => {
    const record = assertRecord(input);
    const html = sanitizeNovelHtml(persistNovelAssetImages(readRequiredText(record, "html")));
    const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
    const text = htmlToPlainText(html);
    const now = new Date().toISOString();
    const nextMetadata: NovelChapterMetadata = {
      ...metadata,
      wordCount: countWords(text),
      characterCount: text.length,
      updatedAt: now
    };

    await writeTextFile(
      chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.contentFile),
      html,
      { backup: true }
    );
    await writeTextFile(
      chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.plainTextFile),
      text,
      { backup: true }
    );
    await writeJsonFile(chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, chapterId), nextMetadata, {
      backup: true
    });
    await upsertSearchDocument(libraryPath, seriesId, categoryId, volumeId, nextMetadata, text);

    return {
      html,
      text,
      wordCount: nextMetadata.wordCount,
      characterCount: nextMetadata.characterCount,
      updatedAt: nextMetadata.updatedAt
    };
  });
}

async function chooseNovelChapterImage(
  window: BrowserWindow | null,
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterImageAsset | null> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);

  const options: OpenDialogOptions = {
    title: "Choose inline image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const sourcePath = result.filePaths[0];
  const sourceStat = await stat(sourcePath);

  if (!sourceStat.isFile()) {
    throw new Error("Selected image is not a file.");
  }

  const extension = extname(sourcePath).toLowerCase();

  if (!IMAGE_FILE_EXTENSIONS.has(extension)) {
    throw new Error("Selected file type is not supported.");
  }

  return withResourceWriteLock(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), async () => {
    const fileName = `${randomUUID()}${extension}`;
    const src = chapterAssetSource(fileName);
    const targetPath = chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
    const tmpPath = `${targetPath}.tmp`;

    await mkdir(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), { recursive: true });
    await copyFile(sourcePath, tmpPath);
    await rename(tmpPath, targetPath);

    return {
      src,
      dataUrl: await readChapterAssetDataUrl(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName),
      fileName
    };
  });
}

function chapterProgressKey(categoryId: string, volumeId: string | null, chapterId: string): string {
  return `${assertId(categoryId, "categoryId")}/${volumeId ? assertId(volumeId, "volumeId") : "direct"}/${assertId(chapterId, "chapterId")}`;
}

async function readSeriesProgress(libraryPath: string, seriesId: string): Promise<SeriesProgress> {
  try {
    const progress = await readJsonFile<SeriesProgress>(seriesProgressPath(libraryPath, seriesId));
    assertSupportedSchemaVersion("progress.json", progress);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, chapters: progress.chapters ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, chapters: {} };
    }

    throw error;
  }
}

async function readChapterReadingProgress(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterReadingProgress> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const progress = await readSeriesProgress(libraryPath, seriesId);
  const entry = progress.chapters[chapterProgressKey(categoryId, volumeId, chapterId)];
  return {
    scrollTop: typeof entry?.scrollTop === "number" && entry.scrollTop >= 0 ? entry.scrollTop : 0,
    updatedAt: entry?.updatedAt ?? null
  };
}

async function saveChapterReadingProgress(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterReadingProgress> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const record = assertRecord(input);
  const scrollTop = Number(record.scrollTop);

  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new Error("scrollTop must be a non-negative number.");
  }

  const progress = await readSeriesProgress(libraryPath, seriesId);
  const next: ChapterReadingProgress = { scrollTop, updatedAt: new Date().toISOString() };
  progress.chapters[chapterProgressKey(categoryId, volumeId, chapterId)] = next;
  await writeJsonFile(seriesProgressPath(libraryPath, seriesId), progress, { backup: true });
  await upsertRecentEntry(libraryPath, seriesId, categoryId, volumeId, chapterId, next);
  return next;
}

async function moveNovelChapterToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<{ id: string; trashPath: string }> {
  const { category, volume } = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
  const chapter = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const trashPath = trashItemDirectoryPath(libraryPath, "chapter", chapter.id);
  const now = new Date().toISOString();

  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await rename(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapter.id), trashPath);

  if (volume) {
    await writeJsonFile(
      volumeMetaPath(libraryPath, seriesId, categoryId, volume.id),
      { ...volume, chapterOrder: volume.chapterOrder.filter((id) => id !== chapter.id), updatedAt: now } satisfies VolumeMetadata,
      { backup: true }
    );
  } else {
    await writeJsonFile(
      categoryMetaPath(libraryPath, seriesId, categoryId),
      { ...category, chapterOrder: category.chapterOrder.filter((id) => id !== chapter.id), updatedAt: now } satisfies CategoryMetadata,
      { backup: true }
    );
  }
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id: chapter.id, trashPath };
}

async function moveNovelChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  targetCategoryId: string,
  targetVolumeId: string | null
): Promise<NovelChapterMetadata> {
  if (categoryId === targetCategoryId && volumeId === targetVolumeId) {
    return readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  }

  return withResourceWriteLock(seriesDirectoryPath(libraryPath, seriesId), async () => {
    const source = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
    const target = await assertNovelChapterScope(libraryPath, seriesId, targetCategoryId, targetVolumeId);
    const chapter = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
    const oldReference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
    const now = new Date().toISOString();
    const targetPath = chapterDirectoryPath(libraryPath, seriesId, targetCategoryId, targetVolumeId, chapter.id);

    await mkdir(dirname(targetPath), { recursive: true });
    await rename(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapter.id), targetPath);

    if (source.volume) {
      await writeJsonFile(
        volumeMetaPath(libraryPath, seriesId, categoryId, source.volume.id),
        {
          ...source.volume,
          chapterOrder: source.volume.chapterOrder.filter((id) => id !== chapter.id),
          updatedAt: now
        } satisfies VolumeMetadata,
        { backup: true }
      );
    } else {
      await writeJsonFile(
        categoryMetaPath(libraryPath, seriesId, categoryId),
        {
          ...source.category,
          chapterOrder: source.category.chapterOrder.filter((id) => id !== chapter.id),
          updatedAt: now
        } satisfies CategoryMetadata,
        { backup: true }
      );
    }

    if (target.volume) {
      await writeJsonFile(
        volumeMetaPath(libraryPath, seriesId, targetCategoryId, target.volume.id),
        {
          ...target.volume,
          chapterOrder: [...target.volume.chapterOrder.filter((id) => id !== chapter.id), chapter.id],
          updatedAt: now
        } satisfies VolumeMetadata,
        { backup: true }
      );
    } else {
      await writeJsonFile(
        categoryMetaPath(libraryPath, seriesId, targetCategoryId),
        {
          ...target.category,
          chapterOrder: [...target.category.chapterOrder.filter((id) => id !== chapter.id), chapter.id],
          updatedAt: now
        } satisfies CategoryMetadata,
        { backup: true }
      );
    }

    await writeChapterMetadataOrder(
      libraryPath,
      seriesId,
      categoryId,
      volumeId,
      await listNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId)
    );
    await writeChapterMetadataOrder(
      libraryPath,
      seriesId,
      targetCategoryId,
      targetVolumeId,
      await listNovelChapterMetadata(libraryPath, seriesId, targetCategoryId, targetVolumeId)
    );
    await updateChapterReadingReferences(
      libraryPath,
      oldReference,
      await readChapterReference(libraryPath, seriesId, targetCategoryId, targetVolumeId, chapter.id)
    );
    await rebuildSearchIndex(libraryPath);
    await rebuildRecentIndex(libraryPath);

    return readNovelChapterMetadata(libraryPath, seriesId, targetCategoryId, targetVolumeId, chapter.id);
  });
}

async function writeChapterMetadataOrder(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapters: ChapterMetadata[]
): Promise<void> {
  await Promise.all(
    chapters.map((chapter, index) => {
      const nextOrder = index + 1;

      if (chapter.order === nextOrder) {
        return Promise.resolve();
      }

      return writeJsonFile(
        chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, chapter.id),
        { ...chapter, order: nextOrder, updatedAt: new Date().toISOString() },
        { backup: true }
      );
    })
  );
}

function assertExactChapterOrder(chapterOrder: string[], chapters: ChapterMetadata[]): void {
  const currentIds = new Set(chapters.map((chapter) => chapter.id));

  if (chapterOrder.length !== currentIds.size || chapterOrder.some((chapterId) => !currentIds.has(chapterId))) {
    throw new Error("chapterOrder must contain every chapter in this container exactly once.");
  }
}

async function listChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null
): Promise<ChapterMetadata[]> {
  return listNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId);
}

async function readChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterMetadata> {
  return readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
}

async function createChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  input: unknown
): Promise<ChapterMetadata> {
  return createNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, input);
}

async function updateChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterMetadata> {
  return updateNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId, input);
}

async function reorderChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  input: unknown
): Promise<ChapterMetadata[]> {
  const record = assertRecord(input);
  const chapterOrder = readRequiredIdArray(record, "chapterOrder");
  const now = new Date().toISOString();
  const { category: scopedCategory, volume } = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
  const targetMetaPath = volume
    ? volumeMetaPath(libraryPath, seriesId, categoryId, volume.id)
    : categoryMetaPath(libraryPath, seriesId, categoryId);
  const chapters = await listNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId);
  assertExactChapterOrder(chapterOrder, chapters);
  const chaptersById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const orderedChapters = chapterOrder.map((chapterId) => chaptersById.get(chapterId)).filter((chapter): chapter is NovelChapterMetadata => !!chapter);

  if (volume) {
    await writeJsonFile(
      targetMetaPath,
      { ...volume, chapterOrder, updatedAt: now } satisfies VolumeMetadata,
      { backup: true }
    );
  } else {
    await writeJsonFile(
      targetMetaPath,
      { ...scopedCategory, chapterOrder, updatedAt: now } satisfies CategoryMetadata,
      { backup: true }
    );
  }

  await writeChapterMetadataOrder(libraryPath, seriesId, categoryId, volumeId, orderedChapters);
  return orderedChapters;
}

async function moveChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterMetadata> {
  const record = assertRecord(input);

  return moveNovelChapterMetadata(
    libraryPath,
    seriesId,
    categoryId,
    volumeId,
    chapterId,
    assertId(record.targetCategoryId, "targetCategoryId"),
    optionalVolumeId(record.targetVolumeId)
  );
}

async function moveChapterToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<{ id: string; trashPath: string }> {
  return moveNovelChapterToTrash(libraryPath, seriesId, categoryId, volumeId, chapterId);
}

function registerLibraryIpc(): void {
  ipcMain.handle("library:getCurrent", async (): Promise<ApiResponse<{ path: string | null }>> => {
    try {
      const settings = await readAppSettings();
      const currentLibraryPath = settings.currentLibraryPath ?? null;

      if (currentLibraryPath) {
        await ensureLibraryFiles(currentLibraryPath);
      }

      return ok({ path: currentLibraryPath });
    } catch (error) {
      return fail(ErrorCode.LIBRARY_FOLDER_LOAD_FAILED, "Could not load current Library folder.", String(error));
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

      const settings = await readAppSettings();
      const currentLibraryPath = result.filePaths[0];
      await ensureLibraryFiles(currentLibraryPath);
      await writeAppSettings({ ...settings, currentLibraryPath });

      return ok({ path: currentLibraryPath });
    } catch (error) {
      return fail(ErrorCode.LIBRARY_FOLDER_CHOOSE_FAILED, "Could not choose Library folder.", String(error));
    }
  });

  ipcMain.handle("library:repairSeriesIndex", async (): Promise<ApiResponse<SeriesIndex>> => {
    try {
      return ok(await repairSeriesIndex(await currentLibraryPathOrThrow({ ensureFiles: false })));
    } catch (error) {
      return fail(ErrorCode.LIBRARY_REPAIR_FAILED, "Could not repair series index.", String(error));
    }
  });
}

function registerSeriesIpc(): void {
  ipcMain.handle("series:list", async (): Promise<ApiResponse<SeriesCard[]>> => {
    try {
      return ok(await listSeriesCards(await currentLibraryPathOrThrow({ ensureFiles: false })));
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not list series.", String(error));
    }
  });

  ipcMain.handle("series:get", async (_event, seriesId: unknown): Promise<ApiResponse<SeriesDetailData>> => {
    try {
      const libraryPath = await currentLibraryPathOrThrow();
      return ok(await toSeriesDetailData(libraryPath, await readSeriesMetadata(libraryPath, assertId(seriesId, "seriesId"))));
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not load series.", String(error));
    }
  });

  ipcMain.handle("series:create", async (_event, input: unknown): Promise<ApiResponse<SeriesMetadata>> => {
    try {
      return ok(await createSeriesMetadata(await currentLibraryPathOrThrow(), input));
    } catch (error) {
      return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not create series.", String(error));
    }
  });

  ipcMain.handle(
    "series:update",
    async (_event, seriesId: unknown, input: unknown): Promise<ApiResponse<SeriesDetailData>> => {
      try {
        const libraryPath = await currentLibraryPathOrThrow();
        return ok(await toSeriesDetailData(libraryPath, await updateSeriesMetadata(libraryPath, assertId(seriesId, "seriesId"), input)));
      } catch (error) {
        return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not update series.", String(error));
      }
    }
  );

  ipcMain.handle(
    "series:chooseCover",
    async (event, seriesId: unknown): Promise<ApiResponse<SeriesDetailData | null>> => {
      try {
        return ok(
          await chooseSeriesCover(
            BrowserWindow.fromWebContents(event.sender),
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not choose series cover.", String(error));
      }
    }
  );

  ipcMain.handle(
    "series:moveToTrash",
    async (_event, seriesId: unknown): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
      try {
        return ok(await moveSeriesToTrash(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId")));
      } catch (error) {
        return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not move series to trash.", String(error));
      }
    }
  );
}

function registerCategoryIpc(): void {
  ipcMain.handle("categories:list", async (_event, seriesId: unknown): Promise<ApiResponse<CategoryMetadata[]>> => {
    try {
      return ok(await listCategoryMetadata(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId")));
    } catch (error) {
      return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not list categories.", String(error));
    }
  });

  ipcMain.handle(
    "categories:get",
    async (_event, seriesId: unknown, categoryId: unknown): Promise<ApiResponse<CategoryMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "categories:create",
    async (_event, seriesId: unknown, input: unknown): Promise<ApiResponse<CategoryMetadata>> => {
      try {
        return ok(await createCategoryMetadata(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId"), input));
      } catch (error) {
        return fail(ErrorCode.CATEGORY_CRUD_FAILED, "Could not create category.", String(error));
      }
    }
  );

  ipcMain.handle(
    "categories:update",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      input: unknown
    ): Promise<ApiResponse<CategoryMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "categories:moveToTrash",
    async (_event, seriesId: unknown, categoryId: unknown): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
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
    }
  );
}

function registerVolumeIpc(): void {
  ipcMain.handle(
    "volumes:list",
    async (_event, seriesId: unknown, categoryId: unknown): Promise<ApiResponse<VolumeMetadata[]>> => {
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
    }
  );

  ipcMain.handle(
    "volumes:get",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown
    ): Promise<ApiResponse<VolumeMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "volumes:create",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      input: unknown
    ): Promise<ApiResponse<VolumeMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "volumes:update",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      input: unknown
    ): Promise<ApiResponse<VolumeMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "volumes:moveToTrash",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown
    ): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
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
    }
  );
}

function registerChapterIpc(): void {
  ipcMain.handle(
    "chapters:list",
    async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<ChapterMetadata[]>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:get",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ChapterMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:create",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      input: unknown
    ): Promise<ApiResponse<ChapterMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:update",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown,
      input: unknown
    ): Promise<ApiResponse<ChapterMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:reorder",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      input: unknown
    ): Promise<ApiResponse<ChapterMetadata[]>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:move",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown,
      input: unknown
    ): Promise<ApiResponse<ChapterMetadata>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:getContent",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ChapterContent>> => {
      try {
        return ok(
          await readNovelChapterContent(
            await currentLibraryPathOrThrow(),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            optionalVolumeId(volumeId),
            assertId(chapterId, "chapterId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.CHAPTER_CRUD_FAILED, "Could not load chapter content.", String(error));
      }
    }
  );

  ipcMain.handle(
    "chapters:saveContent",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown,
      input: unknown
    ): Promise<ApiResponse<ChapterContent>> => {
      try {
        return ok(
          await saveNovelChapterContent(
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
    }
  );

  ipcMain.handle(
    "chapters:getOriginalPdf",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ChapterOriginalPdf | null>> => {
      try {
        return ok(
          await readNovelChapterOriginalPdf(
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
    }
  );

  ipcMain.handle(
    "chapters:getOriginalText",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ChapterOriginalText | null>> => {
      try {
        return ok(
          await readNovelChapterOriginalText(
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
    }
  );

  ipcMain.handle(
    "chapters:chooseImage",
    async (
      event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ChapterImageAsset | null>> => {
      try {
        return ok(
          await chooseNovelChapterImage(
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
    }
  );

  ipcMain.handle(
    "chapters:getProgress",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<ChapterReadingProgress>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:saveProgress",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown,
      input: unknown
    ): Promise<ApiResponse<ChapterReadingProgress>> => {
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
    }
  );

  ipcMain.handle(
    "chapters:moveToTrash",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<{ id: string; trashPath: string }>> => {
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
    }
  );
}

function registerImportIpc(): void {
  ipcMain.handle(
    "import:chooseSourceFolder",
    async (event): Promise<ApiResponse<{ importSessionId: string; path: string; name: string } | null>> => {
      try {
        return ok(await chooseImportSourceFolder(BrowserWindow.fromWebContents(event.sender)));
      } catch (error) {
        return fail(ErrorCode.IMPORT_FAILED, "Could not choose import source folder.", String(error));
      }
    }
  );

  ipcMain.handle(
    "import:chooseSourceFiles",
    async (event): Promise<ApiResponse<{ importSessionId: string; path: string; name: string } | null>> => {
      try {
        return ok(await chooseImportSourceFiles(BrowserWindow.fromWebContents(event.sender)));
      } catch (error) {
        return fail(ErrorCode.IMPORT_FAILED, "Could not choose import chapter files.", String(error));
      }
    }
  );

  ipcMain.handle("import:scan", async (_event, importSessionId: unknown): Promise<ApiResponse<ImportPreview>> => {
    try {
      return ok(await scanImportSession(importSessionId));
    } catch (error) {
      return fail(ErrorCode.IMPORT_FAILED, "Could not scan import source folder.", String(error));
    }
  });

  ipcMain.handle(
    "import:readText",
    async (_event, importSessionId: unknown, fileId: unknown): Promise<ApiResponse<ImportTextPreview>> => {
      try {
        return ok(await readImportTextPreview(importSessionId, fileId));
      } catch (error) {
        return fail(ErrorCode.IMPORT_FAILED, "Could not read import text.", String(error));
      }
    }
  );

  ipcMain.handle(
    "import:execute",
    async (_event, importSessionId: unknown, input: unknown): Promise<ApiResponse<ImportReport>> => {
      try {
        return ok(await executeImport(await currentLibraryPathOrThrow(), importSessionId, input));
      } catch (error) {
        return fail(ErrorCode.IMPORT_FAILED, "Could not import selected chapters.", String(error));
      }
    }
  );
}

function registerSearchIpc(): void {
  ipcMain.handle("search:query", async (_event, query: unknown): Promise<ApiResponse<SearchResult[]>> => {
    try {
      return ok(await searchLibrary(await currentLibraryPathOrThrow({ ensureFiles: false }), query));
    } catch (error) {
      return fail(ErrorCode.SEARCH_FAILED, "Could not search library.", String(error));
    }
  });

  ipcMain.handle("search:rebuild", async (): Promise<ApiResponse<SearchIndexSummary>> => {
    try {
      return ok(summarizeSearchIndex(await rebuildSearchIndex(await currentLibraryPathOrThrow({ ensureFiles: false }))));
    } catch (error) {
      return fail(ErrorCode.SEARCH_FAILED, "Could not rebuild search index.", String(error));
    }
  });
}

function registerReadingStateIpc(): void {
  ipcMain.handle("reading:listRecent", async (): Promise<ApiResponse<ReadingListEntry[]>> => {
    try {
      return ok(await listRecentEntries(await currentLibraryPathOrThrow({ ensureFiles: false })));
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list recent reading.", String(error));
    }
  });

  ipcMain.handle("bookmarks:list", async (): Promise<ApiResponse<BookmarkEntry[]>> => {
    try {
      return ok(await listBookmarks(await currentLibraryPathOrThrow({ ensureFiles: false })));
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list bookmarks.", String(error));
    }
  });

  ipcMain.handle(
    "bookmarks:get",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<BookmarkEntry | null>> => {
      try {
        return ok(
          await getChapterBookmark(
            await currentLibraryPathOrThrow({ ensureFiles: false }),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            optionalVolumeId(volumeId),
            assertId(chapterId, "chapterId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.READING_STATE_FAILED, "Could not load bookmark.", String(error));
      }
    }
  );

  ipcMain.handle(
    "bookmarks:toggle",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown,
      input: unknown
    ): Promise<ApiResponse<BookmarkEntry | null>> => {
      try {
        return ok(
          await toggleChapterBookmark(
            await currentLibraryPathOrThrow({ ensureFiles: false }),
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
    }
  );

  ipcMain.handle("highlights:list", async (): Promise<ApiResponse<HighlightEntry[]>> => {
    try {
      return ok(await listHighlights(await currentLibraryPathOrThrow({ ensureFiles: false })));
    } catch (error) {
      return fail(ErrorCode.READING_STATE_FAILED, "Could not list highlights.", String(error));
    }
  });

  ipcMain.handle(
    "highlights:listForChapter",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown
    ): Promise<ApiResponse<HighlightEntry[]>> => {
      try {
        return ok(
          await listChapterHighlights(
            await currentLibraryPathOrThrow({ ensureFiles: false }),
            assertId(seriesId, "seriesId"),
            assertId(categoryId, "categoryId"),
            optionalVolumeId(volumeId),
            assertId(chapterId, "chapterId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.READING_STATE_FAILED, "Could not list chapter highlights.", String(error));
      }
    }
  );

  ipcMain.handle(
    "highlights:create",
    async (
      _event,
      seriesId: unknown,
      categoryId: unknown,
      volumeId: unknown,
      chapterId: unknown,
      input: unknown
    ): Promise<ApiResponse<HighlightEntry>> => {
      try {
        return ok(
          await createHighlight(
            await currentLibraryPathOrThrow({ ensureFiles: false }),
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
    }
  );

  ipcMain.handle(
    "highlights:delete",
    async (_event, seriesId: unknown, highlightId: unknown): Promise<ApiResponse<{ id: string }>> => {
      try {
        return ok(
          await deleteHighlight(
            await currentLibraryPathOrThrow({ ensureFiles: false }),
            assertId(seriesId, "seriesId"),
            assertId(highlightId, "highlightId")
          )
        );
      } catch (error) {
        return fail(ErrorCode.READING_STATE_FAILED, "Could not delete highlight.", String(error));
      }
    }
  );
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  registerLibraryIpc();
  registerSeriesIpc();
  registerCategoryIpc();
  registerVolumeIpc();
  registerChapterIpc();
  registerImportIpc();
  registerSearchIpc();
  registerReadingStateIpc();
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
