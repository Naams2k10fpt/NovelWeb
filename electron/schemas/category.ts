export const CATEGORY_METADATA_SCHEMA_VERSION = 1 as const;

export const CATEGORY_TYPES = ["light-novel", "web-novel"] as const;

export type CategoryType = (typeof CATEGORY_TYPES)[number];

export type CategoryMetadata = {
  schemaVersion: typeof CATEGORY_METADATA_SCHEMA_VERSION;
  id: string;
  type: CategoryType;
  title: string;
  volumeOrder: string[];
  chapterOrder: string[];
  createdAt: string;
  updatedAt: string;
};
