import { join } from "node:path";

export const app = {
  getPath(name: string): string {
    if (name === "userData") {
      return join(process.cwd(), "temp-test-library", "userData");
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
  static fromWebContents(): BrowserWindow | null {
    return new BrowserWindow();
  }
}

export const ipcMain = {
  handle(): void {}
};
