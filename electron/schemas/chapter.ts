export const CHAPTER_METADATA_SCHEMA_VERSION = 1 as const;

export const NOVEL_CHAPTER_TYPES = ["prologue", "chapter", "epilogue", "interlude", "afterword", "bonus"] as const;
export const TRANSLATION_STATUSES = ["draft", "editing", "reviewed", "completed"] as const;

export type NovelChapterType = (typeof NOVEL_CHAPTER_TYPES)[number];
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];

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
