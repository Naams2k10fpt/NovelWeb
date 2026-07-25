import { app, BrowserWindow, dialog, type SaveDialogOptions } from "electron";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import {
  getContent,
  listChapterMetadata,
  readChapterMetadata,
  readHtmlAttribute,
  removeHtmlAttribute,
  setHtmlAttribute
} from "./chapter";
import { readSeriesMetadata } from "./series";
import { listCategoryMetadata } from "./category";
import { listVolumeMetadata, readVolumeMetadata } from "./volume";
import { type SeriesMetadata } from "../schemas/series";

export type ExportResult = {
  path: string;
};

type PdfChapter = {
  title: string;
  html: string;
};

type ChapterEpubInput = {
  identifier: string;
  title: string;
  seriesTitle: string;
  language: string;
  creator: string | null;
  html: string;
  modifiedAt: string;
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
    .series-part { break-before: page; }
    .series-chapter + .series-chapter { break-before: page; }
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
  chapters: PdfChapter[]
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

export function buildSeriesPdfHtml(
  series: Pick<SeriesMetadata, "title" | "originalTitle" | "originalAuthor" | "translator" | "description">,
  groups: Array<{ title: string; chapters: PdfChapter[] }>
): string {
  const details = [
    series.originalTitle && `<p><strong>Original title:</strong> ${escapeHtml(series.originalTitle)}</p>`,
    series.originalAuthor && `<p><strong>Author:</strong> ${escapeHtml(series.originalAuthor)}</p>`,
    series.translator && `<p><strong>Translator:</strong> ${escapeHtml(series.translator)}</p>`
  ].filter(Boolean).join("");
  const tableOfContents = groups
    .map(
      (group, groupIndex) => `<li><a href="#part-${groupIndex + 1}">${escapeHtml(group.title)}</a>
      <ol>${group.chapters
        .map(
          (chapter, chapterIndex) =>
            `<li><a href="#part-${groupIndex + 1}-chapter-${chapterIndex + 1}">${escapeHtml(chapter.title)}</a></li>`
        )
        .join("")}</ol>
    </li>`
    )
    .join("");
  const parts = groups
    .map(
      (group, groupIndex) => `<section class="series-part" id="part-${groupIndex + 1}">
    <h1>${escapeHtml(group.title)}</h1>
    ${group.chapters
      .map(
        (chapter, chapterIndex) => `<section class="series-chapter" id="part-${groupIndex + 1}-chapter-${chapterIndex + 1}">
      <h2>${escapeHtml(chapter.title)}</h2>
      ${chapterBody(chapter.html)}
    </section>`
      )
      .join("\n")}
  </section>`
    )
    .join("\n");

  return buildPdfHtml(series.title, `
  <section class="title-page">
    <h1>${escapeHtml(series.title)}</h1>
    ${details}
    ${series.description ? `<p>${escapeHtml(series.description)}</p>` : ""}
  </section>
  <nav class="toc">
    <h1>Table of Contents</h1>
    <ol>${tableOfContents}</ol>
  </nav>
  ${parts}`);
}

function epubModifiedDate(value: string): string {
  const date = new Date(value);
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function prepareEpubHtml(html: string): { html: string; images: Array<{ path: string; mediaType: string; data: Buffer }> } {
  const images: Array<{ path: string; mediaType: string; data: Buffer }> = [];
  const preparedHtml = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const source = readHtmlAttribute(tag, "src");
    const match = source?.match(/^data:(image\/(?:gif|jpeg|png|webp));base64,([a-z0-9+/=\s]+)$/i);

    if (!match) {
      return tag;
    }

    const mediaType = match[1].toLowerCase();
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
    const path = `images/image-${images.length + 1}.${extension}`;
    images.push({ path, mediaType, data: Buffer.from(match[2].replace(/\s/g, ""), "base64") });
    return removeHtmlAttribute(setHtmlAttribute(tag, "src", path), "data-asset-src");
  });

  return {
    html: preparedHtml
      .replace(/&nbsp;/gi, "&#160;")
      .replace(/<(br|hr|img)\b([^>]*?)(?<!\/)>/gi, "<$1$2 />"),
    images
  };
}

