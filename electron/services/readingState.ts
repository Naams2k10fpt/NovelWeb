import { randomUUID } from "node:crypto";
import { readdir, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertId,
  assertRecord,
  assertSupportedSchemaVersion,
  backupExistingFile,
  libraryChildPath,
  readJsonFile,
  readOptionalNonNegativeInteger,
  readOptionalString,
  readRequiredText,
  recentIndexPath,
  seriesBookmarksPath,
  seriesHighlightsPath,
  seriesProgressPath,
  SUPPORTED_SCHEMA_VERSION,
  withResourceWriteLock,
  writeJsonFile,
  type BookmarkEntry,
  type ChapterReadingProgress,
  type HighlightColor,
  type HighlightEntry,
  type ReadingListEntry,
  type ReadingProgressEntry,
  type SeriesBookmarks,
  type SeriesHighlights,
  type SeriesProgress,
  type JsonRecord
} from "./base";
import { readSeriesMetadata } from "./series";
import { readCategoryMetadata } from "./category";
import { readVolumeMetadata } from "./volume";
import { readNovelChapterMetadata } from "./chapter";
import { ensureRecentIndexJson } from "./library";

export const MAX_RECENT_ENTRIES = 50;
export const HIGHLIGHT_COLORS = ["yellow", "green", "pink", "blue"] as const;

export type ChapterReference = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
};

export function compareReadingListEntries(left: ReadingListEntry, right: ReadingListEntry): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

export function sameChapterReference(left: ChapterReference, right: ChapterReference): boolean {
  return (
    left.seriesId === right.seriesId &&
    left.categoryId === right.categoryId &&
    left.volumeId === right.volumeId &&
    left.chapterId === right.chapterId
  );
}

export function parseChapterProgressKey(key: string): { categoryId: string; volumeId: string | null; chapterId: string } | null {
  const parts = key.split("/");

  if (parts.length !== 3) {
    return null;
  }

  const [categoryId, volumePart, chapterId] = parts;
  const safeId = /^[a-zA-Z0-9_-]+$/;

  if (!safeId.test(categoryId) || !safeId.test(chapterId) || (volumePart !== "direct" && !safeId.test(volumePart))) {
    return null;
  }

  return { categoryId, volumeId: volumePart === "direct" ? null : volumePart, chapterId };
}

export function chapterProgressKey(categoryId: string, volumeId: string | null, chapterId: string): string {
  return `${assertId(categoryId, "categoryId")}/${volumeId ? assertId(volumeId, "volumeId") : "direct"}/${assertId(chapterId, "chapterId")}`;
}

export async function readChapterReference(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterReference> {
  const [series, category, chapter] = await Promise.all([
    readSeriesMetadata(libraryPath, seriesId),
    readCategoryMetadata(libraryPath, seriesId, categoryId),
    readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId)
  ]);
  const volume = volumeId ? await readVolumeMetadata(libraryPath, seriesId, categoryId, volumeId) : null;

  return {
    seriesId: series.id,
    seriesTitle: series.title,
    categoryId: category.id,
    categoryTitle: category.title,
    volumeId: volume?.id ?? null,
    volumeTitle: volume?.title ?? null,
    chapterId: chapter.id,
    chapterTitle: chapter.title
  };
}

export async function readSeriesProgress(libraryPath: string, seriesId: string): Promise<SeriesProgress> {
  try {
    const progress = await readJsonFile<SeriesProgress>(seriesProgressPath(libraryPath, seriesId));
    assertSupportedSchemaVersion("progress.json", progress);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, chapters: progress.chapters ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, chapters: {} };
    }

    throw error;
  }
}

