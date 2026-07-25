import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const app = {
  getPath(name: string): string {
    if (name === "userData") {
      return join(process.cwd(), "temp-test-app-data");
    }
    return join(process.cwd(), "temp-test-library");
  }
};

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
    return {
      canceled: false,
      filePaths: [join(process.cwd(), "temp-test-library")]
    };
  }
};

export class BrowserWindow {
  private closedListener: (() => void) | null = null;
  private loadedFile = "";
  private visible = false;

  webContents = {
    getURL: (): string => this.loadedFile ? pathToFileURL(this.loadedFile).href : ""
  };

  static fromWebContents(): BrowserWindow | null {
    return new BrowserWindow();
  }

  async loadFile(filePath: string): Promise<void> {
    this.loadedFile = filePath;
  }

  once(event: string, listener: () => void): void {
    if (event === "closed") {
      this.closedListener = listener;
    }
  }

  show(): void {
    this.visible = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.visible = false;
    this.closedListener?.();
  }
}

export const ipcMain = {
  handle(): void {}
};