export async function buildChapterEpub(input: ChapterEpubInput): Promise<Buffer> {
  const zip = new JSZip();
  const prepared = prepareEpubHtml(chapterBody(input.html));
  const creator = input.creator ? `<dc:creator>${escapeHtml(input.creator)}</dc:creator>` : "";
  const imageManifest = prepared.images
    .map(
      (image, index) =>
        `<item id="image-${index + 1}" href="${image.path}" media-type="${image.mediaType}"/>`
    )
    .join("\n    ");

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeHtml(input.identifier)}</dc:identifier>
    <dc:title>${escapeHtml(input.title)}</dc:title>
    <dc:language>${escapeHtml(input.language)}</dc:language>
    ${creator}
    <meta property="dcterms:modified">${epubModifiedDate(input.modifiedAt)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
    ${imageManifest}
  </manifest>
  <spine><itemref idref="chapter-1"/></spine>
</package>`);
  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeHtml(input.language)}" xml:lang="${escapeHtml(input.language)}">
<head><title>Table of Contents</title></head>
<body><nav epub:type="toc"><h1>${escapeHtml(input.seriesTitle)}</h1><ol><li><a href="chapter-1.xhtml">${escapeHtml(input.title)}</a></li></ol></nav></body>
</html>`);
  zip.file("OEBPS/chapter-1.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${escapeHtml(input.language)}" xml:lang="${escapeHtml(input.language)}">
<head>
  <title>${escapeHtml(input.title)}</title>
  <style>body{font-family:serif;line-height:1.7}img{display:block;height:auto;margin:1.5em auto;max-width:100%}</style>
</head>
<body><h1>${escapeHtml(input.title)}</h1>${prepared.html}</body>
</html>`);
  prepared.images.forEach((image) => zip.file(`OEBPS/${image.path}`, image.data));

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });
}

async function chooseExportPath(
  ownerWindow: BrowserWindow | null,
  title: string,
  defaultFileName: string,
  extension: "pdf" | "epub"
): Promise<string | null> {
  const format = extension.toUpperCase();
  const options: SaveDialogOptions = {
    title,
    defaultPath: `${safeExportFileName(defaultFileName)}.${extension}`,
    filters: [{ name: format, extensions: [extension] }]
  };
  const selection = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);

  if (selection.canceled || !selection.filePath) {
    return null;
  }

  return selection.filePath.toLowerCase().endsWith(`.${extension}`)
    ? selection.filePath
    : `${selection.filePath}.${extension}`;
}

async function writeExportFile(filePath: string, content: Buffer): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function printHtmlToPdf(
  ownerWindow: BrowserWindow | null,
  dialogTitle: string,
  defaultFileName: string,
  html: string
): Promise<ExportResult | null> {
  const filePath = await chooseExportPath(ownerWindow, dialogTitle, defaultFileName, "pdf");
  if (!filePath) {
    return null;
  }

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
    await writeExportFile(filePath, pdf);
    return { path: filePath };
  } finally {
    exportWindow.destroy();
    await rm(tempDirectory, { recursive: true, force: true });
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

export async function exportChapterToEpub(
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
  const filePath = await chooseExportPath(ownerWindow, "Export chapter to EPUB", chapter.title, "epub");
  if (!filePath) {
    return null;
  }

  await writeExportFile(
    filePath,
    await buildChapterEpub({
      identifier: `urn:uuid:${chapter.id}`,
      title: chapter.title,
      seriesTitle: series.title,
      language: series.language,
      creator: series.originalAuthor,
      html: content.html,
      modifiedAt: chapter.updatedAt
    })
  );
  return { path: filePath };
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
    readPdfChapters(libraryPath, seriesId, categoryId, volumeId)
  ]);

  return printHtmlToPdf(
    ownerWindow,
    "Export volume to PDF",
    `${series.title} - ${volume.title}`,
    buildVolumePdfHtml(
      series.title,
      volume.title,
      chapters
    )
  );
}

async function readPdfChapters(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null
): Promise<PdfChapter[]> {
  const chapters = await listChapterMetadata(libraryPath, seriesId, categoryId, volumeId);
  const contents = await Promise.all(
    chapters.map((chapter) => getContent(libraryPath, seriesId, categoryId, volumeId, chapter.id))
  );
  return chapters.map((chapter, index) => ({ title: chapter.title, html: contents[index].html }));
}

export async function exportSeriesToPdf(
  ownerWindow: BrowserWindow | null,
  libraryPath: string,
  seriesId: string
): Promise<ExportResult | null> {
  const [series, categories] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    listCategoryMetadata(libraryPath, seriesId)
  ]);
  const groups = (
    await Promise.all(
      categories.map(async (category) => {
        if (category.type === "web-novel") {
          return [{
            title: category.title,
            chapters: await readPdfChapters(libraryPath, seriesId, category.id, null)
          }];
        }

        const volumes = await listVolumeMetadata(libraryPath, seriesId, category.id);
        return Promise.all(
          volumes.map(async (volume) => ({
            title: `${category.title} — ${volume.title}`,
            chapters: await readPdfChapters(libraryPath, seriesId, category.id, volume.id)
          }))
        );
      })
    )
  ).flat();

  return printHtmlToPdf(
    ownerWindow,
    "Export series to PDF",
    series.title,
    buildSeriesPdfHtml(series, groups)
  );
}
