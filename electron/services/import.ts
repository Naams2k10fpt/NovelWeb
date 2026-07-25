import { createHash, randomUUID } from "node:crypto";
import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { readdir, stat, mkdir, readFile, copyFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { GlobalWorkerOptions, OPS, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  assertId,
  assertRecord,
  assertSupportedSchemaVersion,
  chapterAssetPath,
  chapterAssetSource,
  chapterContentPath,
  chapterAssetsDirectoryPath,
  IMAGE_FILE_EXTENSIONS,
  IMPORT_FILE_TYPES,
  libraryChildPath,
  moveDirectoryToTrash,
  optionalVolumeId,
  readJsonFile,
  readRequiredString,
  readRequiredText,
  SUPPORTED_SCHEMA_VERSION,
  trashItemDirectoryPath,
  writeJsonFile,
  writeTextFile,
  appendImportLog,
  type ApiResponse,
  type JsonRecord
} from "./base";
import { type SeriesMetadata } from "../schemas/series";
import { type CategoryMetadata } from "../schemas/category";
import { type VolumeMetadata } from "../schemas/volume";
import { readSeriesMetadata, createSeriesMetadata } from "./series";
import { createCategoryMetadata, readCategoryMetadata } from "./category";
import { createVolumeMetadata, readVolumeMetadata, listVolumeMetadata } from "./volume";
import { createNovelChapterMetadata, saveNovelChapterContent, escapeHtmlAttribute } from "./chapter";

const requireNodeModule = createRequire(import.meta.url);
GlobalWorkerOptions.workerSrc = pathToFileURL(requireNodeModule.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

export type ImportSessionFile = {
  fileId: string;
  name: string;
  relativePath: string;
  sourcePath: string;
  fileType: ImportFileType;
  sizeBytes: number;
};

export type ImportSession = {
  id: string;
  sourceFolderPath?: string;
  sourceFiles?: ImportSessionFile[];
  createdAt: string;
};

export const importSessions = new Map<string, ImportSession>();

export type ImportTextFileType = (typeof IMPORT_FILE_TYPES)[keyof typeof IMPORT_FILE_TYPES];
export type ImportFileType = ImportTextFileType | "images";

export type ImportPreviewNode = {
  id: string;
  name: string;
  relativePath: string;
  kind: "volume" | "folder" | "chapter";
  fileType?: ImportFileType;
  sizeBytes?: number;
  children?: ImportPreviewNode[];
};

export type ImportPreview = {
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
    images: number;
  };
};

export type ImportSourceFile = {
  fileId: string;
  relativePath: string;
  sourcePath: string;
  fileType: ImportFileType | null;
};

export type ImportPlanChapter = {
  fileId: string;
  title: string;
  volumeTitle: string;
};

export type PdfCanvas = {
  width: number;
  height: number;
  getContext(type: "2d", options?: unknown): CanvasRenderingContext2D;
  toBuffer(mimeType: "image/png"): Buffer;
};

export type PdfCanvasEntry = {
  canvas: PdfCanvas;
  context: CanvasRenderingContext2D;
};

export type PdfCanvasFactory = {
  create(width: number, height: number): PdfCanvasEntry;
  reset(entry: PdfCanvasEntry, width: number, height: number): void;
  destroy(entry: PdfCanvasEntry): void;
};

export type PdfImageImportResult = {
  html: string;
  count: number;
  error: string | null;
};

export type NapiCanvasModule = {
  createCanvas(width: number, height: number): PdfCanvas;
};

function createPdfCanvas(width: number, height: number): PdfCanvas {
  return (requireNodeModule("@napi-rs/canvas") as NapiCanvasModule).createCanvas(width, height);
}

export class PdfNodeCanvasFactory implements PdfCanvasFactory {
  create(width: number, height: number): PdfCanvasEntry {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size.");
    }

    const canvas = createPdfCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }

  reset(entry: PdfCanvasEntry, width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      throw new Error("Invalid canvas size.");
    }

    entry.canvas.width = width;
    entry.canvas.height = height;
  }

  destroy(entry: PdfCanvasEntry): void {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }
}

export type ImportVolumeMode = "source" | "existing" | "none";

