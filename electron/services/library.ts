import { basename } from "node:path";
import { readdir } from "node:fs/promises";
import {
  SUPPORTED_SCHEMA_VERSION,
  REQUIRED_LIBRARY_DIRECTORIES,
  assertDirectory,
  assertSupportedSchemaVersion,
  ensureLibraryDirectory,
  ensureLibraryFolder,
  libraryChildPath,
  readJsonFile,
  seriesIndexPath,
  searchIndexPath,
  recentIndexPath,
  writeJsonFile,
  type LibraryMetadata,
  type LibrarySettings,
  type VersionedMetadata,
  type SeriesCard
} from "./base";
import { SERIES_STATUSES, type SeriesStatus } from "../schemas/series";

export type SeriesIndex = {
  schemaVersion: number;
  generatedAt: string;
  series: Array<{
    id: string;
    title: string;
    author?: string | null;
    genres?: string[];
    status?: SeriesStatus;
    coverImage?: string | null;
    updatedAt?: string;
  }>;
};

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

    if (index.series.some((entry) => !Array.isArray(entry.genres))) {
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
