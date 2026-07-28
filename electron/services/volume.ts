import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import {
  assertRecord,
  assertSupportedSchemaVersion,
  SUPPORTED_SCHEMA_VERSION,
  categoryMetaPath,
  libraryChildPath,
  moveDirectoryToTrash,
  readJsonFile,
  readOptionalInteger,
  readRequiredString,
  trashItemDirectoryPath,
  volumeDirectoryPath,
  volumeMetaPath,
  writeJsonFile
} from "./base";
import { VOLUME_METADATA_SCHEMA_VERSION, type VolumeMetadata } from "../schemas/volume";
import { type CategoryMetadata } from "../schemas/category";
import { readCategoryMetadata } from "./category";
import { rebuildSearchIndex } from "./search";
import { rebuildRecentIndex } from "./readingState";

export function parseVolumeCreateInput(input: unknown, orderFallback: number): VolumeMetadata {
  const record = assertRecord(input);
  const now = new Date().toISOString();

  return {
    schemaVersion: VOLUME_METADATA_SCHEMA_VERSION,
    id: randomUUID(),
    title: readRequiredString(record, "title"),
    order: readOptionalInteger(record, "order", orderFallback),
    chapterOrder: [],
    createdAt: now,
    updatedAt: now
  };
}

export function parseVolumeUpdateInput(input: unknown, current: VolumeMetadata): VolumeMetadata {
  const record = assertRecord(input);

  return {
    ...current,
    title: record.title === undefined ? current.title : readRequiredString(record, "title"),
    order: readOptionalInteger(record, "order", current.order),
    updatedAt: new Date().toISOString()
  };
}

export async function readVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string
): Promise<VolumeMetadata> {
  const metadata = await readJsonFile<VolumeMetadata>(volumeMetaPath(libraryPath, seriesId, categoryId, volumeId));
  assertSupportedSchemaVersion(`series/${seriesId}/categories/${categoryId}/volumes/${volumeId}/meta.json`, metadata);
  return metadata;
}

export async function listVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string
): Promise<VolumeMetadata[]> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  const volumeDirectory = libraryChildPath(libraryPath, "series", seriesId, "categories", categoryId, "volumes");
  const entries = await readdir(volumeDirectory, { withFileTypes: true });
  const volumes = new Map<string, VolumeMetadata>();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readVolumeMetadata(libraryPath, seriesId, categoryId, entry.name);
      volumes.set(metadata.id, metadata);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return [
    ...category.volumeOrder.map((volumeId) => volumes.get(volumeId)).filter((item): item is VolumeMetadata => !!item),
    ...[...volumes.values()].filter((volume) => !category.volumeOrder.includes(volume.id))
  ];
}

export async function createVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  input: unknown
): Promise<VolumeMetadata> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);

  const metadata = parseVolumeCreateInput(input, category.volumeOrder.length + 1);
  const now = new Date().toISOString();

  await mkdir(volumeDirectoryPath(libraryPath, seriesId, categoryId, metadata.id), { recursive: true });
  await mkdir(libraryChildPath(libraryPath, "series", seriesId, "categories", categoryId, "volumes", metadata.id, "chapters"), {
    recursive: true
  });
  await writeJsonFile(volumeMetaPath(libraryPath, seriesId, categoryId, metadata.id), metadata);
  await writeJsonFile(
    categoryMetaPath(libraryPath, seriesId, categoryId),
    { ...category, volumeOrder: [...category.volumeOrder, metadata.id], updatedAt: now } satisfies CategoryMetadata,
    { backup: true }
  );

  return metadata;
}

export async function updateVolumeMetadata(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string,
  input: unknown
): Promise<VolumeMetadata> {
  await readCategoryMetadata(libraryPath, seriesId, categoryId);

  const current = await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId);
  const metadata = parseVolumeUpdateInput(input, current);
  await writeJsonFile(volumeMetaPath(libraryPath, seriesId, categoryId, volumeId), metadata, { backup: true });
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);
  return metadata;
}

export async function moveVolumeToTrash(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string
): Promise<{ id: string; trashPath: string }> {
  const category = await readCategoryMetadata(libraryPath, seriesId, categoryId);
  const volume = await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId);
  const trashPath = trashItemDirectoryPath(libraryPath, "volume", volume.id);
  const now = new Date().toISOString();

  await mkdir(libraryChildPath(libraryPath, ".trash"), { recursive: true });
  await moveDirectoryToTrash(volumeDirectoryPath(libraryPath, seriesId, categoryId, volume.id), trashPath, {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    itemType: "volume",
    itemId: volume.id,
    title: volume.title,
    deletedAt: now,
    seriesId,
    categoryId,
    volumeId: volume.id,
    orderIndex: category.volumeOrder.indexOf(volume.id)
  });
  await writeJsonFile(
    categoryMetaPath(libraryPath, seriesId, categoryId),
    { ...category, volumeOrder: category.volumeOrder.filter((id) => id !== volume.id), updatedAt: now } satisfies CategoryMetadata,
    { backup: true }
  );
  await rebuildSearchIndex(libraryPath);
  await rebuildRecentIndex(libraryPath);

  return { id: volume.id, trashPath };
}
