import { useEffect, useState } from "react";
import type { ChapterTarget } from "./NovelEditor";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type SeriesDetailProps = {
  seriesId: string;
  onBack: () => void;
  onEditChapter: (target: ChapterTarget) => void;
  onReadChapter: (target: ChapterTarget) => void;
};

type SeriesMetadata = {
  id: string;
  title: string;
  originalAuthor: string | null;
  translator: string | null;
  status: string;
  description: string;
};

type CategoryType = "light-novel" | "web-novel" | "manga";

type CategoryMetadata = {
  id: string;
  type: CategoryType;
  title: string;
};

type VolumeMetadata = {
  id: string;
  title: string;
};

type ChapterMetadata = {
  id: string;
  title: string;
  translationStatus?: string;
  pageCount?: number;
};

type VolumeDetail = {
  volume: VolumeMetadata;
  chapters: ChapterMetadata[];
};

type CategoryDetail = CategoryMetadata & {
  volumes: VolumeDetail[];
  directChapters: ChapterMetadata[];
};

type DetailState = {
  loading: boolean;
  series: SeriesMetadata | null;
  categories: CategoryDetail[];
  error: string | null;
};

type RendererApi = {
  series: {
    get: (seriesId: string) => Promise<ApiResponse<SeriesMetadata>>;
  };
  categories: {
    list: (seriesId: string) => Promise<ApiResponse<CategoryMetadata[]>>;
  };
  volumes: {
    list: (seriesId: string, categoryId: string) => Promise<ApiResponse<VolumeMetadata[]>>;
  };
  chapters: {
    list: (seriesId: string, categoryId: string, volumeId?: string | null) => Promise<ApiResponse<ChapterMetadata[]>>;
  };
};

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.data;
}