export type ImportTarget =
  | {
      mode: "new";
      seriesTitle: string;
    }
  | {
      mode: "existing";
      seriesId: string;
      categoryId: string;
      volumeMode: ImportVolumeMode;
      volumeId: string | null;
    };

export type ImportLogEntry = {
  status: "imported" | "unsupported" | "skipped" | "failed";
  fileId: string;
  title: string;
  message: string;
};

export type ImportReport = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  imported: number;
  unsupported: number;
  skipped: number;
  failed: number;
  logs: ImportLogEntry[];
};

export type ImportHashIndex = {
  schemaVersion: number;
  hashes: Record<string, string[]>;
};

export const PDF_IMAGE_RENDER_SCALE = 2;
export const PDF_IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
  OPS.paintImageXObjectRepeat,
  OPS.paintFormXObjectBegin
]);

export function readImportSession(importSessionId: unknown): ImportSession {
  const session = importSessions.get(assertId(importSessionId, "importSessionId"));

  if (!session) {
    throw new Error("Import session not found.");
  }

  return session;
}

export function sourceChildPath(sourceRootPath: string, ...parts: string[]): string {
  const sourceRoot = resolve(sourceRootPath);
  const targetPath = resolve(sourceRoot, ...parts);
  const relativePath = relative(sourceRoot, targetPath);

  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return targetPath;
  }

  throw new Error(`Refusing to access path outside import source: ${targetPath}`);
}

export function importFileType(fileName: string): ImportFileType | null {
  return IMPORT_FILE_TYPES[extname(fileName).toLowerCase() as keyof typeof IMPORT_FILE_TYPES] ?? null;
}

export function importFileId(relativeFilePath: string): string {
  return Buffer.from(relativeFilePath, "utf8").toString("base64url");
}

export function importRelativePathFromId(fileId: unknown): string {
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

export function isImportTextFileType(fileType: ImportFileType | null): fileType is ImportTextFileType {
  return fileType === "txt" || fileType === "md" || fileType === "docx" || fileType === "pdf";
}

export function isImportableFileType(fileType: ImportFileType | null): fileType is ImportFileType {
  return isImportTextFileType(fileType) || fileType === "images";
}

export function toImportRelativePath(parts: string[]): string {
  return parts.join("/");
}

export function isIllustrationsDirectoryName(name: string): boolean {
  return /^illustrations?$/i.test(name.trim());
}

export async function listImportImageFiles(directoryPath: string): Promise<Array<{ name: string; path: string; sizeBytes: number }>> {
  const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const files: Array<{ name: string; path: string; sizeBytes: number }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_FILE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue;
    }

    const path = join(directoryPath, entry.name);
    files.push({ name: entry.name, path, sizeBytes: (await stat(path)).size });
  }

  return files;
}

export function hasChapterNode(node: ImportPreviewNode): boolean {
  return node.kind === "chapter" || (node.children?.some(hasChapterNode) ?? false);
}

export function countImportPreview(nodes: ImportPreviewNode[]): ImportPreview["counts"] {
  const counts: ImportPreview["counts"] = { volumes: 0, chapters: 0, txt: 0, md: 0, docx: 0, pdf: 0, images: 0 };

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
      counts.images += childCounts.images;
    }
  }

  return counts;
}

