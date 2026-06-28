import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type AppSettings = {
  currentLibraryPath?: string;
};

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail(code: string, message: string, details?: unknown): ApiResponse<never> {
  return { ok: false, error: { code, message, details } };
}

function appSettingsPath(): string {
  return join(app.getPath("userData"), "app-settings.json");
}

async function readAppSettings(): Promise<AppSettings> {
  try {
    return JSON.parse(await readFile(appSettingsPath(), "utf8")) as AppSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeAppSettings(settings: AppSettings): Promise<void> {
  const filePath = appSettingsPath();
  const tmpPath = `${filePath}.tmp`;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  try {
    await copyFile(filePath, `${filePath}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await rename(tmpPath, filePath);
}

function registerLibraryIpc(): void {
  ipcMain.handle("library:getCurrent", async (): Promise<ApiResponse<{ path: string | null }>> => {
    try {
      const settings = await readAppSettings();
      return ok({ path: settings.currentLibraryPath ?? null });
    } catch (error) {
      return fail("APP_SETTINGS_READ_FAILED", "Could not read app settings.", String(error));
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
      await writeAppSettings({ ...settings, currentLibraryPath });

      return ok({ path: currentLibraryPath });
    } catch (error) {
      return fail("LIBRARY_FOLDER_CHOOSE_FAILED", "Could not choose Library folder.", String(error));
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
      nodeIntegration: false
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
