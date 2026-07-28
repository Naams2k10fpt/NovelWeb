import { basename, isAbsolute, relative, resolve } from "node:path";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import {
  SUPPORTED_SCHEMA_VERSION,
  REQUIRED_LIBRARY_DIRECTORIES,
  assertDirectory,
  assertSupportedSchemaVersion,
  ensureLibraryDirectory,
  ensureLibraryFolder,
  libraryChildPath,
  moveDirectorySafely,
  readJsonFile,
  readAppSettings,
  seriesIndexPath,
  searchIndexPath,
  recentIndexPath,
  withResourceWriteLock,
  writeJsonFile,
  writeAppSettings,
  type LibraryMetadata,
  type LibrarySettings,
  type VersionedMetadata
} from "./base";
import { SERIES_COLLECTIONS, SERIES_STATUSES, type SeriesCollection, type SeriesStatus } from "../schemas/series";

export type SeriesIndex = {
  schemaVersion: number;
  generatedAt: string;
  series: Array<{
    id: string;
    title: string;
    author?: string | null;
    genres?: string[];
    tags?: string[];
    collections?: SeriesCollection[];
    status?: SeriesStatus;
    coverImage?: string | null;
    updatedAt?: string;
  }>;
};

export type LibraryBackupType = "metadata" | "content" | "full";
export type LibraryBackupResult = {
  name: string;
  path: string;
  createdAt: string;
  type: LibraryBackupType;
};

export async function activateLibraryPath(libraryPath: string): Promise<string> {
  const settings = await readAppSettings();
  await migrateLibrary(libraryPath);
  await writeAppSettings({ ...settings, currentLibraryPath: libraryPath });
  return libraryPath;
}

export async function ensureJsonFile(filePath: string, createData: () => unknown): Promise<void> {
  try {
    await readJsonFile(filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await writeJsonFile(filePath, createData());
}

export async function ensureLibraryJson(libraryPath: string): Promise<void> {
  await ensureLibraryFolder(libraryPath);

  const filePath = libraryChildPath(libraryPath, "library.json");
  await ensureJsonFile(filePath, (): LibraryMetadata => {
    const now = new Date().toISOString();

    return {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      name: basename(libraryPath),
      createdAt: now,
      updatedAt: now
    };
  });
}

export async function ensureLibrarySettingsJson(libraryPath: string): Promise<void> {
  await ensureLibraryFolder(libraryPath);

  const filePath = libraryChildPath(libraryPath, "settings.json");
  await ensureJsonFile(filePath, (): LibrarySettings => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    reading: {
      theme: "system",
      fontFamily: "system",
      fontSize: 18,
      lineHeight: 1.7
    },
    backup: {
      enabled: false
    },
    import: {
      keepOriginalFiles: true
    },
    updatedAt: new Date().toISOString()
  }));
}

export async function rebuildSeriesIndex(libraryPath: string): Promise<void> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const seriesList: SeriesIndex["series"] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const metadata = await readJsonFile<Record<string, unknown>>(
        libraryChildPath(libraryPath, "series", entry.name, "meta.json")
      );
      if (typeof metadata.id === "string" && typeof metadata.title === "string") {
        seriesList.push({
          id: metadata.id,
          title: metadata.title,
          author:
            typeof metadata.originalAuthor === "string"
              ? metadata.originalAuthor
              : typeof metadata.translator === "string"
                ? metadata.translator
                : null,
          genres: Array.isArray(metadata.genres)
            ? metadata.genres.filter((genre): genre is string => typeof genre === "string")
            : [],
          tags: Array.isArray(metadata.tags)
            ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
          collections: Array.isArray(metadata.collections)
            ? metadata.collections.filter(
                (collection): collection is SeriesCollection =>
                  typeof collection === "string" && (SERIES_COLLECTIONS as readonly string[]).includes(collection)
              )
            : [],
          status:
            typeof metadata.status === "string" && (SERIES_STATUSES as readonly string[]).includes(metadata.status)
              ? (metadata.status as SeriesStatus)
              : "planning",
          coverImage: typeof metadata.coverImage === "string" ? metadata.coverImage : null,
          updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : undefined
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await writeJsonFile(seriesIndexPath(libraryPath), {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    series: seriesList.sort((left, right) => left.title.localeCompare(right.title))
  } satisfies SeriesIndex);
}

export async function ensureSearchIndexJson(libraryPath: string): Promise<void> {
  await ensureJsonFile(searchIndexPath(libraryPath), () => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documents: []
  }));
}

export async function ensureRecentIndexJson(libraryPath: string): Promise<void> {
  await ensureJsonFile(recentIndexPath(libraryPath), () => ({
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    entries: []
  }));
}

