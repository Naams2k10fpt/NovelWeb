import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { mkdir, rename, rm, stat, readFile, copyFile } from "node:fs/promises";
import { extname, basename, dirname } from "node:path";
import {
  assertId,
  assertRecord,
  assertSupportedSchemaVersion,
  SUPPORTED_SCHEMA_VERSION,
  categoryMetaPath,
  chapterAssetsDirectoryPath,
  chapterAssetPath,
  chapterAssetSource,
  chapterAssetsDirectoryPath as getAssetsDir,
  chapterContentPath,
  chapterDirectoryPath,
  chapterMetaPath,
  IMAGE_FILE_EXTENSIONS,
  imageFileNameFromAssetSource,
  isSafeImageFileName,
  libraryChildPath,
  moveDirectoryToTrash,
  optionalVolumeId,
  pdfImageCheckPath,
  readJsonFile,
  readNovelChapterType,
  readOptionalBoolean,
  readOptionalInteger,
  readOptionalNonNegativeInteger,
  readOptionalNullableString,
  readRequiredIdArray,
  readRequiredString,
  readRequiredText,
  readTranslationStatus,
  seriesDirectoryPath,
  seriesMetaPath,
  trashItemDirectoryPath,
  volumeMetaPath,
  withResourceWriteLock,
  writeJsonFile,
  writeTextFile,
  type ChapterContent,
  type ChapterImageAsset,
  type ChapterMetadata,
  type ChapterOriginalPdf,
  type ChapterOriginalText,
  type ChapterReadingProgress,
  type JsonRecord
} from "./base";
import { CHAPTER_METADATA_SCHEMA_VERSION, type NovelChapterMetadata } from "../schemas/chapter";
import { type CategoryMetadata } from "../schemas/category";
import { type VolumeMetadata } from "../schemas/volume";
import { type SeriesMetadata } from "../schemas/series";
import { readCategoryMetadata } from "./category";
import { readVolumeMetadata } from "./volume";
import { copyImportedPdfImages, normalizeImportText } from "./import";
import { upsertSearchDocument, rebuildSearchIndex } from "./search";
import { readChapterReference, rebuildRecentIndex, updateChapterReadingReferences, upsertRecentEntry } from "./readingState";
import { imageMimeType, readImageDataUrl } from "./series";

export async function assertNovelChapterScope(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null
): Promise<{ category: CategoryMetadata; volume: VolumeMetadata | null }> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  if (!volumeId) {
    if (category.type !== "web-novel") {
      throw new Error("Direct category chapters are only for web-novel categories.");
    }

    return { category, volume: null };
  }

  return { category, volume: await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId) };
}