function formatLabel(value: string): string {
  return value.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

async function loadCategory(api: RendererApi, seriesId: string, category: CategoryMetadata): Promise<CategoryDetail> {
  if (category.type === "manga") {
    return { ...category, volumes: [], directChapters: unwrap(await api.chapters.list(seriesId, category.id, null)) };
  }

  const volumes = unwrap(await api.volumes.list(seriesId, category.id));
  const volumeDetails = await Promise.all(
    volumes.map(async (volume): Promise<VolumeDetail> => ({
      volume,
      chapters: unwrap(await api.chapters.list(seriesId, category.id, volume.id))
    }))
  );
  const directChapters =
    category.type === "web-novel" ? unwrap(await api.chapters.list(seriesId, category.id, null)) : [];

  return { ...category, volumes: volumeDetails, directChapters };
}

export default function SeriesDetail({ seriesId, onBack, onEditChapter, onReadChapter }: SeriesDetailProps) {
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({
    loading: true,
    series: null,
    categories: [],
    error: null
  });

  useEffect(() => {
    let isMounted = true;
    const api = getApi();

    if (!api) {
      setDetail({
        loading: false,
        series: null,
        categories: [],
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      return;
    }

    setDetail({ loading: true, series: null, categories: [], error: null });

    void Promise.all([api.series.get(seriesId), api.categories.list(seriesId)])
      .then(async ([seriesResponse, categoriesResponse]) => {
        const series = unwrap(seriesResponse);
        const categories = await Promise.all(
          unwrap(categoriesResponse).map((category) => loadCategory(api, seriesId, category))
        );

        if (isMounted) {
          setActiveCategoryId(categories[0]?.id ?? null);
          setDetail({ loading: false, series, categories, error: null });
        }
      })
      .catch((error) => {
        if (isMounted) {
          setDetail({ loading: false, series: null, categories: [], error: String(error) });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [seriesId]);

  if (detail.loading) {
    return (
      <section className="empty-state">
        <h2>Loading series</h2>
        <p>Reading series structure.</p>
      </section>
    );
  }

  if (detail.error || !detail.series) {
    return (
      <section className="empty-state">
        <h2>Could not load series</h2>
        <p>{detail.error ?? "Series metadata is unavailable."}</p>
        <button className="primary-action" onClick={onBack} type="button">
          Back to Library
        </button>
      </section>
    );
  }

  const activeCategory = detail.categories.find((category) => category.id === activeCategoryId) ?? null;

  return (
    <section className="series-detail">
      <button className="plain-action" onClick={onBack} type="button">
        Back
      </button>

      <header className="series-detail-header">
        <span>{formatLabel(detail.series.status)}</span>
        <h2>{detail.series.title}</h2>
        <p>{detail.series.originalAuthor ?? detail.series.translator ?? "Unknown author"}</p>
        {detail.series.description ? <p>{detail.series.description}</p> : null}
      </header>

      {detail.categories.length === 0 ? (
        <section className="empty-state">
          <h2>No categories yet</h2>
          <p>Add a Light Novel, Web Novel, or Manga category in Manager later.</p>
        </section>
      ) : (
        <>
          <nav className="category-tabs" aria-label="Series categories">
            {detail.categories.map((category) => (
              <button
                aria-current={activeCategory?.id === category.id ? "page" : undefined}
                className={activeCategory?.id === category.id ? "category-tab category-tab-active" : "category-tab"}
                key={category.id}
                onClick={() => setActiveCategoryId(category.id)}
                type="button"
              >
                {category.title}
              </button>
            ))}
          </nav>

          {activeCategory ? (
            <CategoryPanel
              category={activeCategory}
              onEditChapter={onEditChapter}
              onReadChapter={onReadChapter}
              seriesId={seriesId}
              seriesTitle={detail.series.title}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function CategoryPanel({
  category,
  onEditChapter,
  onReadChapter,
  seriesId,
  seriesTitle
}: {
  category: CategoryDetail;
  onEditChapter: (target: ChapterTarget) => void;
  onReadChapter: (target: ChapterTarget) => void;
  seriesId: string;
  seriesTitle: string;
}) {
  if (category.type === "manga") {
    return (
      <section className="category-panel">
        <div className="category-heading">
          <h3>{category.title}</h3>
          <span>Manga</span>
        </div>
        <MangaChapterList
          categoryId={category.id}
          chapters={category.directChapters}
          onReadChapter={onReadChapter}
          seriesId={seriesId}
          seriesTitle={seriesTitle}
        />
      </section>
    );
  }

  const isEmpty = category.volumes.length === 0 && category.directChapters.length === 0;

  return (
    <section className="category-panel">
      <div className="category-heading">
        <h3>{category.title}</h3>
        <span>{formatLabel(category.type)}</span>
      </div>

      {isEmpty ? (
        <p className="muted-text">No volumes or chapters yet.</p>
      ) : (
        <>
          {category.directChapters.length > 0 ? (
            <ChapterList
              categoryId={category.id}
              chapters={category.directChapters}
              onEditChapter={onEditChapter}
              onReadChapter={onReadChapter}
              seriesId={seriesId}
              seriesTitle={seriesTitle}
              title="Chapters"
              volumeId={null}
            />
          ) : null}

          {category.volumes.map(({ volume, chapters }) => (
            <ChapterList
              categoryId={category.id}
              chapters={chapters}
              key={volume.id}
              onEditChapter={onEditChapter}
              onReadChapter={onReadChapter}
              seriesId={seriesId}
              seriesTitle={seriesTitle}
              title={volume.title}
              volumeId={volume.id}
            />
          ))}
        </>
      )}
    </section>
  );
}

function ChapterList({
  categoryId,
  chapters,
  onEditChapter,
  onReadChapter,
  seriesId,
  seriesTitle,
  title,
  volumeId
}: {
  categoryId: string;
  chapters: ChapterMetadata[];
  onEditChapter: (target: ChapterTarget) => void;
  onReadChapter: (target: ChapterTarget) => void;
  seriesId: string;
  seriesTitle: string;
  title: string;
  volumeId: string | null;
}) {
  function targetFor(chapter: ChapterMetadata): ChapterTarget {
    return {
      categoryId,
      chapterId: chapter.id,
      seriesId,
      seriesTitle,
      title: chapter.title,
      volumeId
    };
  }

  return (
    <section className="chapter-group">
      <h4>{title}</h4>
      {chapters.length === 0 ? (
        <p className="muted-text">No chapters yet.</p>
      ) : (
        <ol>
          {chapters.map((chapter) => (
            <li key={chapter.id}>
              <button
                className="chapter-row"
                onClick={() => onReadChapter(targetFor(chapter))}
                type="button"
              >
                <span>{chapter.title}</span>
                <span>{formatLabel(chapter.translationStatus ?? "draft")}</span>
              </button>
              <button className="chapter-edit-action" onClick={() => onEditChapter(targetFor(chapter))} type="button">
                Edit
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function MangaChapterList({
  categoryId,
  chapters,
  onReadChapter,
  seriesId,
  seriesTitle
}: {
  categoryId: string;
  chapters: ChapterMetadata[];
  onReadChapter: (target: ChapterTarget) => void;
  seriesId: string;
  seriesTitle: string;
}) {
  if (chapters.length === 0) {
    return <p className="muted-text">No manga chapters yet.</p>;
  }

  function targetFor(chapter: ChapterMetadata): ChapterTarget {
    return {
      categoryId,
      categoryType: "manga",
      chapterId: chapter.id,
      seriesId,
      seriesTitle,
      title: chapter.title,
      volumeId: null
    };
  }

  return (
    <section className="chapter-group">
      <h4>Chapters</h4>
      <ol>
        {chapters.map((chapter) => (
          <li key={chapter.id}>
            <button className="chapter-row" onClick={() => onReadChapter(targetFor(chapter))} type="button">
              <span>{chapter.title}</span>
              <span>{chapter.pageCount ?? 0} pages</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
