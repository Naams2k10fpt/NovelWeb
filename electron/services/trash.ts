import { readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertId,
  assertSupportedSchemaVersion,
  categoryDirectoryPath,
  categoryMetaPath,
  chapterDirectoryPath,
  libraryChildPath,
  moveDirectorySafely,
  readJsonFile,
  seriesDirectoryPath,
  seriesMetaPath,
  volumeDirectoryPath,
  volumeMetaPath,
  writeJsonFile,
  type TrashItemType,
  type TrashManifest,
  type VersionedMetadata
} from "./base";
import { type CategoryMetadata } from "../schemas/category";
import { type SeriesMetadata } from "../schemas/series";
import { type VolumeMetadata } from "../schemas/volume";
import { rebuildSeriesIndex } from "./library";
import { rebuildRecentIndex } from "./readingState";
import { rebuildSearchIndex } from "./search";

export type TrashEntry = TrashManifest & { trashId: string };

function nullableId(value: unknown, fieldName: string): string | null {
  return value === null ? null : assertId(value, fieldName);
}

async function readTrashEntry(libraryPath: string, trashId: string): Promise<TrashEntry> {
  const safeTrashId = assertId(trashId, "trashId");
  const manifest = await readJsonFile<VersionedMetadata & Record<string, unknown>>(
    libraryChildPath(libraryPath, ".trash", safeTrashId, "trash.json")
  );
  assertSupportedSchemaVersion(`.trash/${safeTrashId}/trash.json`, manifest);

  const itemTypes: TrashItemType[] = ["series", "category", "volume", "chapter"];
  if (
    !itemTypes.includes(manifest.itemType as TrashItemType) ||
    typeof manifest.title !== "string" ||
    typeof manifest.deletedAt !== "string" ||
    !Number.isInteger(manifest.orderIndex)
  ) {
    throw new Error(`Invalid trash manifest: ${safeTrashId}`);
  }

  return {
    schemaVersion: 1,
    trashId: safeTrashId,
    itemType: manifest.itemType as TrashItemType,
    itemId: assertId(manifest.itemId, "itemId"),
    title: manifest.title,
    deletedAt: manifest.deletedAt,
    seriesId: nullableId(manifest.seriesId, "seriesId"),
    categoryId: nullableId(manifest.categoryId, "categoryId"),
    volumeId: nullableId(manifest.volumeId, "volumeId"),
    orderIndex: manifest.orderIndex as number
  };
}

export async function listTrashEntries(libraryPath: string): Promise<TrashEntry[]> {
  const trashPath = libraryChildPath(libraryPath, ".trash");
  const entries: TrashEntry[] = [];

  for (const entry of await readdir(trashPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      entries.push(await readTrashEntry(libraryPath, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

function restoreOrder(order: string[], itemId: string, orderIndex: number): string[] {
  const nextOrder = order.filter((id) => id !== itemId);
  const index = orderIndex < 0 ? nextOrder.length : Math.min(orderIndex, nextOrder.length);
  nextOrder.splice(index, 0, itemId);
  return nextOrder;
}

export async function restoreTrashItem(libraryPath: string, trashId: string): Promise<TrashEntry> {
  const entry = await readTrashEntry(libraryPath, trashId);
  const sourcePath = libraryChildPath(libraryPath, ".trash", entry.trashId);
  let destinationPath: string;

  if (entry.itemType === "series" && entry.seriesId) {
    destinationPath = seriesDirectoryPath(libraryPath, entry.seriesId);
  } else if (entry.itemType === "category" && entry.seriesId && entry.categoryId) {
    destinationPath = categoryDirectoryPath(libraryPath, entry.seriesId, entry.categoryId);
  } else if (entry.itemType === "volume" && entry.seriesId && entry.categoryId && entry.volumeId) {
    destinationPath = volumeDirectoryPath(libraryPath, entry.seriesId, entry.categoryId, entry.volumeId);
  } else if (entry.itemType === "chapter" && entry.seriesId && entry.categoryId) {
    destinationPath = chapterDirectoryPath(
      libraryPath,
      entry.seriesId,
      entry.categoryId,
      entry.volumeId,
      entry.itemId
    );
  } else {
    throw new Error(`Trash manifest has an invalid ${entry.itemType} location.`);
  }

  try {
    await stat(destinationPath);
    throw new Error("Restore destination already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const parent = await stat(dirname(destinationPath));
  if (!parent.isDirectory()) {
    throw new Error("Restore parent is missing.");
  }

  await moveDirectorySafely(sourcePath, destinationPath);

  try {
    const now = new Date().toISOString();
    if (entry.itemType === "category" && entry.seriesId) {
      const series = await readJsonFile<SeriesMetadata>(seriesMetaPath(libraryPath, entry.seriesId));
      await writeJsonFile(
        seriesMetaPath(libraryPath, entry.seriesId),
        {
          ...series,
          categoryOrder: restoreOrder(series.categoryOrder, entry.itemId, entry.orderIndex),
          updatedAt: now
        },
        { backup: true }
      );
    } else if (entry.itemType === "volume" && entry.seriesId && entry.categoryId) {
      const category = await readJsonFile<CategoryMetadata>(
        categoryMetaPath(libraryPath, entry.seriesId, entry.categoryId)
      );
      await writeJsonFile(
        categoryMetaPath(libraryPath, entry.seriesId, entry.categoryId),
        {
          ...category,
          volumeOrder: restoreOrder(category.volumeOrder, entry.itemId, entry.orderIndex),
          updatedAt: now
        },
        { backup: true }
      );
    } else if (entry.itemType === "chapter" && entry.seriesId && entry.categoryId) {
      if (entry.volumeId) {
        const volume = await readJsonFile<VolumeMetadata>(
          volumeMetaPath(libraryPath, entry.seriesId, entry.categoryId, entry.volumeId)
        );
        await writeJsonFile(
          volumeMetaPath(libraryPath, entry.seriesId, entry.categoryId, entry.volumeId),
          {
            ...volume,
            chapterOrder: restoreOrder(volume.chapterOrder, entry.itemId, entry.orderIndex),
            updatedAt: now
          },
          { backup: true }
        );
      } else {
        const category = await readJsonFile<CategoryMetadata>(
          categoryMetaPath(libraryPath, entry.seriesId, entry.categoryId)
        );
        await writeJsonFile(
          categoryMetaPath(libraryPath, entry.seriesId, entry.categoryId),
          {
            ...category,
            chapterOrder: restoreOrder(category.chapterOrder, entry.itemId, entry.orderIndex),
            updatedAt: now
          },
          { backup: true }
        );
      }
    }
  } catch (error) {
    await moveDirectorySafely(destinationPath, sourcePath);
    throw error;
  }

  await rm(libraryChildPath(destinationPath, "trash.json"), { force: true });
  await rebuildSeriesIndex(libraryPath);
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return entry;
}

export async function deleteTrashItem(libraryPath: string, trashId: string): Promise<TrashEntry> {
  const entry = await readTrashEntry(libraryPath, trashId);
  await rm(libraryChildPath(libraryPath, ".trash", entry.trashId), { recursive: true });
  return entry;
}
