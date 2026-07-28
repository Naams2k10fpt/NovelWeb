export type ReaderContentTarget = {
  seriesId: string;
  categoryId: string;
  volumeId: string | null;
  chapterId: string;
};

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type ReaderContent = {
  html: string;
};

export type ReaderContentApi = {
  chapters: {
    getContent: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<ReaderContent>>;
  };
};

const MAX_CACHED_CHAPTERS = 3;
const contentCache = new Map<string, Promise<ReaderContent>>();

function contentKey(target: ReaderContentTarget): string {
  return `${target.seriesId}/${target.categoryId}/${target.volumeId ?? "direct"}/${target.chapterId}`;
}

export function clearReaderContentCache(): void {
  contentCache.clear();
}

export function invalidateReaderContent(target: ReaderContentTarget): void {
  contentCache.delete(contentKey(target));
}

export function loadReaderContent(api: ReaderContentApi, target: ReaderContentTarget): Promise<ReaderContent> {
  const key = contentKey(target);
  const cached = contentCache.get(key);

  if (cached) {
    contentCache.delete(key);
    contentCache.set(key, cached);
    return cached;
  }

  let request!: Promise<ReaderContent>;
  request = api.chapters
    .getContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId)
    .then((response) => {
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      return response.data;
    })
    .catch((error) => {
      if (contentCache.get(key) === request) {
        contentCache.delete(key);
      }
      throw error;
    });

  contentCache.set(key, request);
  while (contentCache.size > MAX_CACHED_CHAPTERS) {
    contentCache.delete(contentCache.keys().next().value!);
  }
  return request;
}

export function prefetchReaderContent(api: ReaderContentApi, target: ReaderContentTarget): void {
  void loadReaderContent(api, target).catch(() => undefined);
}
