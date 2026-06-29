export const VOLUME_METADATA_SCHEMA_VERSION = 1 as const;

export type VolumeMetadata = {
  schemaVersion: typeof VOLUME_METADATA_SCHEMA_VERSION;
  id: string;
  title: string;
  order: number;
  chapterOrder: string[];
  createdAt: string;
  updatedAt: string;
};