export function parseNovelChapterCreateInput(input: unknown, orderFallback: number): NovelChapterMetadata {
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

export function parseNovelChapterUpdateInput(input: unknown, current: NovelChapterMetadata): NovelChapterMetadata {
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

export async function readNovelChapterMetadata(
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

// Re-export as alias used by preload/handlers
export { readNovelChapterMetadata as readChapterMetadata };

export async function listNovelChapterMetadata(
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
  
  // Create directories if missing
  await mkdir(chapterDirectory, { recursive: true });
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

// Import readdir here since base.ts didn't export it
import { readdir } from "node:fs/promises";

// Re-export as alias
export { listNovelChapterMetadata as listChapterMetadata };

export async function createNovelChapterMetadata(
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

// Re-export as alias
export { createNovelChapterMetadata as createChapterMetadata };

export async function updateNovelChapterMetadata(
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
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

// Re-export as alias
export { updateNovelChapterMetadata as updateChapterMetadata };

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeNovelHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(iframe|object|embed|form|input|button|select|textarea|svg|math|meta|link|base)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript:|data:text\/html)[\s\S]*?\2/gi, "")
    .replace(/\s+(href|src)\s*=\s*(?:javascript:|data:text\/html)[^\s>]*/gi, "");
}

export function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function readHtmlAttribute(tag: string, attributeName: string): string | null {
  const match = tag.match(new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function removeHtmlAttribute(tag: string, attributeName: string): string {
  return tag.replace(new RegExp(`\\s${attributeName}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"), "");
}

export function setHtmlAttribute(tag: string, attributeName: string, value: string): string {
  const escapedValue = escapeHtmlAttribute(value);
  const pattern = new RegExp(`(\\s${attributeName}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");

  if (pattern.test(tag)) {
    return tag.replace(pattern, (_match, prefix: string) => `${prefix}"${escapedValue}"`);
  }

  return tag.replace(/\s*\/?>$/, (ending) => ` ${attributeName}="${escapedValue}"${ending.trimStart()}`);
}

export async function readChapterAssetDataUrl(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  fileName: string
): Promise<string> {
  const image = await readFile(chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName));
  return `data:${imageMimeType(fileName)};base64,${image.toString("base64")}`;
}

export async function hydrateNovelImageTag(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  tag: string
): Promise<string> {
  const fileName = imageFileNameFromAssetSource(readHtmlAttribute(tag, "src"));

  if (!fileName) {
    return tag;
  }

  try {
    const dataUrl = await readChapterAssetDataUrl(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
    return setHtmlAttribute(setHtmlAttribute(tag, "src", dataUrl), "data-asset-src", chapterAssetSource(fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return tag;
    }

    throw error;
  }
}

export async function hydrateNovelAssetImages(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  html: string
): Promise<string> {
  let result = "";
  let cursor = 0;

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const index = match.index ?? cursor;
    result += html.slice(cursor, index);
    result += await hydrateNovelImageTag(libraryPath, seriesId, categoryId, volumeId, chapterId, match[0]);
    cursor = index + match[0].length;
  }

  return result + html.slice(cursor);
}

export function persistNovelAssetImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const fileName = imageFileNameFromAssetSource(readHtmlAttribute(tag, "data-asset-src"));
    return fileName ? setHtmlAttribute(removeHtmlAttribute(tag, "data-asset-src"), "src", chapterAssetSource(fileName)) : tag;
  });
}

export function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

export async function readOptionalTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export async function optionalFileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function repairMissingPdfImages(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  html: string
): Promise<ChapterContent | null> {
  if (/<img\b/i.test(html) || (await optionalFileExists(pdfImageCheckPath(libraryPath, seriesId, categoryId, volumeId, chapterId)))) {
    return null;
  }

  const pdfImages = await copyImportedPdfImages(
    libraryPath,
    seriesId,
    categoryId,
    volumeId,
    chapterId,
    chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.pdf")
  );

  if (pdfImages.count === 0) {
    if (!pdfImages.error) {
      await writeTextFile(pdfImageCheckPath(libraryPath, seriesId, categoryId, volumeId, chapterId), new Date().toISOString());
    }

    return null;
  }

  return saveNovelChapterContent(libraryPath, seriesId, categoryId, volumeId, chapterId, {
    html: [pdfImages.html, html].filter(Boolean).join("\n")
  });
}

export async function readNovelChapterContent(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterContent> {
  const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  let storedHtml = sanitizeNovelHtml(
    await readOptionalTextFile(chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.contentFile))
  );
  let contentStats = metadata;

  if (metadata.hasOriginalPdf) {
    const repairedContent = await repairMissingPdfImages(libraryPath, seriesId, categoryId, volumeId, chapterId, storedHtml);
    if (repairedContent) {
      storedHtml = repairedContent.html;
      contentStats = {
        ...metadata,
        wordCount: repairedContent.wordCount,
        characterCount: repairedContent.characterCount,
        updatedAt: repairedContent.updatedAt
      };
    }
  }

  const html = await hydrateNovelAssetImages(libraryPath, seriesId, categoryId, volumeId, chapterId, storedHtml);
  const text = await readOptionalTextFile(
    chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.plainTextFile)
  );

  return {
    html,
    text,
    wordCount: contentStats.wordCount,
    characterCount: contentStats.characterCount,
    updatedAt: contentStats.updatedAt
  };
}

export { readNovelChapterContent as getContent };

export async function readNovelChapterOriginalPdf(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterOriginalPdf | null> {
  const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);

  if (!metadata.hasOriginalPdf) {
    return null;
  }

  const pdf = await readFile(chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.pdf"));

  return {
    dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    fileName: metadata.originalFileName ?? "original.pdf"
  };
}

export { readNovelChapterOriginalPdf as getOriginalPdf };

export async function readNovelChapterOriginalText(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterOriginalText | null> {
  const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);

  if (metadata.hasOriginalPdf || extname(metadata.originalFileName ?? "").toLowerCase() !== ".md") {
    return null;
  }

  try {
    return {
      text: normalizeImportText(
        await readFile(chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, "original.md"), "utf8")
      ),
      fileName: metadata.originalFileName ?? "original.md",
      fileType: "md"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export { readNovelChapterOriginalText as getOriginalText };

export type ChapterVersion = {
  id: string;
  createdAt: string;
};

type ChapterVersionIndex = {
  schemaVersion: 1;
  entries: ChapterVersion[];
};

const MAX_CHAPTER_VERSIONS = 20;

function chapterVersionsDirectoryPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  return libraryChildPath(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), "versions");
}

function chapterVersionIndexPath(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): string {
  return libraryChildPath(
    chapterVersionsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId),
    "index.json"
  );
}

async function readChapterVersionIndex(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterVersionIndex> {
  try {
    const index = await readJsonFile<ChapterVersionIndex>(
      chapterVersionIndexPath(libraryPath, seriesId, categoryId, volumeId, chapterId)
    );
    assertSupportedSchemaVersion("versions/index.json", index);
    return {
      schemaVersion: 1,
      entries: index.entries.map((entry) => ({
        id: assertId(entry.id, "versionId"),
        createdAt: readRequiredText(entry as unknown as JsonRecord, "createdAt")
      }))
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, entries: [] };
    }
    throw error;
  }
}

async function createChapterVersion(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  html: string
): Promise<void> {
  if (!html) {
    return;
  }

  const directoryPath = chapterVersionsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const index = await readChapterVersionIndex(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const version: ChapterVersion = { id: randomUUID(), createdAt: new Date().toISOString() };
  const entries = [version, ...index.entries];
  // ponytail: retain 20 versions; make this configurable only if real libraries need more.
  const removedEntries = entries.splice(MAX_CHAPTER_VERSIONS);

  await mkdir(directoryPath, { recursive: true });
  await writeTextFile(libraryChildPath(directoryPath, `${version.id}.html`), html);
  await writeJsonFile(
    chapterVersionIndexPath(libraryPath, seriesId, categoryId, volumeId, chapterId),
    { schemaVersion: 1, entries } satisfies ChapterVersionIndex,
    { backup: true }
  );
  await Promise.all(
    removedEntries.map((entry) => rm(libraryChildPath(directoryPath, `${entry.id}.html`), { force: true }))
  );
}

export async function listChapterVersions(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterVersion[]> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  return (await readChapterVersionIndex(libraryPath, seriesId, categoryId, volumeId, chapterId)).entries;
}

export async function restoreChapterVersion(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  versionId: string
): Promise<ChapterContent> {
  const id = assertId(versionId, "versionId");
  const index = await readChapterVersionIndex(libraryPath, seriesId, categoryId, volumeId, chapterId);
  if (!index.entries.some((entry) => entry.id === id)) {
    throw new Error("Chapter version does not exist.");
  }

  const html = await readFile(
    libraryChildPath(chapterVersionsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), `${id}.html`),
    "utf8"
  );
  return saveNovelChapterContent(libraryPath, seriesId, categoryId, volumeId, chapterId, { html });
}

export async function saveNovelChapterContent(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterContent> {
  return withResourceWriteLock(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), async () => {
    const record = assertRecord(input);
    const html = sanitizeNovelHtml(persistNovelAssetImages(readRequiredText(record, "html")));
    const metadata = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
    const currentHtml = await readOptionalTextFile(
      chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.contentFile)
    );
    const text = htmlToPlainText(html);
    const now = new Date().toISOString();
    const nextMetadata: NovelChapterMetadata = {
      ...metadata,
      wordCount: countWords(text),
      characterCount: text.length,
      updatedAt: now
    };

    if (currentHtml !== html) {
      await createChapterVersion(libraryPath, seriesId, categoryId, volumeId, chapterId, currentHtml);
    }
    await writeTextFile(
      chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.contentFile),
      html,
      { backup: true }
    );
    await writeTextFile(
      chapterContentPath(libraryPath, seriesId, categoryId, volumeId, chapterId, metadata.plainTextFile),
      text,
      { backup: true }
    );
    await writeJsonFile(chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, chapterId), nextMetadata, {
      backup: true
    });
    await upsertSearchDocument(libraryPath, seriesId, categoryId, volumeId, nextMetadata, text);

    return {
      html,
      text,
      wordCount: nextMetadata.wordCount,
      characterCount: nextMetadata.characterCount,
      updatedAt: nextMetadata.updatedAt
    };
  });
}

export { saveNovelChapterContent as saveContent };

export async function chooseNovelChapterImage(
  window: BrowserWindow | null,
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterImageAsset | null> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);

  const options: OpenDialogOptions = {
    title: "Choose inline image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }]
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  const sourcePath = result.filePaths[0];
  const sourceStat = await stat(sourcePath);

  if (!sourceStat.isFile()) {
    throw new Error("Selected image is not a file.");
  }

  const extension = extname(sourcePath).toLowerCase();

  if (!IMAGE_FILE_EXTENSIONS.has(extension)) {
    throw new Error("Selected file type is not supported.");
  }

  return withResourceWriteLock(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), async () => {
    const fileName = `${randomUUID()}${extension}`;
    const src = chapterAssetSource(fileName);
    const targetPath = chapterAssetPath(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName);
    const tmpPath = `${targetPath}.tmp`;

    await mkdir(chapterAssetsDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapterId), { recursive: true });
    await copyFile(sourcePath, tmpPath);
    await rename(tmpPath, targetPath);

    return {
      src,
      dataUrl: await readChapterAssetDataUrl(libraryPath, seriesId, categoryId, volumeId, chapterId, fileName),
      fileName
    };
  });
}