export async function scanImportDirectory(sourceRootPath: string, parts: string[] = []): Promise<ImportPreviewNode[]> {
  const directoryPath = sourceChildPath(sourceRootPath, ...parts);
  const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  );
  const nodes: ImportPreviewNode[] = [];

  for (const entry of entries) {
    const childParts = [...parts, entry.name];
    const relativePath = toImportRelativePath(childParts);

    if (entry.isDirectory()) {
      if (isIllustrationsDirectoryName(entry.name)) {
        const imageFiles = await listImportImageFiles(sourceChildPath(sourceRootPath, ...childParts));

        if (imageFiles.length > 0) {
          nodes.push({
            id: importFileId(relativePath),
            name: entry.name,
            relativePath,
            kind: "chapter",
            fileType: "images",
            sizeBytes: imageFiles.reduce((total, file) => total + file.sizeBytes, 0)
          });
          continue;
        }
      }

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

export async function chooseImportSourceFolder(window: BrowserWindow | null): Promise<{ importSessionId: string; path: string; name: string } | null> {
  const options: OpenDialogOptions = {
    title: "Choose import source folder",
    properties: ["openDirectory"]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const sourceFolderPath = resolve(result.filePaths[0]);
  
  const directoryStat = await stat(sourceFolderPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Expected directory: ${sourceFolderPath}`);
  }

  const session: ImportSession = {
    id: randomUUID(),
    sourceFolderPath,
    createdAt: new Date().toISOString()
  };
  importSessions.set(session.id, session);

  return {
    importSessionId: session.id,
    path: sourceFolderPath,
    name: basename(sourceFolderPath)
  };
}

export function uniqueImportRelativePath(filePath: string, usedPaths: Set<string>): string {
  const fileName = basename(filePath);

  if (!usedPaths.has(fileName)) {
    usedPaths.add(fileName);
    return fileName;
  }

  const extension = extname(fileName);
  const nameWithoutExtension = fileName.slice(0, fileName.length - extension.length);
  let index = 2;

  while (usedPaths.has(`${nameWithoutExtension} (${index})${extension}`)) {
    index += 1;
  }

  const relativePath = `${nameWithoutExtension} (${index})${extension}`;
  usedPaths.add(relativePath);
  return relativePath;
}

export async function chooseImportSourceFiles(window: BrowserWindow | null): Promise<{ importSessionId: string; path: string; name: string } | null> {
  const options: OpenDialogOptions = {
    title: "Choose chapter files",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Novel chapter files", extensions: ["txt", "md", "docx", "pdf"] }]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const usedPaths = new Set<string>();
  const sourceFiles: ImportSessionFile[] = [];

  for (const filePath of result.filePaths.map((item) => resolve(item))) {
    const fileType = importFileType(filePath);
    const sourceStat = await stat(filePath);

    if (!fileType || !sourceStat.isFile()) {
      continue;
    }

    const relativePath = uniqueImportRelativePath(filePath, usedPaths);
    sourceFiles.push({
      fileId: importFileId(relativePath),
      name: basename(filePath),
      relativePath,
      sourcePath: filePath,
      fileType,
      sizeBytes: sourceStat.size
    });
  }

  if (sourceFiles.length === 0) {
    throw new Error("No supported chapter files were selected.");
  }

  const session: ImportSession = {
    id: randomUUID(),
    sourceFiles,
    createdAt: new Date().toISOString()
  };
  importSessions.set(session.id, session);

  return {
    importSessionId: session.id,
    path: sourceFiles.length === 1 ? sourceFiles[0].sourcePath : dirname(sourceFiles[0].sourcePath),
    name: sourceFiles.length === 1 ? sourceFiles[0].name : `${sourceFiles.length} chapter files`
  };
}

export function scanImportFiles(session: ImportSession): ImportPreviewNode[] {
  return (session.sourceFiles ?? []).map((sourceFile) => ({
    id: sourceFile.fileId,
    name: sourceFile.name,
    relativePath: sourceFile.relativePath,
    kind: "chapter",
    fileType: sourceFile.fileType,
    sizeBytes: sourceFile.sizeBytes
  }));
}

export async function scanImportSession(importSessionId: unknown): Promise<ImportPreview> {
  const session = readImportSession(importSessionId);
  const nodes = session.sourceFolderPath ? await scanImportDirectory(session.sourceFolderPath) : scanImportFiles(session);
  const sourceName = session.sourceFolderPath
    ? basename(session.sourceFolderPath)
    : session.sourceFiles?.length === 1
      ? session.sourceFiles[0].name
      : `${session.sourceFiles?.length ?? 0} chapter files`;

  return {
    importSessionId: session.id,
    sourceFolderName: sourceName,
    generatedAt: new Date().toISOString(),
    nodes,
    counts: countImportPreview(nodes)
  };
}

export async function readImportSourceFile(session: ImportSession, fileId: unknown): Promise<ImportSourceFile> {
  const safeFileId = assertId(fileId, "fileId");

  if (session.sourceFiles) {
    const sourceFile = session.sourceFiles.find((item) => item.fileId === safeFileId);

    if (!sourceFile) {
      throw new Error("Import source file not found.");
    }

    return {
      fileId: safeFileId,
      relativePath: sourceFile.relativePath,
      sourcePath: sourceFile.sourcePath,
      fileType: sourceFile.fileType
    };
  }

  if (!session.sourceFolderPath) {
    throw new Error("Import session has no source folder.");
  }

  const relativePath = importRelativePathFromId(safeFileId);
  const sourcePath = sourceChildPath(session.sourceFolderPath, ...relativePath.split("/"));
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory() && isIllustrationsDirectoryName(basename(relativePath))) {
    const imageFiles = await listImportImageFiles(sourcePath);

    if (imageFiles.length > 0) {
      return {
        fileId: safeFileId,
        relativePath,
        sourcePath,
        fileType: "images"
      };
    }
  }

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

export function normalizeImportText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function stripPdfPageMarkers(text: string): string {
  const lines = normalizeImportText(text).split("\n");
  const removeIndexes = new Set<number>();
  const pageMarkerPattern = /^[-\s]*(?:page\s*)?(\d+)\s*(?:of|\/)\s*(\d+)[-\s]*$/i;

  lines.forEach((line, index) => {
    const match = line.trim().match(pageMarkerPattern);
    if (!match) {
      return;
    }

    removeIndexes.add(index);

    for (const neighbor of [index - 2, index - 1, index + 1, index + 2]) {
      if (lines[neighbor]?.trim() === match[1]) {
        removeIndexes.add(neighbor);
      }
    }
  });

  return lines.filter((_, index) => !removeIndexes.has(index)).join("\n");
}

export async function extractPdfTextWithPdfParse(sourcePath: string): Promise<string> {
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

export async function extractPdfTextWithPdfjs(sourcePath: string): Promise<string> {
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

export async function extractPdfText(sourcePath: string): Promise<string> {
  try {
    return stripPdfPageMarkers(await extractPdfTextWithPdfParse(sourcePath));
  } catch {
    return stripPdfPageMarkers(await extractPdfTextWithPdfjs(sourcePath));
  }
}

export async function readImportSourceText(sourceFile: ImportSourceFile): Promise<string> {
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

export async function importSourceFileHash(sourceFile: ImportSourceFile): Promise<string | null> {
  return sourceFile.fileType === "images"
    ? null
    : createHash("sha256").update(await readFile(sourceFile.sourcePath)).digest("hex");
}

export async function readImportHashIndex(libraryPath: string): Promise<ImportHashIndex> {
  try {
    const index = await readJsonFile<ImportHashIndex>(libraryChildPath(libraryPath, "index", "import-hashes.json"));
    assertSupportedSchemaVersion("import-hashes.json", index);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, hashes: index.hashes ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, hashes: {} };
    }

    throw error;
  }
}

export async function writeImportHashIndex(libraryPath: string, index: ImportHashIndex): Promise<void> {
  await writeJsonFile(libraryChildPath(libraryPath, "index", "import-hashes.json"), index);
}

export function escapeImportText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownInlineToHtml(text: string): string {
  return escapeImportText(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"'<]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, '$1<a href="$2">$2</a>');
}

export function markdownImageToHtml(line: string): string | null {
  const image = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s"'<]+)\)$/);

  return image ? `<p><img alt="${escapeHtmlAttribute(image[1])}" src="${escapeHtmlAttribute(image[2])}"></p>` : null;
}

export function endsWithSentenceBreak(line: string): boolean {
  return /[.!?…。！？]["')\]}»”’]*$/.test(line.trim());
}

export function importBlockToParagraphs(block: string): string[] {
  const paragraphs: string[] = [];
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let paragraph = "";

  for (const line of lines) {
    if (!paragraph) {
      paragraph = line;
      continue;
    }

    if (endsWithSentenceBreak(paragraph)) {
      paragraphs.push(paragraph);
      paragraph = line;
      continue;
    }

    paragraph = `${paragraph} ${line}`;
  }

  if (paragraph) {
    paragraphs.push(paragraph);
  }

  return paragraphs;
}

export function importTextToHtml(text: string): string {
  const normalized = normalizeImportText(text).trim();

  if (!normalized) {
    return "<p></p>";
  }

  return normalized
    .split(/\n{2,}/)
    .flatMap(importBlockToParagraphs)
    .map((paragraph) => `<p>${escapeImportText(paragraph)}</p>`)
    .join("\n");
}

export function importMarkdownToHtml(text: string): string {
  const normalized = normalizeImportText(text).trim();

  if (!normalized) {
    return "<p></p>";
  }

  const html: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }

    html.push(`<p>${markdownInlineToHtml(paragraphLines.join(" "))}</p>`);
    paragraphLines = [];
  };
  const flushList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushCodeBlock = (): void => {
    html.push(`<pre><code>${escapeImportText(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    inCodeBlock = false;
  };

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const imageHtml = markdownImageToHtml(line);
    if (imageHtml) {
      flushParagraph();
      flushList();
      html.push(imageHtml);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h${heading[1].length}>${markdownInlineToHtml(heading[2].trim())}</h${heading[1].length}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      html.push(`<blockquote><p>${markdownInlineToHtml(line.slice(2).trim())}</p></blockquote>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    const nextListType = unordered ? "ul" : ordered ? "ol" : null;
    if (nextListType) {
      flushParagraph();
      if (listType !== nextListType) {
        flushList();
        listType = nextListType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${markdownInlineToHtml((unordered?.[1] ?? ordered?.[1] ?? "").trim())}</li>`);
      continue;
    }

    paragraphLines.push(line);
  }

  if (inCodeBlock) {
    flushCodeBlock();
  }
  flushParagraph();
  flushList();

  return html.join("\n");
}

export function importChapterTextToHtml(text: string, fileType: ImportFileType | null): string {
  return fileType === "md" ? importMarkdownToHtml(text) : importTextToHtml(text);
}

export function readImportPlanChapter(input: unknown): ImportPlanChapter {
  const record = assertRecord(input);
  const fileId = assertId(record.fileId, "fileId");
  const fallbackTitle = basename(importRelativePathFromId(fileId)).replace(/\.[^.]+$/, "");

  return {
    fileId,
    title: readRequiredText(record, "title").trim() || fallbackTitle,
    volumeTitle: readRequiredText(record, "volumeTitle").trim() || "Imported"
  };
}

export function readImportVolumeMode(value: unknown): ImportVolumeMode {
  if (value === undefined) {
    return "source";
  }

  if (value === "source" || value === "existing" || value === "none") {
    return value;
  }

  throw new Error("volumeMode is invalid.");
}

export function readImportTarget(rootRecord: JsonRecord): ImportTarget {
  if (rootRecord.target === undefined) {
    return { mode: "new", seriesTitle: readRequiredString(rootRecord, "seriesTitle") };
  }

  const record = assertRecord(rootRecord.target);
  const mode = readRequiredText(record, "mode").trim();

  if (mode === "new") {
    const seriesTitle =
      typeof record.seriesTitle === "string" && record.seriesTitle.trim()
        ? record.seriesTitle.trim()
        : readRequiredString(rootRecord, "seriesTitle");
    return { mode, seriesTitle };
  }

  if (mode === "existing") {
    const volumeMode = readImportVolumeMode(record.volumeMode);
    return {
      mode,
      seriesId: assertId(record.seriesId, "seriesId"),
      categoryId: assertId(record.categoryId, "categoryId"),
      volumeMode,
      volumeId: volumeMode === "existing" ? assertId(record.volumeId, "volumeId") : null
    };
  }

  throw new Error("target.mode is invalid.");
}

export function readImportPlan(input: unknown): { target: ImportTarget; chapters: ImportPlanChapter[] } {
  const record = assertRecord(input);
  const chapters = record.chapters;

  if (!Array.isArray(chapters)) {
    throw new Error("chapters must be an array.");
  }

  return {
    target: readImportTarget(record),
    chapters: chapters.map(readImportPlanChapter)
  };
}

export async function copyImportedPdf(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourcePath: string
): Promise<string> {
  const targetPath = chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.pdf");
  const tmpPath = `${targetPath}.tmp`;

  await copyFile(sourcePath, tmpPath);
  await rename(tmpPath, targetPath);
  return targetPath;
}

export function pdfCanvasFactory(pdf: PDFDocumentProxy): PdfCanvasFactory {
  const factory = pdf.canvasFactory as Partial<PdfCanvasFactory>;

  if (typeof factory.create !== "function" || typeof factory.destroy !== "function") {
    throw new Error("PDF canvas factory is not available.");
  }

  return factory as PdfCanvasFactory;
}

export async function pdfPageImageOperatorCount(page: PDFPageProxy): Promise<number> {
  const operatorList = await page.getOperatorList();
  return operatorList.fnArray.filter((operator) => PDF_IMAGE_OPERATORS.has(operator)).length;
}

export async function importPdfPageImages(
  factory: PdfCanvasFactory,
  page: PDFPageProxy,
  pageNumber: number,
  writeImage: (fileName: string, image: Buffer) => Promise<void>,
  log?: (message: string) => Promise<void>
): Promise<{ html: string[]; error: string | null }> {
  try {
    const imageOperatorCount = await pdfPageImageOperatorCount(page);
    await log?.(`pdf page=${pageNumber} imageOperators=${imageOperatorCount}`);

    if (imageOperatorCount === 0) {
      return { html: [], error: null };
    }

    const viewport = page.getViewport({ scale: PDF_IMAGE_RENDER_SCALE });
    const pageCanvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));

    try {
      const renderTask = page.render({
        canvas: pageCanvas.canvas as unknown as HTMLCanvasElement,
        canvasContext: pageCanvas.context,
        viewport
      });
      await renderTask.promise;

      const fileName = `${randomUUID()}.png`;
      const image = pageCanvas.canvas.toBuffer("image/png");
      await writeImage(fileName, image);
      await log?.(`pdf page=${pageNumber} rendered image=${fileName} bytes=${image.byteLength}`);
      return {
        html: [`<p><img alt="PDF page ${pageNumber}" src="${escapeHtmlAttribute(chapterAssetSource(fileName))}"></p>`],
        error: null
      };
    } finally {
      factory.destroy(pageCanvas);
    }
  } catch (error) {
    const message = `page ${pageNumber}: ${String(error)}`;
    await log?.(`pdf page=${pageNumber} error=${message}`);
    return { html: [], error: message };
  } finally {
    page.cleanup();
  }
}

export async function copyImportedPdfImages(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourcePath: string,
  log?: (message: string) => Promise<void>
): Promise<PdfImageImportResult> {
  try {
    await log?.(`pdf images start source=${sourcePath}`);
    const loadingTask = getDocument({
      data: new Uint8Array(await readFile(sourcePath)),
      CanvasFactory: PdfNodeCanvasFactory
    });
    const pdf = await loadingTask.promise;

    try {
      const factory = pdfCanvasFactory(pdf);
      const html: string[] = [];
      const errors: string[] = [];
      await log?.(`pdf loaded pages=${pdf.numPages}`);
      await mkdir(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), { recursive: true });

      const writeImage = async (fileName: string, image: Buffer): Promise<void> => {
        const targetPath = chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
        const tmpPath = `${targetPath}.tmp`;

        await writeFile(tmpPath, image);
        await rename(tmpPath, targetPath);
      };

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const pageResult = await importPdfPageImages(factory, await pdf.getPage(pageNumber), pageNumber, writeImage, log);
        html.push(...pageResult.html);
        if (pageResult.error) {
          errors.push(pageResult.error);
        }
      }

      await log?.(`pdf images done count=${html.length}${errors[0] ? ` firstError=${errors[0]}` : ""}`);
      return { html: html.join("\n"), count: html.length, error: errors[0] ?? null };
    } finally {
      await loadingTask.destroy();
    }
  } catch (error) {
    await log?.(`pdf images failed error=${String(error)}`);
    return { html: "", count: 0, error: String(error) };
  }
}

