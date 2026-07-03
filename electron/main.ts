import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import mammoth from "mammoth";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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
  IMPORT_FAILED: "IMPORT_FAILED"
} as const;

const REQUIRED_LIBRARY_DIRECTORIES = ["index", "series", "backups", ".trash"] as const;
const IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const IMPORT_FILE_TYPES = {
  ".txt": "txt",
  ".md": "md",
  ".docx": "docx",
  ".pdf": "pdf"
} as const;
const SUPPORTED_SCHEMA_VERSION = 1;
const importSessions = new Map<string, ImportSession>();
const writeQueues = new Map<string, Promise<unknown>>();

type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
type SupportedSchemaVersion = typeof SUPPORTED_SCHEMA_VERSION;
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
  sourceFolderPath: string;
  createdAt: string;
};

type ImportFileType = (typeof IMPORT_FILE_TYPES)[keyof typeof IMPORT_FILE_TYPES];

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
  };
};

type ImportTextFileType = ImportFileType;

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
  status: SeriesStatus;
  coverDataUrl: string | null;
};

type SearchIndex = {
  schemaVersion: SupportedSchemaVersion;
  generatedAt: string;
  documents: [];
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

type ChapterOriginalPdf = {
  dataUrl: string;
  fileName: string;
};

type ChapterReadingProgress = {
  scrollTop: number;
  updatedAt: string | null;
};

type SeriesProgress = {
  schemaVersion: SupportedSchemaVersion;
  chapters: Record<string, ChapterReadingProgress>;
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

function seriesIndexPath(libraryPath: string): string {
  return libraryChildPath(libraryPath, "index", "series-index.json");
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

function isImportableFileType(fileType: ImportFileType | null): fileType is ImportTextFileType {
  return isImportTextFileType(fileType);
}

function toImportRelativePath(parts: string[]): string {
  return parts.join("/");
}

function hasChapterNode(node: ImportPreviewNode): boolean {
  return node.kind === "chapter" || (node.children?.some(hasChapterNode) ?? false);
}

function countImportPreview(nodes: ImportPreviewNode[]): ImportPreview["counts"] {
  const counts: ImportPreview["counts"] = { volumes: 0, chapters: 0, txt: 0, md: 0, docx: 0, pdf: 0 };

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
    path: session.sourceFolderPath,
    name: basename(session.sourceFolderPath)
  };
}

async function scanImportSession(importSessionId: unknown): Promise<ImportPreview> {
  const session = readImportSession(importSessionId);
  const nodes = await scanImportDirectory(session.sourceFolderPath);

  return {
    importSessionId: session.id,
    sourceFolderName: basename(session.sourceFolderPath),
    generatedAt: new Date().toISOString(),
    nodes,
    counts: countImportPreview(nodes)
  };
}

async function readImportSourceFile(session: ImportSession, fileId: unknown): Promise<ImportSourceFile> {
  const safeFileId = assertId(fileId, "fileId");
  const relativePath = importRelativePathFromId(safeFileId);
  const sourcePath = sourceChildPath(session.sourceFolderPath, ...relativePath.split("/"));
  const sourceStat = await stat(sourcePath);

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
    return await extractPdfTextWithPdfParse(sourcePath);
  } catch {
    // ponytail: fallback only when the primary parser throws; richer diagnostics can wait for import history.
    return extractPdfTextWithPdfjs(sourcePath);
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

function importTextToHtml(text: string): string {
  const normalized = normalizeImportText(text).trim();

  if (!normalized) {
    return "<p></p>";
  }

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeImportText(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
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

function readImportPlan(input: unknown): { seriesTitle: string; chapters: ImportPlanChapter[] } {
  const record = assertRecord(input);
  const chapters = record.chapters;

  if (!Array.isArray(chapters)) {
    throw new Error("chapters must be an array.");
  }

  return {
    seriesTitle: readRequiredString(record, "seriesTitle"),
    chapters: chapters.map(readImportPlanChapter)
  };
}

async function copyImportedPdf(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string,
  chapterId: string,
  sourcePath: string
): Promise<void> {
  const targetPath = chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.pdf");
  const tmpPath = `${targetPath}.tmp`;

  await copyFile(sourcePath, tmpPath);
  await rename(tmpPath, targetPath);
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
    throw new Error("No TXT, MD, or PDF chapters could be imported.");
  }

  const series = await createSeriesMetadata(libraryPath, { title: plan.seriesTitle });
  const category = await createCategoryMetadata(libraryPath, series.id, { type: "light-novel", title: "Light Novel" });
  const volumes = new Map<string, VolumeMetadata>();
  let imported = 0;

  for (const chapter of importableChapters) {
    try {
      let volume = volumes.get(chapter.volumeTitle);

      if (!volume) {
        volume = await createVolumeMetadata(libraryPath, series.id, category.id, { title: chapter.volumeTitle });
        volumes.set(chapter.volumeTitle, volume);
      }

      const metadata = await createNovelChapterMetadata(libraryPath, series.id, category.id, volume.id, {
        title: chapter.title,
        translationStatus: "draft",
        hasOriginalPdf: chapter.sourceFile.fileType === "pdf",
        originalFileName: chapter.sourceFile.fileType === "pdf" ? basename(chapter.sourceFile.relativePath) : null
      });

      if (chapter.sourceFile.fileType === "pdf") {
        await copyImportedPdf(libraryPath, series.id, category.id, volume.id, metadata.id, chapter.sourceFile.sourcePath);
      }

      await saveNovelChapterContent(libraryPath, series.id, category.id, volume.id, metadata.id, {
        html: importTextToHtml(chapter.text)
      });
      imported += 1;
      const unsupportedPdf = chapter.sourceFile.fileType === "pdf" && normalizeImportText(chapter.text).trim() === "";
      logs.push({
        status: unsupportedPdf ? "unsupported" : "imported",
        fileId: chapter.fileId,
        title: chapter.title,
        message:
          chapter.sourceFile.fileType === "pdf"
            ? unsupportedPdf
              ? `Saved original PDF ${chapter.sourceFile.relativePath}; no extractable text was found.`
              : `Imported ${chapter.sourceFile.relativePath} and saved original PDF.`
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
  await ensureJsonFile(libraryChildPath(libraryPath, "index", "search-index.json"), (): SearchIndex => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documents: []
  }));
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

async function readSeriesCoverDataUrl(libraryPath: string, entry: SeriesIndexEntry): Promise<string | null> {
  if (!entry.coverImage) {
    return null;
  }

  try {
    const fileName = basename(entry.coverImage);
    const cover = await readFile(libraryChildPath(libraryPath, "series", entry.id, fileName));
    // ponytail: data URLs are enough for MVP; add thumbnails/protocol if cover loading gets slow.
    return `data:${imageMimeType(fileName)};base64,${cover.toString("base64")}`;
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
    status: entry.status ?? "planning",
    coverDataUrl: await readSeriesCoverDataUrl(libraryPath, entry)
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
  return metadata;
}

async function moveSeriesToTrash(libraryPath: string, seriesId: string): Promise<{ id: string; trashPath: string }> {
  const id = assertId(seriesId, "seriesId");
  await readSeriesMetadata(libraryPath, id);

  const trashPath = trashSeriesDirectoryPath(libraryPath, id);
  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await rename(seriesDirectoryPath(libraryPath, id), trashPath);
  await rebuildSeriesIndex(libraryPath);

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

  return { id: category.id, trashPath };
}

function assertNovelCategory(category: CategoryMetadata): void {
  if (category.type === "manga") {
    throw new Error("Manga categories do not support novel volumes.");
  }
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
  assertNovelCategory(category);

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
  assertNovelCategory(category);

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
  assertNovelCategory(category);

  const current = await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId);
  const metadata = parseVolumeUpdateInput(input, current);
  await writeJsonFile(volumeMetaPath(libraryPath, seriesId, categoryId, volumeId), metadata, { backup: true });
  return metadata;
}

async function moveVolumeToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string
): Promise<{ id: string; trashPath: string }> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  assertNovelCategory(category);
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

  return { id: volume.id, trashPath };
}

async function assertNovelChapterScope(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null
): Promise<{ category: CategoryMetadata; volume: VolumeMetadata | null }> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  assertNovelCategory(category);

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
  return progress.chapters[chapterProgressKey(categoryId, volumeId, chapterId)] ?? { scrollTop: 0, updatedAt: null };
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

  return { id: chapter.id, trashPath };
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

  ipcMain.handle("series:get", async (_event, seriesId: unknown): Promise<ApiResponse<SeriesMetadata>> => {
    try {
      return ok(await readSeriesMetadata(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId")));
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
    async (_event, seriesId: unknown, input: unknown): Promise<ApiResponse<SeriesMetadata>> => {
      try {
        return ok(await updateSeriesMetadata(await currentLibraryPathOrThrow(), assertId(seriesId, "seriesId"), input));
      } catch (error) {
        return fail(ErrorCode.SERIES_CRUD_FAILED, "Could not update series.", String(error));
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
    async (_event, seriesId: unknown, categoryId: unknown, volumeId: unknown): Promise<ApiResponse<NovelChapterMetadata[]>> => {
      try {
        return ok(
          await listNovelChapterMetadata(
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
    ): Promise<ApiResponse<NovelChapterMetadata>> => {
      try {
        return ok(
          await readNovelChapterMetadata(
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
    ): Promise<ApiResponse<NovelChapterMetadata>> => {
      try {
        return ok(
          await createNovelChapterMetadata(
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
    ): Promise<ApiResponse<NovelChapterMetadata>> => {
      try {
        return ok(
          await updateNovelChapterMetadata(
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
          await moveNovelChapterToTrash(
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

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
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