export async function rebuildRecentIndex(libraryPath: string): Promise<RecentIndex> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  // Create series directory if missing
  await mkdir(seriesDirectory, { recursive: true });
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const recentEntries: ReadingListEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      await readSeriesMetadata(libraryPath, entry.name);
      const progress = await readSeriesProgress(libraryPath, entry.name);

      for (const [key, itemValue] of Object.entries(progress.chapters)) {
        const target = parseChapterProgressKey(key);
        const item = itemValue as ReadingProgressEntry;

        if (!target || !item.updatedAt || typeof item.scrollTop !== "number") {
          continue;
        }

        try {
          recentEntries.push({
            ...(await readChapterReference(libraryPath, entry.name, target.categoryId, target.volumeId, target.chapterId)),
            scrollTop: item.scrollTop,
            updatedAt: item.updatedAt
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const index: RecentIndex = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    entries: recentEntries.sort(compareReadingListEntries).slice(0, MAX_RECENT_ENTRIES)
  };

  await writeJsonFile(recentIndexPath(libraryPath), index, { backup: true });
  return index;
}

export type RecentIndex = {
  schemaVersion: number;
  generatedAt: string;
  entries: ReadingListEntry[];
};

export async function readRecentIndex(libraryPath: string): Promise<RecentIndex> {
  try {
    const index = await readJsonFile<RecentIndex>(recentIndexPath(libraryPath));
    assertSupportedSchemaVersion("recent-index.json", index);
    return Array.isArray(index.entries) ? index : { ...index, entries: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return rebuildRecentIndex(libraryPath);
  }
}

export async function listRecentEntries(libraryPath: string): Promise<ReadingListEntry[]> {
  const index = await readRecentIndex(libraryPath);
  return index.entries;
}

export async function upsertRecentEntry(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  progress: ChapterReadingProgress
): Promise<void> {
  if (!progress.updatedAt) {
    return;
  }

  const entry: ReadingListEntry = {
    ...(await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId)),
    scrollTop: progress.scrollTop,
    updatedAt: progress.updatedAt
  };
  const filePath = recentIndexPath(libraryPath);

  await ensureRecentIndexJson(libraryPath);
  await withResourceWriteLock(filePath, async () => {
    const current = await readJsonFile<RecentIndex>(filePath);
    assertSupportedSchemaVersion("recent-index.json", current);

    const index: RecentIndex = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      entries: [entry, ...(current.entries ?? []).filter((item) => !sameChapterReference(item, entry))]
        .sort(compareReadingListEntries)
        .slice(0, MAX_RECENT_ENTRIES)
    };
    const tmpPath = `${filePath}.tmp`;

    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  });
}

export async function readSeriesBookmarks(libraryPath: string, seriesId: string): Promise<SeriesBookmarks> {
  try {
    const bookmarks = await readJsonFile<SeriesBookmarks>(seriesBookmarksPath(libraryPath, seriesId));
    assertSupportedSchemaVersion("bookmarks.json", bookmarks);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: Array.isArray(bookmarks.entries) ? bookmarks.entries : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: [] };
    }

    throw error;
  }
}

export async function getChapterBookmark(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<BookmarkEntry | null> {
  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const bookmarks = await readSeriesBookmarks(libraryPath, seriesId);
  const entry = bookmarks.entries.find((item) => sameChapterReference(item, reference));

  return entry ? { ...entry, ...reference } : null;
}

export async function toggleChapterBookmark(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<BookmarkEntry | null> {
  const record = assertRecord(input);
  const scrollTop = Number(record.scrollTop);

  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new Error("scrollTop must be a non-negative number.");
  }

  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const filePath = seriesBookmarksPath(libraryPath, seriesId);

  return withResourceWriteLock(filePath, async () => {
    const bookmarks = await readSeriesBookmarks(libraryPath, seriesId);
    const existing = bookmarks.entries.find((item) => sameChapterReference(item, reference));
    const now = new Date().toISOString();
    const createdBookmark: BookmarkEntry | null = existing
      ? null
      : {
          ...reference,
          scrollTop,
          createdAt: now,
          updatedAt: now
        };
    const nextEntries = createdBookmark
      ? [createdBookmark, ...bookmarks.entries]
      : bookmarks.entries.filter((item) => !sameChapterReference(item, reference));
    const next: SeriesBookmarks = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      entries: nextEntries.sort(compareReadingListEntries)
    };
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);

    return createdBookmark;
  });
}

