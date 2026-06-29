import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const ErrorCode = {
  LIBRARY_FOLDER_LOAD_FAILED: "LIBRARY_FOLDER_LOAD_FAILED",
  LIBRARY_FOLDER_CHOOSE_FAILED: "LIBRARY_FOLDER_CHOOSE_FAILED"
} as const;

const REQUIRED_LIBRARY_DIRECTORIES = ["index", "series", "backups", ".trash"] as const;
const SUPPORTED_SCHEMA_VERSION = 1;

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
  const tmpPath = `${filePath}.tmp`;

  await mkdir(dirname(filePath), { recursive: true });
  if (options.backup) {
    await backupExistingFile(filePath);
  }

  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
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
