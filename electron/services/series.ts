import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { mkdir, copyFile, rename, stat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  assertId,
  assertRecord,
  assertSupportedSchemaVersion,
  IMAGE_FILE_EXTENSIONS,
  SUPPORTED_SCHEMA_VERSION,
  libraryChildPath,
  readJsonFile,
  readOptionalNullableNumber,
  readOptionalNullableString,
  readOptionalString,
  readOptionalStringArray,
  readRequiredString,
  readSeriesStatus,
  seriesDirectoryPath,
  seriesMetaPath,
  trashSeriesDirectoryPath,
  moveDirectoryToTrash,
  withResourceWriteLock,
  writeJsonFile,
  type SeriesCard,
  type SeriesDetailData
} from "./base";
import { SERIES_METADATA_SCHEMA_VERSION, type SeriesMetadata } from "../schemas/series";
import { readSeriesIndex, rebuildSeriesIndex } from "./library";
import { rebuildSearchIndex } from "./search";
import { rebuildRecentIndex } from "./readingState";

export function imageMimeType(fileName: string): string {
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.endsWith(".png")) {
    return "image/png";
  }

  if (lowerFileName.endsWith(".webp")) {
    return "image/webp";
  }

  if (lowerFileName.endsWith(".gif")) {
    return "image/gif";
  }

  return "image/jpeg";
}

export async function readImageDataUrl(filePath: string, fileName: string): Promise<string> {
  const image = await readFile(filePath);
  return `data:${imageMimeType(fileName)};base64,${image.toString("base64")}`;
}

export async function readSeriesCoverDataUrl(libraryPath: string, entry: { id: string; coverImage?: string | null }): Promise<string | null> {
  if (!entry.coverImage) {
    return null;
  }

  try {
    const fileName = basename(entry.coverImage);
    return readImageDataUrl(libraryChildPath(libraryPath, "series", entry.id, fileName), fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function toSeriesCard(libraryPath: string, entry: { id: string; title: string; author?: string | null; genres?: string[]; tags?: string[]; status?: any; coverImage?: string | null }): Promise<SeriesCard> {
  return {
    id: entry.id,
    title: entry.title,
    author: entry.author ?? null,
    genres: entry.genres ?? [],
    tags: entry.tags ?? [],
    status: entry.status ?? "planning",
    coverDataUrl: await readSeriesCoverDataUrl(libraryPath, entry)
  };
}

export async function toSeriesDetailData(libraryPath: string, metadata: SeriesMetadata): Promise<SeriesDetailData> {
  return {
    ...metadata,
    coverDataUrl: await readSeriesCoverDataUrl(libraryPath, {
      id: metadata.id,
      coverImage: metadata.coverImage
    })
  };
}

export async function readSeriesMetadata(libraryPath: string, seriesId: string): Promise<SeriesMetadata> {
  const metadata = await readJsonFile<SeriesMetadata>(seriesMetaPath(libraryPath, seriesId));
  assertSupportedSchemaVersion(`series/${seriesId}/meta.json`, metadata);
  return { ...metadata, tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string") : [] };
}

export async function listSeriesCards(libraryPath: string): Promise<SeriesCard[]> {
  const index = await readSeriesIndex(libraryPath);
  return Promise.all(index.series.map((entry) => toSeriesCard(libraryPath, entry)));
}

export function parseSeriesCreateInput(input: unknown): SeriesMetadata {
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

export function parseSeriesUpdateInput(input: unknown, current: SeriesMetadata): SeriesMetadata {
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

export async function createSeriesMetadata(libraryPath: string, input: unknown): Promise<SeriesMetadata> {
  const metadata = parseSeriesCreateInput(input);
  await mkdir(seriesDirectoryPath(libraryPath, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(libraryPath, "series", metadata.id, "categories"), { recursive: true });
  await writeJsonFile(seriesMetaPath(libraryPath, metadata.id), metadata);
  await rebuildSeriesIndex(libraryPath);
  return metadata;
}

export async function updateSeriesMetadata(libraryPath: string, seriesId: string, input: unknown): Promise<SeriesMetadata> {
  const current = await readSeriesMetadata(libraryPath, seriesId);
  const metadata = parseSeriesUpdateInput(input, current);
  await writeJsonFile(seriesMetaPath(libraryPath, seriesId), metadata, { backup: true });
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

export async function chooseSeriesCover(
  window: BrowserWindow | null,
  libraryPath: string,
  seriesId: string
): Promise<SeriesDetailData | null> {
  await readSeriesMetadata(libraryPath, seriesId);

  const options: OpenDialogOptions = {
    title: "Choose series cover",
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
    throw new Error("Selected cover is not a file.");
  }

  const extension = extname(sourcePath).toLowerCase();

  if (!IMAGE_FILE_EXTENSIONS.has(extension)) {
    throw new Error("Selected cover type is not supported.");
  }

  return withResourceWriteLock(seriesDirectoryPath(libraryPath, seriesId), async () => {
    const fileName = `cover${extension}`;
    const targetPath = libraryChildPath(libraryPath, "series", seriesId, fileName);
    const tmpPath = `${targetPath}.tmp`;

    await copyFile(sourcePath, tmpPath);
    await rename(tmpPath, targetPath);

    return toSeriesDetailData(libraryPath, await updateSeriesMetadata(libraryPath, seriesId, { coverImage: fileName }));
  });
}

export async function moveSeriesToTrash(libraryPath: string, seriesId: string): Promise<{ id: string; trashPath: string }> {
  const id = assertId(seriesId, "seriesId");
  const series = await readSeriesMetadata(libraryPath, id);

  const trashPath = trashSeriesDirectoryPath(libraryPath, id);
  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await moveDirectoryToTrash(seriesDirectoryPath(libraryPath, id), trashPath, {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    itemType: "series",
    itemId: id,
    title: series.title,
    deletedAt: new Date().toISOString(),
    seriesId: id,
    categoryId: null,
    volumeId: null,
    orderIndex: -1
  });
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id, trashPath };
}