export async function checkLibraryHealth(libraryPath: string): Promise<void> {
  const libraryMetadata = await readJsonFile<VersionedMetadata>(libraryChildPath(libraryPath, "library.json"));
  const librarySettings = await readJsonFile<VersionedMetadata>(libraryChildPath(libraryPath, "settings.json"));

  assertSupportedSchemaVersion("library.json", libraryMetadata);
  assertSupportedSchemaVersion("settings.json", librarySettings);

  for (const directoryName of REQUIRED_LIBRARY_DIRECTORIES) {
    await assertDirectory(libraryChildPath(libraryPath, directoryName));
  }
}

export async function ensureLibraryFiles(libraryPath: string): Promise<void> {
  await ensureLibraryJson(libraryPath);
  await ensureLibrarySettingsJson(libraryPath);
  for (const directoryName of REQUIRED_LIBRARY_DIRECTORIES) {
    await ensureLibraryDirectory(libraryPath, directoryName);
  }
  await ensureSearchIndexJson(libraryPath);
  await ensureRecentIndexJson(libraryPath);
  await checkLibraryHealth(libraryPath);
  await rebuildSeriesIndex(libraryPath);
}

export async function readSeriesIndex(libraryPath: string): Promise<SeriesIndex> {
  try {
    const index = await readJsonFile<SeriesIndex>(seriesIndexPath(libraryPath));
    assertSupportedSchemaVersion("series-index.json", index);

    if (
      index.series.some(
        (entry) =>
          !Array.isArray(entry.genres) || !Array.isArray(entry.tags) || !Array.isArray(entry.collections)
      )
    ) {
      await rebuildSeriesIndex(libraryPath);
      return readJsonFile<SeriesIndex>(seriesIndexPath(libraryPath));
    }

    return index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await rebuildSeriesIndex(libraryPath);
    return readJsonFile<SeriesIndex>(seriesIndexPath(libraryPath));
  }
}

export async function repairSeriesIndex(libraryPath: string): Promise<SeriesIndex> {
  await rebuildSeriesIndex(libraryPath);
  return readSeriesIndex(libraryPath);
}

