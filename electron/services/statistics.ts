import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listCategoryMetadata } from "./category";
import { listChapterMetadata } from "./chapter";
import { listSeriesCards } from "./series";
import { listVolumeMetadata } from "./volume";

export type LibraryStatistics = {
  series: number;
  chapters: number;
  words: number;
  sizeBytes: number;
};

async function directorySize(directoryPath: string): Promise<number> {
  let size = 0;

  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      size += await directorySize(entryPath);
    } else if (entry.isFile()) {
      size += (await stat(entryPath)).size;
    }
  }

  return size;
}

export async function getLibraryStatistics(libraryPath: string): Promise<LibraryStatistics> {
  const series = await listSeriesCards(libraryPath);
  let chapters = 0;
  let words = 0;

  for (const seriesItem of series) {
    for (const category of await listCategoryMetadata(libraryPath, seriesItem.id)) {
      const chapterGroups =
        category.type === "web-novel"
          ? [await listChapterMetadata(libraryPath, seriesItem.id, category.id, null)]
          : await Promise.all(
              (await listVolumeMetadata(libraryPath, seriesItem.id, category.id)).map((volume) =>
                listChapterMetadata(libraryPath, seriesItem.id, category.id, volume.id)
              )
            );

      for (const group of chapterGroups) {
        chapters += group.length;
        words += group.reduce((total, chapter) => total + chapter.wordCount, 0);
      }
    }
  }

  return { series: series.length, chapters, words, sizeBytes: await directorySize(libraryPath) };
}
