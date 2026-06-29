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

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const ErrorCode = {
  LIBRARY_FOLDER_LOAD_FAILED: "LIBRARY_FOLDER_LOAD_FAILED",
  LIBRARY_FOLDER_CHOOSE_FAILED: "LIBRARY_FOLDER_CHOOSE_FAILED",
  SERIES_CRUD_FAILED: "SERIES_CRUD_FAILED"
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
    updatedAt?: string;
  }>;
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

async function currentLibraryPathOrThrow(): Promise<string> {
  const settings = await readAppSettings();

  if (!settings.currentLibraryPath) {
    throw new Error("No Library folder selected.");
  }

  await ensureLibraryFiles(settings.currentLibraryPath);
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

function seriesDirectoryPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(libraryPath, "series", assertId(seriesId, "seriesId"));
}

function seriesMetaPath(libraryPath: string, seriesId: string): string {
  return libraryChildPath(libraryPath, "series", assertId(seriesId, "seriesId"), "meta.json");
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
          updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : undefined
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await writeJsonFile(libraryChildPath(libraryPath, "index", "series-index.json"), {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    series
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

async function listSeriesMetadata(libraryPath: string): Promise<SeriesMetadata[]> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const series: SeriesMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      series.push(await readSeriesMetadata(libraryPath, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return series.sort((left, right) => left.title.localeCompare(right.title));
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
}

function registerSeriesIpc(): void {
  ipcMain.handle("series:list", async (): Promise<ApiResponse<SeriesMetadata[]>> => {
    try {
      return ok(await listSeriesMetadata(await currentLibraryPathOrThrow()));
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
