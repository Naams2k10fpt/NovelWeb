import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import {
  assertRecord,
  assertSupportedSchemaVersion,
  SUPPORTED_SCHEMA_VERSION,
  categoryDirectoryPath,
  categoryMetaPath,
  libraryChildPath,
  readCategoryType,
  readJsonFile,
  readRequiredString,
  seriesMetaPath,
  trashItemDirectoryPath,
  moveDirectoryToTrash,
  writeJsonFile
} from "./base";
import { CATEGORY_METADATA_SCHEMA_VERSION, type CategoryMetadata } from "../schemas/category";
import { type SeriesMetadata } from "../schemas/series";
import { rebuildSeriesIndex } from "./library";
import { readSeriesMetadata } from "./series";
import { rebuildSearchIndex } from "./search";
import { rebuildRecentIndex } from "./readingState";

export function parseCategoryCreateInput(input: unknown): CategoryMetadata {
  const record = assertRecord(input);
  const now = new Date().toISOString();

  return {
    schemaVersion: CATEGORY_METADATA_SCHEMA_VERSION,
    id: randomUUID(),
    type: readCategoryType(record),
    title: readRequiredString(record, "title"),
    volumeOrder: [],
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
}

export function parseCategoryUpdateInput(input: unknown, current: CategoryMetadata): CategoryMetadata {
  const record = assertRecord(input);

  return {
    ...current,
    title: record.title === undefined ? current.title : readRequiredString(record, "title"),
    updatedAt: new Date().toISOString()
  };
}

export async function readCategoryMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string
): Promise<CategoryMetadata> {
  const metadata = await readJsonFile<CategoryMetadata>(categoryMetaPath(libraryPath, seriesId, categoryId));
  assertSupportedSchemaVersion(`series/${seriesId}/categories/${categoryId}/meta.json`, metadata);
  return metadata;
}

export async function listCategoryMetadata(libraryPath: string, seriesId: string): Promise<CategoryMetadata[]> {
  const series = await readSeriesMetadata(libraryPath, seriesId);
  const categoryDirectory = libraryChildPath(libraryPath, "series", series.id, "categories");
  const entries = await readdir(categoryDirectory, { withFileTypes: true });
  const categories = new Map<string, CategoryMetadata>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readCategoryMetadata(libraryPath, series.id, entry.name);
      categories.set(metadata.id, metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return [
    ...series.categoryOrder.map((categoryId) => categories.get(categoryId)).filter((item): item is CategoryMetadata => !!item),
    ...[...categories.values()].filter((category) => !series.categoryOrder.includes(category.id))
  ];
}

export async function createCategoryMetadata(
  libraryPath: string,
  seriesId: string,
  input: unknown
): Promise<CategoryMetadata> {
  const series = await readSeriesMetadata(libraryPath, seriesId);
  const metadata = parseCategoryCreateInput(input);
  const now = new Date().toISOString();

  await mkdir(categoryDirectoryPath(libraryPath, series.id, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(libraryPath, "series", series.id, "categories", metadata.id, "volumes"), {
    recursive: true
  });
  await mkdir(libraryChildPath(libraryPath, "series", series.id, "categories", metadata.id, "chapters"), {
    recursive: true
  });
  await writeJsonFile(categoryMetaPath(libraryPath, series.id, metadata.id), metadata);
  await writeJsonFile(
    seriesMetaPath(libraryPath, series.id),
    { ...series, categoryOrder: [...series.categoryOrder, metadata.id], updatedAt: now } satisfies SeriesMetadata,
    { backup: true }
  );
  await rebuildSeriesIndex(libraryPath);

  return metadata;
}

export async function updateCategoryMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  input: unknown
): Promise<CategoryMetadata> {
  const current = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  const metadata = parseCategoryUpdateInput(input, current);
  await writeJsonFile(categoryMetaPath(libraryPath, seriesId, categoryId), metadata, { backup: true });
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

export async function moveCategoryToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string
): Promise<{ id: string; trashPath: string }> {
  const series = await readSeriesMetadata(libraryPath, seriesId);
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  const trashPath = trashItemDirectoryPath(libraryPath, "category", category.id);
  const now = new Date().toISOString();

  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await moveDirectoryToTrash(categoryDirectoryPath(libraryPath, series.id, category.id), trashPath, {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    itemType: "category",
    itemId: category.id,
    title: category.title,
    deletedAt: now,
    seriesId: series.id,
    categoryId: category.id,
    volumeId: null,
    orderIndex: series.categoryOrder.indexOf(category.id)
  });
  await writeJsonFile(
    seriesMetaPath(libraryPath, series.id),
    { ...series, categoryOrder: series.categoryOrder.filter((id) => id !== category.id), updatedAt: now } satisfies SeriesMetadata,
    { backup: true }
  );
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id: category.id, trashPath };
}
