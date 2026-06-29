export const CHAPTER_METADATA_SCHEMA_VERSION = 1 as const;

export const NOVEL_CHAPTER_TYPES = ["prologue", "chapter", "epilogue", "interlude", "afterword", "bonus"] as const;
export const TRANSLATION_STATUSES = ["draft", "editing", "reviewed", "completed"] as const;
export const MANGA_READING_DIRECTIONS = ["rtl", "ltr"] as const;
export const MANGA_VIEW_MODES = ["long-strip", "page"] as const;

export type NovelChapterType = (typeof NOVEL_CHAPTER_TYPES)[number];
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];
export type MangaReadingDirection = (typeof MANGA_READING_DIRECTIONS)[number];
export type MangaViewMode = (typeof MANGA_VIEW_MODES)[number];

export type NovelChapterMetadata = {
  schemaVersion: typeof CHAPTER_METADATA_SCHEMA_VERSION;
  id: string;
  title: string;
  type: NovelChapterType;
  order: number;
  wordCount: number;
  characterCount: number;
  translationStatus: TranslationStatus;
  hasOriginalPdf: boolean;
  originalFileName: string | null;
  contentFile: string;
  plainTextFile: string;
  createdAt: string;
  updatedAt: string;
};

// ponytail: schema note only; Phase 7 owns manga CRUD and page file handling.
export type MangaChapterMetadata = {
  schemaVersion: typeof CHAPTER_METADATA_SCHEMA_VERSION;
  id: string;
  title: string;
  order: number;
  pageCount: number;
  pageOrder: string[];
  readingDirection: MangaReadingDirection;
  viewMode: MangaViewMode;
  thumbnail: string | null;
  totalSizeBytes: number;
  createdAt: string;
  updatedAt: string;
};