export async function copyImportedMarkdown(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourcePath: string
): Promise<void> {
  const targetPath = chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.md");
  const tmpPath = `${targetPath}.tmp`;

  await copyFile(sourcePath, tmpPath);
  await rename(tmpPath, targetPath);
}

export async function copyImportedIllustrations(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  sourceDirectoryPath: string
): Promise<string> {
  const imageFiles = await listImportImageFiles(sourceDirectoryPath);

  if (imageFiles.length === 0) {
    throw new Error("Illustrations folder has no supported images.");
  }

  await mkdir(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), { recursive: true });

  const html: string[] = [];
  for (const image of imageFiles) {
    const extension = extname(image.name).toLowerCase();
    const fileName = `${randomUUID()}${extension}`;
    const targetPath = chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
    const tmpPath = `${targetPath}.tmp`;

    await copyFile(image.path, tmpPath);
    await rename(tmpPath, targetPath);
    html.push(
      `<p><img alt="${escapeHtmlAttribute(basename(image.name, extension))}" src="${escapeHtmlAttribute(chapterAssetSource(fileName))}"></p>`
    );
  }

  return html.join("\n");
}

export async function prepareImportDestination(
  libraryPath: string,
  target: ImportTarget
): Promise<{
  series: SeriesMetadata;
  category: CategoryMetadata;
  volumeMode: ImportVolumeMode;
  fixedVolume: VolumeMetadata | null;
  volumes: Map<string, VolumeMetadata>;
}> {
  if (target.mode === "new") {
    const series = await createSeriesMetadata(libraryPath, { title: target.seriesTitle });
    const category = await createCategoryMetadata(libraryPath, series.id, { type: "light-novel", title: "Light Novel" });
    return { series, category, volumeMode: "source", fixedVolume: null, volumes: new Map() };
  }

  const series = await readSeriesMetadata(libraryPath, target.seriesId);
  const category = await readCategoryMetadata(libraryPath, series.id, target.categoryId);

  if (target.volumeMode === "none") {
    if (category.type !== "web-novel") {
      throw new Error("Direct category import is only for web-novel categories.");
    }

    return { series, category, volumeMode: "none", fixedVolume: null, volumes: new Map() };
  }

  if (target.volumeMode === "existing") {
    if (!target.volumeId) {
      throw new Error("volumeId is required when importing into an existing volume.");
    }

    const fixedVolume = await readVolumeMetadata(libraryPath, series.id, category.id, target.volumeId);
    return { series, category, volumeMode: "existing", fixedVolume, volumes: new Map([[fixedVolume.title, fixedVolume]]) };
  }

  const volumesList = await listVolumeMetadata(libraryPath, series.id, category.id);
  const volumes = new Map(volumesList.map((volume) => [volume.title, volume]));
  return { series, category, volumeMode: "source", fixedVolume: null, volumes };
}