export async function createLibraryBackup(
  libraryPath: string,
  type: LibraryBackupType,
  options: { skipValidation?: boolean; reason?: "manual" | "migration" } = {}
): Promise<LibraryBackupResult> {
  if (!["metadata", "content", "full"].includes(type)) {
    throw new Error("Backup type is invalid.");
  }
  if (!options.skipValidation) {
    await ensureLibraryFiles(libraryPath);
  }

  const backupsPath = libraryChildPath(libraryPath, "backups");

  return withResourceWriteLock(backupsPath, async () => {
    const createdAt = new Date().toISOString();
    const name = `${type}-${createdAt.replace(/[:.]/g, "-")}`;
    const targetPath = libraryChildPath(backupsPath, name);
    const temporaryPath = libraryChildPath(backupsPath, `${name}.tmp`);

    await mkdir(temporaryPath);

    try {
      for (const entry of await readdir(libraryPath, { withFileTypes: true })) {
        if (entry.name !== "backups") {
          const sourcePath = libraryChildPath(libraryPath, entry.name);
          await cp(
            sourcePath,
            libraryChildPath(temporaryPath, entry.name),
            {
              recursive: true,
              errorOnExist: true,
              force: false,
              filter:
                type === "full"
                  ? undefined
                  : async (candidatePath) => {
                      const candidate = await stat(candidatePath);
                      const firstPathPart = relative(libraryPath, candidatePath).split(/[\\/]/)[0];

                      if (candidate.isDirectory()) {
                        return type === "metadata" || firstPathPart === "series";
                      }

                      return type === "metadata"
                        ? candidatePath.toLowerCase().endsWith(".json")
                        : firstPathPart === "series" && !candidatePath.toLowerCase().endsWith(".json");
                    }
            }
          );
        }
      }

      await writeJsonFile(libraryChildPath(temporaryPath, "backup.json"), {
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        type,
        reason: options.reason ?? "manual",
        createdAt
      });
      await moveDirectorySafely(temporaryPath, targetPath);

      return { name, path: targetPath, createdAt, type };
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  });
}

export function createFullLibraryBackup(libraryPath: string): Promise<LibraryBackupResult> {
  return createLibraryBackup(libraryPath, "full");
}

async function findLibraryJsonFiles(directoryPath: string, libraryPath: string): Promise<string[]> {
  const jsonFiles: string[] = [];

  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    if (directoryPath === libraryPath && entry.name === "backups") {
      continue;
    }

    const entryPath = libraryChildPath(directoryPath, entry.name);
    if (entry.isDirectory()) {
      jsonFiles.push(...(await findLibraryJsonFiles(entryPath, libraryPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      jsonFiles.push(entryPath);
    }
  }

  return jsonFiles;
}

export async function migrateLibrary(libraryPath: string): Promise<{
  fromVersion: number | null;
  toVersion: number;
  migratedFiles: number;
  backupPath: string | null;
}> {
  await ensureLibraryFolder(libraryPath);

  let libraryMetadata: Record<string, unknown>;
  try {
    libraryMetadata = await readJsonFile<Record<string, unknown>>(libraryChildPath(libraryPath, "library.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await ensureLibraryFiles(libraryPath);
    return { fromVersion: null, toVersion: SUPPORTED_SCHEMA_VERSION, migratedFiles: 0, backupPath: null };
  }

  const fromVersion = libraryMetadata.schemaVersion ?? 0;
  if (!Number.isInteger(fromVersion) || (fromVersion as number) < 0) {
    throw new Error("library.json schemaVersion is invalid.");
  }
  if ((fromVersion as number) > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Library schemaVersion ${String(fromVersion)} is newer than this app supports.`);
  }
  if (fromVersion === SUPPORTED_SCHEMA_VERSION) {
    await ensureLibraryFiles(libraryPath);
    return { fromVersion, toVersion: SUPPORTED_SCHEMA_VERSION, migratedFiles: 0, backupPath: null };
  }
  if (fromVersion !== 0) {
    throw new Error(`No migration path from schemaVersion ${String(fromVersion)}.`);
  }

  const filesToMigrate: Array<{ path: string; data: Record<string, unknown> }> = [];
  for (const filePath of await findLibraryJsonFiles(libraryPath, libraryPath)) {
    const data = await readJsonFile<Record<string, unknown>>(filePath);
    const version = data.schemaVersion ?? 0;

    if (version !== 0 && version !== SUPPORTED_SCHEMA_VERSION) {
      throw new Error(`No migration path for ${filePath} schemaVersion ${String(version)}.`);
    }
    if (version === 0) {
      filesToMigrate.push({ path: filePath, data });
    }
  }

  const backup = await createLibraryBackup(libraryPath, "full", {
    skipValidation: true,
    reason: "migration"
  });
  for (const file of filesToMigrate) {
    await writeJsonFile(file.path, { ...file.data, schemaVersion: SUPPORTED_SCHEMA_VERSION });
  }
  await ensureLibraryFiles(libraryPath);

  return {
    fromVersion,
    toVersion: SUPPORTED_SCHEMA_VERSION,
    migratedFiles: filesToMigrate.length,
    backupPath: backup.path
  };
}

export async function restoreFullLibraryBackup(
  libraryPath: string,
  backupPath: string,
  destinationPath: string
): Promise<{ path: string }> {
  const backupsPath = resolve(libraryChildPath(libraryPath, "backups"));
  const sourcePath = resolve(backupPath);
  const sourceRelativePath = relative(backupsPath, sourcePath);

  if (
    sourceRelativePath === "" ||
    sourceRelativePath !== basename(sourceRelativePath) ||
    sourceRelativePath.startsWith("..") ||
    isAbsolute(sourceRelativePath)
  ) {
    throw new Error("Backup must be a direct child of the current Library backups folder.");
  }

  const manifest = await readJsonFile<VersionedMetadata & { type?: unknown }>(
    libraryChildPath(sourcePath, "backup.json")
  );
  assertSupportedSchemaVersion("backup.json", manifest);
  if (manifest.type !== "full") {
    throw new Error("Selected folder is not a full Library backup.");
  }

  const restoredLibraryPath = resolve(destinationPath);
  const destinationRelativePath = relative(resolve(libraryPath), restoredLibraryPath);
  if (
    destinationRelativePath === "" ||
    (!destinationRelativePath.startsWith("..") && !isAbsolute(destinationRelativePath))
  ) {
    throw new Error("Restore destination must be outside the current Library.");
  }

  await mkdir(restoredLibraryPath, { recursive: true });
  if ((await readdir(restoredLibraryPath)).length > 0) {
    throw new Error("Restore destination must be empty.");
  }

  try {
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      if (entry.name !== "backup.json") {
        await cp(
          libraryChildPath(sourcePath, entry.name),
          libraryChildPath(restoredLibraryPath, entry.name),
          { recursive: true, errorOnExist: true, force: false }
        );
      }
    }

    await ensureLibraryDirectory(restoredLibraryPath, "backups");
    await checkLibraryHealth(restoredLibraryPath);
    await ensureLibraryFiles(restoredLibraryPath);
    return { path: restoredLibraryPath };
  } catch (error) {
    for (const entry of await readdir(restoredLibraryPath)) {
      await rm(libraryChildPath(restoredLibraryPath, entry), { recursive: true, force: true });
    }
    throw error;
  }
}