export async function listBookmarks(libraryPath: string): Promise<BookmarkEntry[]> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  // Create series directory if missing
  await mkdir(seriesDirectory, { recursive: true });
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const bookmarks: BookmarkEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const seriesBookmarks = await readSeriesBookmarks(libraryPath, entry.name);

      for (const bookmark of seriesBookmarks.entries) {
        try {
          bookmarks.push({
            ...bookmark,
            ...(await readChapterReference(
              libraryPath,
              bookmark.seriesId,
              bookmark.categoryId,
              bookmark.volumeId,
              bookmark.chapterId
            ))
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return bookmarks.sort(compareReadingListEntries);
}

export function readHighlightColor(record: JsonRecord): HighlightColor {
  const color = readOptionalString(record, "color", "yellow");

  if ((HIGHLIGHT_COLORS as readonly string[]).includes(color)) {
    return color as HighlightColor;
  }

  throw new Error("color is invalid.");
}

export function readHighlightScrollTop(record: JsonRecord): number {
  const scrollTop = Number(record.scrollTop ?? 0);

  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new Error("scrollTop must be a non-negative number.");
  }

  return scrollTop;
}

export function readHighlightTextRange(record: JsonRecord): { textStart?: number; textEnd?: number } {
  if (record.textStart === undefined && record.textEnd === undefined) {
    return {};
  }

  if (record.textStart === undefined || record.textEnd === undefined) {
    throw new Error("textStart and textEnd must be provided together.");
  }

  const textStart = readOptionalNonNegativeInteger(record, "textStart", 0);
  const textEnd = readOptionalNonNegativeInteger(record, "textEnd", 0);

  if (textEnd <= textStart) {
    throw new Error("textEnd must be greater than textStart.");
  }

  return { textStart, textEnd };
}

export async function readSeriesHighlights(libraryPath: string, seriesId: string): Promise<SeriesHighlights> {
  try {
    const highlights = await readJsonFile<SeriesHighlights>(seriesHighlightsPath(libraryPath, seriesId));
    assertSupportedSchemaVersion("highlights.json", highlights);
    return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: Array.isArray(highlights.entries) ? highlights.entries : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SUPPORTED_SCHEMA_VERSION, entries: [] };
    }

    throw error;
  }
}

export async function createHighlight(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<HighlightEntry> {
  const record = assertRecord(input);
  const text = readRequiredText(record, "text").replace(/\s+/g, " ").trim();
  const note = readOptionalString(record, "note", "");

  if (!text) {
    throw new Error("text is required.");
  }

  if (text.length > 2000) {
    throw new Error("text is too long.");
  }

  if (note.length > 2000) {
    throw new Error("note is too long.");
  }

  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const filePath = seriesHighlightsPath(libraryPath, seriesId);

  return withResourceWriteLock(filePath, async () => {
    const highlights = await readSeriesHighlights(libraryPath, seriesId);
    const now = new Date().toISOString();
    const textRange = readHighlightTextRange(record);
    const entry: HighlightEntry = {
      ...reference,
      id: randomUUID(),
      text,
      ...textRange,
      color: readHighlightColor(record),
      note,
      scrollTop: readHighlightScrollTop(record),
      createdAt: now,
      updatedAt: now
    };
    const next: SeriesHighlights = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      entries: [entry, ...highlights.entries].sort(compareReadingListEntries)
    };
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);

    return entry;
  });
}

