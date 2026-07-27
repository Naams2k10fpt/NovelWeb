export const SERIES_METADATA_SCHEMA_VERSION = 1 as const;

export const SERIES_STATUSES = ["planning", "translating", "completed", "paused", "dropped"] as const;
export const SERIES_COLLECTIONS = ["reading", "favorite", "needs-edit", "completed"] as const;

export type SeriesStatus = (typeof SERIES_STATUSES)[number];
export type SeriesCollection = (typeof SERIES_COLLECTIONS)[number];

export type SeriesMetadata = {
  schemaVersion: typeof SERIES_METADATA_SCHEMA_VERSION;
  id: string;
  title: string;
  originalTitle: string | null;
  originalAuthor: string | null;
  translator: string | null;
  genres: string[];
  tags: string[];
  collections: SeriesCollection[];
  status: SeriesStatus;
  publisher: string | null;
  year: number | null;
  language: string;
  sourceLanguage: string | null;
  description: string;
  categoryOrder: string[];
  coverImage: string | null;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
};
