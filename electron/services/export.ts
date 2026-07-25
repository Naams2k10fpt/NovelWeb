import { app, BrowserWindow, dialog, type SaveDialogOptions } from "electron";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getContent, readChapterMetadata } from "./chapter";
import { readSeriesMetadata } from "./series";

export type ExportResult = {
  path: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

export function safeExportFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim() || "chapter";
}

export function buildChapterPdfHtml(seriesTitle: string, chapterTitle: string, chapterHtml: string): string {
  const body = chapterHtml.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, "").trim() || "<p></p>";

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>${escapeHtml(chapterTitle)}</title>
  <style>
    @page { size: A4; margin: 20mm 18mm 22mm; }
    body { color: #171717; font-family: "Noto Serif", "Times New Roman", serif; font-size: 12pt; line-height: 1.7; overflow-wrap: anywhere; }
    header { border-bottom: 1px solid #d4d4d4; margin-bottom: 2rem; padding-bottom: 1rem; }
    header p { color: #666; font-size: 10pt; margin: 0 0 .5rem; }
    h1 { font-size: 24pt; line-height: 1.25; margin: 0; }
    h2, h3 { break-after: avoid; }
    p { orphans: 3; widows: 3; }
    img { break-inside: avoid; display: block; height: auto; margin: 1.5rem auto; max-height: 235mm; max-width: 100%; object-fit: contain; }
    blockquote { border-left: 3px solid #aaa; margin-left: 0; padding-left: 1rem; }
    pre { overflow-wrap: anywhere; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <p>${escapeHtml(seriesTitle)}</p>
    <h1>${escapeHtml(chapterTitle)}</h1>
  </header>
  <article>${body}</article>
</body>
</html>`;
}

export async function exportChapterToPdf(
  ownerWindow: BrowserWindow | null,
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ExportResult | null> {
  const [series, chapter, content] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    readChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId),
    getContent(libraryPath, seriesId, categoryId, volumeId, chapterId)
  ]);
  const options: SaveDialogOptions = {
    title: "Export chapter to PDF",
    defaultPath: `${safeExportFileName(chapter.title)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  };
  const selection = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);

  if (selection.canceled || !selection.filePath) {
    return null;
  }

  const filePath = selection.filePath.toLowerCase().endsWith(".pdf")
    ? selection.filePath
    : `${selection.filePath}.pdf`;
  const tempPdfPath = `${filePath}.tmp`;
  const tempDirectory = await mkdtemp(join(app.getPath("temp"), "novelweb-export-"));
  const htmlPath = join(tempDirectory, "chapter.html");
  const exportWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await writeFile(htmlPath, buildChapterPdfHtml(series.title, chapter.title, content.html), "utf8");
    await exportWindow.loadFile(htmlPath);
    const pdf = await exportWindow.webContents.printToPDF({
      pageSize: "A4",
      preferCSSPageSize: true,
      printBackground: true
    });
    await writeFile(tempPdfPath, pdf);
    await rename(tempPdfPath, filePath);
    return { path: filePath };
  } finally {
    exportWindow.destroy();
    await Promise.all([
      rm(tempPdfPath, { force: true }),
      rm(tempDirectory, { recursive: true, force: true })
    ]);
  }
}