export { chooseNovelChapterImage as chooseImage };



export async function moveNovelChapterToTrash(
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
  await moveDirectoryToTrash(
    chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapter.id),
    trashPath,
    {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      itemType: "chapter",
      itemId: chapter.id,
      title: chapter.title,
      deletedAt: now,
      seriesId,
      categoryId,
      volumeId,
      orderIndex: (volume?.chapterOrder ?? category.chapterOrder).indexOf(chapter.id)
    }
  );

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
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id: chapter.id, trashPath };
}

export { moveNovelChapterToTrash as moveToTrash };

export async function moveNovelChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  targetCategoryId: string,
  targetVolumeId: string | null
): Promise<NovelChapterMetadata> {
  if (categoryId === targetCategoryId && volumeId === targetVolumeId) {
    return readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  }

  return withResourceWriteLock(seriesDirectoryPath(libraryPath, seriesId), async () => {
    const source = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
    const target = await assertNovelChapterScope(libraryPath, seriesId, targetCategoryId, targetVolumeId);
    const chapter = await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
    const oldReference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
    const now = new Date().toISOString();
    const targetPath = chapterDirectoryPath(libraryPath, seriesId, targetCategoryId, targetVolumeId, chapter.id);

    await mkdir(dirname(targetPath), { recursive: true });
    await rename(chapterDirectoryPath(libraryPath, seriesId, categoryId, volumeId, chapter.id), targetPath);

    if (source.volume) {
      await writeJsonFile(
        volumeMetaPath(libraryPath, seriesId, categoryId, source.volume.id),
        {
          ...source.volume,
          chapterOrder: source.volume.chapterOrder.filter((id) => id !== chapter.id),
          updatedAt: now
        } satisfies VolumeMetadata,
        { backup: true }
      );
    } else {
      await writeJsonFile(
        categoryMetaPath(libraryPath, seriesId, categoryId),
        {
          ...source.category,
          chapterOrder: source.category.chapterOrder.filter((id) => id !== chapter.id),
          updatedAt: now
        } satisfies CategoryMetadata,
        { backup: true }
      );
    }

    if (target.volume) {
      await writeJsonFile(
        volumeMetaPath(libraryPath, seriesId, targetCategoryId, target.volume.id),
        {
          ...target.volume,
          chapterOrder: [...target.volume.chapterOrder.filter((id) => id !== chapter.id), chapter.id],
          updatedAt: now
        } satisfies VolumeMetadata,
        { backup: true }
      );
    } else {
      await writeJsonFile(
        categoryMetaPath(libraryPath, seriesId, targetCategoryId),
        {
          ...target.category,
          chapterOrder: [...target.category.chapterOrder.filter((id) => id !== chapter.id), chapter.id],
          updatedAt: now
        } satisfies CategoryMetadata,
        { backup: true }
      );
    }

    await writeChapterMetadataOrder(
      libraryPath,
      seriesId,
      categoryId,
      volumeId,
      await listNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId)
    );
    await writeChapterMetadataOrder(
      libraryPath,
      seriesId,
      targetCategoryId,
      targetVolumeId,
      await listNovelChapterMetadata(libraryPath, seriesId, targetCategoryId, targetVolumeId)
    );
    await updateChapterReadingReferences(
      libraryPath,
      oldReference,
      await readChapterReference(libraryPath, seriesId, targetCategoryId, targetVolumeId, chapter.id)
    );
    await rebuildSearchIndex(libraryPath);
    await rebuildRecentIndex(libraryPath);

    return readNovelChapterMetadata(libraryPath, seriesId, targetCategoryId, targetVolumeId, chapter.id);
  });
}

