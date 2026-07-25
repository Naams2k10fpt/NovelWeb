import { app, BrowserWindow, dialog, type SaveDialogOptions } from "electron";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getContent, listChapterMetadata, readChapterMetadata } from "./chapter";
import { readSeriesMetadata } from "./series";
import { readVolumeMetadata } from "./volume";

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

function chapterBody(chapterHtml: string): string {
  return chapterHtml.replace(/^\s*<h1\b[^>]*>[\s\S]*?<\/h1>\s*/i, "").trim() || "<p></p>";
}

function buildPdfHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>${escapeHtml(title)}</title>
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
    .title-page, .toc { break-after: page; }
    .title-page { align-items: center; display: flex; flex-direction: column; justify-content: center; min-height: 220mm; text-align: center; }
    .title-page p { color: #666; }
    .toc a { color: inherit; text-decoration: none; }
    .chapter { break-before: page; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export function buildChapterPdfHtml(seriesTitle: string, chapterTitle: string, chapterHtml: string): string {
  return buildPdfHtml(chapterTitle, `
  <header>
    <p>${escapeHtml(seriesTitle)}</p>
    <h1>${escapeHtml(chapterTitle)}</h1>
  </header>
  <article>${chapterBody(chapterHtml)}</article>`);
}

export function buildVolumePdfHtml(
  seriesTitle: string,
  volumeTitle: string,
  chapters: Array<{ title: string; html: string }>
): string {
  const tableOfContents = chapters
    .map((chapter, index) => `<li><a href="#chapter-${index + 1}">${escapeHtml(chapter.title)}</a></li>`)
    .join("");
  const chapterSections = chapters
    .map(
      (chapter, index) => `<section class="chapter" id="chapter-${index + 1}">
    <h1>${escapeHtml(chapter.title)}</h1>
    ${chapterBody(chapter.html)}
  </section>`
    )
    .join("\n");

  return buildPdfHtml(volumeTitle, `
  <section class="title-page">
    <p>${escapeHtml(seriesTitle)}</p>
    <h1>${escapeHtml(volumeTitle)}</h1>
  </section>
  <nav class="toc">
    <h1>Table of Contents</h1>
    <ol>${tableOfContents}</ol>
  </nav>
  ${chapterSections}`);
}

async function printHtmlToPdf(
  ownerWindow: BrowserWindow | null,
  dialogTitle: string,
  defaultFileName: string,
  html: string
): Promise<ExportResult | null> {
  const options: SaveDialogOptions = {
    title: dialogTitle,
    defaultPath: `${safeExportFileName(defaultFileName)}.pdf`,
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
  const htmlPath = join(tempDirectory, "export.html");
  const exportWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  try {
    await writeFile(htmlPath, html, "utf8");
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
  return printHtmlToPdf(
    ownerWindow,
    "Export chapter to PDF",
    chapter.title,
    buildChapterPdfHtml(series.title, chapter.title, content.html)
  );
}

export async function exportVolumeToPdf(
  ownerWindow: BrowserWindow | null,
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string
): Promise<ExportResult | null> {
  const [series, volume, chapters] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId),
    listChapterMetadata(libraryPath, seriesId, categoryId, volumeId)
  ]);
  const contents = await Promise.all(
    chapters.map((chapter) => getContent(libraryPath, seriesId, categoryId, volumeId, chapter.id))
  );

  return printHtmlToPdf(
    ownerWindow,
    "Export volume to PDF",
    `${series.title} - ${volume.title}`,
    buildVolumePdfHtml(
      series.title,
      volume.title,
      chapters.map((chapter, index) => ({ title: chapter.title, html: contents[index].html }))
    )
  );
}
