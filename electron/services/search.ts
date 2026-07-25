import { readdir, writeFile, rename } from "node:fs/promises";
import {
  assertSupportedSchemaVersion,
  backupExistingFile,
  chapterContentPath,
  libraryChildPath,
  readJsonFile,
  searchIndexPath,
  SUPPORTED_SCHEMA_VERSION,
  withResourceWriteLock,
  writeJsonFile,
  type SeriesDetailData
} from "./base";
import { type SeriesMetadata } from "../schemas/series";
import { type CategoryMetadata } from "../schemas/category";
import { type VolumeMetadata } from "../schemas/volume";
import { type NovelChapterMetadata } from "../schemas/chapter";
import { readSeriesMetadata } from "./series";
import { listCategoryMetadata, readCategoryMetadata } from "./category";
import { listVolumeMetadata, readVolumeMetadata } from "./volume";
import { listNovelChapterMetadata, readOptionalTextFile } from "./chapter";
import { ensureSearchIndexJson } from "./library";

export const MAX_SEARCH_RESULTS = 50;
export const SEARCH_SNIPPET_RADIUS = 90;

export type SearchDocument = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
  tags: string[];
  text: string;
  updatedAt: string;
};

export type SearchIndex = {
  schemaVersion: number;
  generatedAt: string;
  documents: SearchDocument[];
};

export type SearchResult = Omit<SearchDocument, "text"> & {
  snippet: string;
};

export type SearchIndexSummary = {
  documentCount: number;
  generatedAt: string;
};

export function summarizeSearchIndex(index: SearchIndex): SearchIndexSummary {
  return {
    documentCount: index.documents.length,
    generatedAt: index.generatedAt
  };
}

export function compareSearchDocuments(left: SearchDocument, right: SearchDocument): number {
  return (
    left.seriesTitle.localeCompare(right.seriesTitle) ||
    left.categoryTitle.localeCompare(right.categoryTitle) ||
    (left.volumeTitle ?? "").localeCompare(right.volumeTitle ?? "") ||
    left.chapterTitle.localeCompare(right.chapterTitle)
  );
}

export async function readSearchIndex(libraryPath: string): Promise<SearchIndex> {
  try {
    const index = await readJsonFile<SearchIndex>(searchIndexPath(libraryPath));
    assertSupportedSchemaVersion("search-index.json", index);
    if (!Array.isArray(index.documents) || index.documents.some((document) => !Array.isArray(document.tags))) {
      return rebuildSearchIndex(libraryPath);
    }
    return index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return rebuildSearchIndex(libraryPath);
  }
}

export async function toSearchDocument(
  libraryPath: string,
  series: SeriesMetadata,
  category: CategoryMetadata,
  volume: VolumeMetadata | null,
  chapter: NovelChapterMetadata
): Promise<SearchDocument> {
  return {
    seriesId: series.id,
    seriesTitle: series.title,
    categoryId: category.id,
    categoryTitle: category.title,
    volumeId: volume?.id ?? null,
    volumeTitle: volume?.title ?? null,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    tags: [...series.tags, ...chapter.tags],
    text: await readOptionalTextFile(
      chapterContentPath(libraryPath, series.id, category.id, volume?.id ?? null, chapter.id, chapter.plainTextFile)
    ),
    updatedAt: chapter.updatedAt
  };
}

export async function rebuildSearchIndex(libraryPath: string): Promise<SearchIndex> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  // Create series directory if missing
  await mkdir(seriesDirectory, { recursive: true });
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const documents: SearchDocument[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const series = await readSeriesMetadata(libraryPath, entry.name);
      const categories = await listCategoryMetadata(libraryPath, series.id);

      for (const category of categories) {
        if (category.type === "web-novel") {
          const chapters = await listNovelChapterMetadata(libraryPath, series.id, category.id, null);
          for (const chapter of chapters) {
            documents.push(await toSearchDocument(libraryPath, series, category, null, chapter));
          }
        }

        const volumes = await listVolumeMetadata(libraryPath, series.id, category.id);
        for (const volume of volumes) {
          const chapters = await listNovelChapterMetadata(libraryPath, series.id, category.id, volume.id);
          for (const chapter of chapters) {
            documents.push(await toSearchDocument(libraryPath, series, category, volume, chapter));
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const index: SearchIndex = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documents: documents.sort(compareSearchDocuments)
  };

  await writeJsonFile(searchIndexPath(libraryPath), index, { backup: true });
  return index;
}

// Import mkdir here since base.ts didn't export it
import { mkdir } from "node:fs/promises";

export async function upsertSearchDocument(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapter: NovelChapterMetadata,
  text: string
): Promise<void> {
  const [series, category, volume] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    readCategoryMetadata(libraryPath, seriesId, categoryId),
    volumeId ? readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId) : Promise.resolve(null)
  ]);
  const filePath = searchIndexPath(libraryPath);

  await ensureSearchIndexJson(libraryPath);
  await withResourceWriteLock(filePath, async () => {
    const current = await readJsonFile<SearchIndex>(filePath);
    assertSupportedSchemaVersion("search-index.json", current);

    const document: SearchDocument = {
      seriesId: series.id,
      seriesTitle: series.title,
      categoryId: category.id,
      categoryTitle: category.title,
      volumeId: volume?.id ?? null,
      volumeTitle: volume?.title ?? null,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      tags: [...series.tags, ...chapter.tags],
      text,
      updatedAt: chapter.updatedAt
    };
    const index: SearchIndex = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      documents: [
        ...current.documents.filter(
          (item) =>
              item.seriesId !== series.id ||
              item.categoryId !== category.id ||
              item.volumeId !== (volume?.id ?? null) ||
              item.chapterId !== chapter.id
        ),
        document
      ].sort(compareSearchDocuments)
    };
    const tmpPath = `${filePath}.tmp`;

    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  });
}

export function searchSnippet(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIndex + queryLength + SEARCH_SNIPPET_RADIUS);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`;
}

export async function searchLibrary(libraryPath: string, queryInput: unknown): Promise<SearchResult[]> {
  if (typeof queryInput !== "string") {
    throw new Error("query must be a string.");
  }

  const query = queryInput.trim();
  if (!query) {
    return [];
  }

  let index = await readSearchIndex(libraryPath);
  if (index.documents.length === 0) {
    index = await rebuildSearchIndex(libraryPath);
  }

  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const document of index.documents) {
    const searchable = [
      document.seriesTitle,
      document.categoryTitle,
      document.volumeTitle ?? "",
      document.chapterTitle,
      ...document.tags,
      document.text
    ]
        .join("\n")
        .toLowerCase();

    if (!searchable.includes(lowerQuery)) {
      continue;
    }

    const textIndex = document.text.toLowerCase().indexOf(lowerQuery);
    const { text: _text, ...result } = document;
    results.push({
      ...result,
      snippet:
          textIndex >= 0
              ? searchSnippet(document.text, textIndex, query.length)
              : document.chapterTitle || document.volumeTitle || document.seriesTitle
    });

    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }

  return results;
}