export async function executeImport(libraryPath: string, importSessionId: unknown, input: unknown): Promise<ImportReport> {
  const session = readImportSession(importSessionId);
  const plan = readImportPlan(input);
  const log = (message: string): Promise<void> => appendImportLog(libraryPath, message);
  const logs: ImportLogEntry[] = [];
  const importHashIndex = await readImportHashIndex(libraryPath);
  const importableChapters: Array<
    ImportPlanChapter & { sourceFile: ImportSourceFile; sourceHash: string | null; text: string }
  > = [];

  await log(`import start session=${session.id} chapters=${plan.chapters.length}`);

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

      const text = sourceFile.fileType === "images" ? "" : normalizeImportText(await readImportSourceText(sourceFile));
      importableChapters.push({ ...chapter, sourceFile, sourceHash: await importSourceFileHash(sourceFile), text });
      await log(`import queued title=${JSON.stringify(chapter.title)} type=${sourceFile.fileType} source=${sourceFile.relativePath}`);
    } catch (error) {
      logs.push({
        status: "failed",
        fileId: chapter.fileId,
        title: chapter.title,
        message: String(error)
      });
      await log(`import queue failed title=${JSON.stringify(chapter.title)} error=${String(error)}`);
    }
  }

  if (importableChapters.length === 0) {
    throw new Error("No TXT, MD, DOCX, PDF, or illustrations chapters could be imported.");
  }

  const destination = await prepareImportDestination(libraryPath, plan.target);
  const { series, category, volumes } = destination;
  let imported = 0;

  for (const chapter of importableChapters) {
    try {
      let volume: VolumeMetadata | null = destination.fixedVolume;

      if (!volume && destination.volumeMode === "source") {
        volume = volumes.get(chapter.volumeTitle) ?? null;
      }

      if (!volume && destination.volumeMode === "source") {
        volume = await createVolumeMetadata(libraryPath, series.id, category.id, { title: chapter.volumeTitle });
        volumes.set(chapter.volumeTitle, volume);
      }

      const volumeId = volume?.id ?? null;
      if (chapter.sourceHash && importHashIndex.hashes[chapter.sourceHash]?.includes(series.id)) {
        logs.push({
          status: "skipped",
          fileId: chapter.fileId,
          title: chapter.title,
          message: `Skipped duplicate ${chapter.sourceFile.relativePath}.`
        });
        await log(`chapter skipped duplicate title=${JSON.stringify(chapter.title)} hash=${chapter.sourceHash}`);
        continue;
      }

      const metadata = await createNovelChapterMetadata(libraryPath, series.id, category.id, volumeId, {
        title: chapter.title,
        translationStatus: "draft",
        hasOriginalPdf: chapter.sourceFile.fileType === "pdf",
        originalFileName:
          chapter.sourceFile.fileType === "pdf" || chapter.sourceFile.fileType === "md"
            ? basename(chapter.sourceFile.relativePath)
            : null
      });

      let html = importChapterTextToHtml(chapter.text, chapter.sourceFile.fileType);
      let pdfImages: PdfImageImportResult = { html: "", count: 0, error: null };

      if (chapter.sourceFile.fileType === "images") {
        html = await copyImportedIllustrations(
          libraryPath,
          series.id,
          category.id,
          volumeId,
          metadata.id,
          chapter.sourceFile.sourcePath
        );
      } else if (chapter.sourceFile.fileType === "pdf") {
        const originalPdfPath = await copyImportedPdf(
          libraryPath,
          series.id,
          category.id,
          volumeId,
          metadata.id,
          chapter.sourceFile.sourcePath
        );
        await log(`pdf original copied title=${JSON.stringify(chapter.title)} path=${originalPdfPath}`);
        pdfImages = await copyImportedPdfImages(
          libraryPath,
          series.id,
          category.id,
          volumeId,
          metadata.id,
          originalPdfPath,
          (message) => log(`title=${JSON.stringify(chapter.title)} ${message}`)
        );
        html = [pdfImages.html, html].filter(Boolean).join("\n");
      } else if (chapter.sourceFile.fileType === "md") {
        await copyImportedMarkdown(libraryPath, series.id, category.id, volumeId, metadata.id, chapter.sourceFile.sourcePath);
      }

      await saveNovelChapterContent(libraryPath, series.id, category.id, volumeId, metadata.id, {
        html
      });
      if (chapter.sourceHash) {
        importHashIndex.hashes[chapter.sourceHash] = [
          ...new Set([...(importHashIndex.hashes[chapter.sourceHash] ?? []), series.id])
        ];
        try {
          await writeImportHashIndex(libraryPath, importHashIndex);
        } catch (error) {
          await log(`import hash index warning title=${JSON.stringify(chapter.title)} error=${String(error)}`);
        }
      }
      imported += 1;
      const unsupportedPdf =
        chapter.sourceFile.fileType === "pdf" && normalizeImportText(chapter.text).trim() === "" && pdfImages.count === 0;
      logs.push({
        status: unsupportedPdf ? "unsupported" : "imported",
        fileId: chapter.fileId,
        title: chapter.title,
        message:
          chapter.sourceFile.fileType === "pdf"
            ? unsupportedPdf
              ? `Saved original PDF ${chapter.sourceFile.relativePath}; no extractable text or images were found.`
              : `Imported ${chapter.sourceFile.relativePath} and saved original PDF${pdfImages.count > 0 ? ` with ${pdfImages.count} image pages` : ""}.${pdfImages.error ? ` Image extraction warning: ${pdfImages.error}` : ""}`
            : chapter.sourceFile.fileType === "images"
              ? `Imported illustrations from ${chapter.sourceFile.relativePath}.`
            : `Imported ${chapter.sourceFile.relativePath}.`
      });
      await log(
        `chapter done title=${JSON.stringify(chapter.title)} type=${chapter.sourceFile.fileType} pdfImages=${pdfImages.count} error=${pdfImages.error ?? ""}`
      );
    } catch (error) {
      logs.push({
        status: "failed",
        fileId: chapter.fileId,
        title: chapter.title,
        message: String(error)
      });
      await log(`chapter failed title=${JSON.stringify(chapter.title)} error=${String(error)}`);
    }
  }

  await log(`import done imported=${imported} unsupported=${logs.filter((entry) => entry.status === "unsupported").length} failed=${logs.filter((entry) => entry.status === "failed").length}`);

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