export async function writeChapterMetadataOrder(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapters: ChapterMetadata[]
): Promise<void> {
  await Promise.all(
    chapters.map((chapter, index) => {
      const nextOrder = index + 1;

      if (chapter.order === nextOrder) {
        return Promise.resolve();
      }

      return writeJsonFile(
        chapterMetaPath(libraryPath, seriesId, categoryId, volumeId, chapter.id),
        { ...chapter, order: nextOrder, updatedAt: new Date().toISOString() },
        { backup: true }
      );
    })
  );
}

export function assertExactChapterOrder(chapterOrder: string[], chapters: ChapterMetadata[]): void {
  const currentIds = new Set(chapters.map((chapter) => chapter.id));

  if (chapterOrder.length !== currentIds.size || chapterOrder.some((chapterId) => !currentIds.has(chapterId))) {
    throw new Error("chapterOrder must contain every chapter in this container exactly once.");
  }
}

export async function reorderChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  input: unknown
): Promise<ChapterMetadata[]> {
  const record = assertRecord(input);
  const chapterOrder = readRequiredIdArray(record, "chapterOrder");
  const now = new Date().toISOString();
  const { category: scopedCategory, volume } = await assertNovelChapterScope(libraryPath, seriesId, categoryId, volumeId);
  const targetMetaPath = volume
    ? volumeMetaPath(libraryPath, seriesId, categoryId, volume.id)
    : categoryMetaPath(libraryPath, seriesId, categoryId);
  const chapters = await listNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId);
  assertExactChapterOrder(chapterOrder, chapters);
  const chaptersById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const orderedChapters = chapterOrder.map((chapterId) => chaptersById.get(chapterId)).filter((chapter): chapter is NovelChapterMetadata => !!chapter);

  if (volume) {
    await writeJsonFile(
      targetMetaPath,
      { ...volume, chapterOrder, updatedAt: now } satisfies VolumeMetadata,
      { backup: true }
    );
  } else {
    await writeJsonFile(
      targetMetaPath,
      { ...scopedCategory, chapterOrder, updatedAt: now } satisfies CategoryMetadata,
      { backup: true }
    );
  }

  await writeChapterMetadataOrder(libraryPath, seriesId, categoryId, volumeId, orderedChapters);
  return orderedChapters;
}

export async function moveChapterMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterMetadata> {
  const record = assertRecord(input);

  return moveNovelChapterMetadata(
    libraryPath,
    seriesId,
    categoryId,
    volumeId,
    chapterId,
    assertId(record.targetCategoryId, "targetCategoryId"),
    optionalVolumeId(record.targetVolumeId)
  );
}
export { moveChapterMetadata as move };