export async function listChapterHighlights(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<HighlightEntry[]> {
  const reference = await readChapterReference(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const highlights = await readSeriesHighlights(libraryPath, seriesId);

  return highlights.entries
    .filter((item) => sameChapterReference(item, reference))
    .map((item) => ({ ...item, ...reference }))
    .sort(compareReadingListEntries);
}

export async function listHighlights(libraryPath: string): Promise<HighlightEntry[]> {
  const seriesDirectory = libraryChildPath(libraryPath, "series");
  // Create series directory if missing
  await mkdir(seriesDirectory, { recursive: true });
  const entries = await readdir(seriesDirectory, { withFileTypes: true });
  const highlights: HighlightEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const seriesHighlights = await readSeriesHighlights(libraryPath, entry.name);

      for (const highlight of seriesHighlights.entries) {
        try {
          highlights.push({
            ...highlight,
            ...(await readChapterReference(
              libraryPath,
              highlight.seriesId,
              highlight.categoryId,
              highlight.volumeId,
              highlight.chapterId
            ))
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return highlights.sort(compareReadingListEntries);
}

export async function deleteHighlight(libraryPath: string, seriesId: string, highlightId: string): Promise<{ id: string }> {
  const filePath = seriesHighlightsPath(libraryPath, seriesId);

  return withResourceWriteLock(filePath, async () => {
    const highlights = await readSeriesHighlights(libraryPath, seriesId);
    const next: SeriesHighlights = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      entries: highlights.entries.filter((item) => item.id !== highlightId)
    };
    const tmpPath = `${filePath}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    await backupExistingFile(filePath);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);

    return { id: highlightId };
  });
}

export function moveReadingEntryReference<T extends ReadingListEntry>(
  entry: T,
  oldReference: ChapterReference,
  newReference: ChapterReference
): T {
  return sameChapterReference(entry, oldReference) ? { ...entry, ...newReference } : entry;
}

export async function updateChapterReadingReferences(
  libraryPath: string,
  oldReference: ChapterReference,
  newReference: ChapterReference
): Promise<void> {
  const oldProgressKey = chapterProgressKey(oldReference.categoryId, oldReference.volumeId, oldReference.chapterId);
  const newProgressKey = chapterProgressKey(newReference.categoryId, newReference.volumeId, newReference.chapterId);
  const progress = await readSeriesProgress(libraryPath, oldReference.seriesId);

  if (progress.chapters[oldProgressKey]) {
    const chapters = { ...progress.chapters, [newProgressKey]: progress.chapters[oldProgressKey] };
    delete chapters[oldProgressKey];
    await writeJsonFile(seriesProgressPath(libraryPath, oldReference.seriesId), { ...progress, chapters }, { backup: true });
  }

  const bookmarks = await readSeriesBookmarks(libraryPath, oldReference.seriesId);
  if (bookmarks.entries.some((entry) => sameChapterReference(entry, oldReference))) {
    await writeJsonFile(
      seriesBookmarksPath(libraryPath, oldReference.seriesId),
      {
        ...bookmarks,
        entries: bookmarks.entries
          .map((entry) => moveReadingEntryReference(entry, oldReference, newReference))
          .sort(compareReadingListEntries)
      } satisfies SeriesBookmarks,
      { backup: true }
    );
  }

  const highlights = await readSeriesHighlights(libraryPath, oldReference.seriesId);
  if (highlights.entries.some((entry) => sameChapterReference(entry, oldReference))) {
    await writeJsonFile(
      seriesHighlightsPath(libraryPath, oldReference.seriesId),
      {
        ...highlights,
        entries: highlights.entries
          .map((entry) => moveReadingEntryReference(entry, oldReference, newReference))
          .sort(compareReadingListEntries)
      } satisfies SeriesHighlights,
      { backup: true }
    );
  }
}

export async function readChapterReadingProgress(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string
): Promise<ChapterReadingProgress> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const progress = await readSeriesProgress(libraryPath, seriesId);
  const entry = progress.chapters[chapterProgressKey(categoryId, volumeId, chapterId)];
  return {
    scrollTop: typeof entry?.scrollTop === "number" && entry.scrollTop >= 0 ? entry.scrollTop : 0,
    updatedAt: entry?.updatedAt ?? null
  };
}

export async function saveChapterReadingProgress(
  libraryPath: string,
  seriesId: string,
  categoryId: string,
  volumeId: string | null,
  chapterId: string,
  input: unknown
): Promise<ChapterReadingProgress> {
  await readNovelChapterMetadata(libraryPath, seriesId, categoryId, volumeId, chapterId);
  const record = assertRecord(input);
  const scrollTop = Number(record.scrollTop);

  if (!Number.isFinite(scrollTop) || scrollTop < 0) {
    throw new Error("scrollTop must be a non-negative number.");
  }

  const progress = await readSeriesProgress(libraryPath, seriesId);
  const next: ChapterReadingProgress = { scrollTop, updatedAt: new Date().toISOString() };
  progress.chapters[chapterProgressKey(categoryId, volumeId, chapterId)] = next;
  await writeJsonFile(seriesProgressPath(libraryPath, seriesId), progress, { backup: true });
  await upsertRecentEntry(libraryPath, seriesId, categoryId, volumeId, chapterId, next);
  return next;
}
