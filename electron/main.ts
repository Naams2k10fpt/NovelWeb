import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  CHAPTER_CRUD_FAILED: "CHAPTER_CRUD_FAILED"
} as const;

const REQUIRED_LIBRARY_DIRECTORIES = ["index", "series", "backups", ".trash"] as const;
const SUPPORTED_SCHEMA_VERSION = 1;
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

async function ensureLibraryDirectory(libraryPath: string, directoryName: string): Promise<void> {
  await mkdir(libraryChildPath(libraryPath, directoryName), { recursive: true });
}

async function assertDirectory(directoryPath: string): Promise<void> {
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Expected directory: ${directoryPath}`);
  }
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
