import { useEffect, useState, type FormEvent } from "react";
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
  genres: string[];
  tags: string[];
  status: SeriesStatus;
  description: string;
  coverImage: string | null;
  coverDataUrl: string | null;
};

type SeriesStatus = "planning" | "translating" | "completed" | "paused" | "dropped";

const SERIES_STATUSES: SeriesStatus[] = ["planning", "translating", "completed", "paused", "dropped"];

type SeriesFormState = {
  title: string;
  originalAuthor: string;
  genres: string[];
  newGenre: string;
  tags: string;
  status: SeriesStatus;
  description: string;
};

type SeriesCard = {
  genres: string[];
};

type CategoryType = "light-novel" | "web-novel";

type CategoryMetadata = {
  id: string;
  type: string;
  title: string;
};

type VolumeMetadata = {
  id: string;
  title: string;
};

type ChapterMetadata = {
  id: string;
  title: string;
  tags: string[];
  translationStatus?: string;
};

type VolumeDetail = {
  volume: VolumeMetadata;
  chapters: ChapterMetadata[];
};

type SupportedCategoryMetadata = CategoryMetadata & {
  type: CategoryType;
};

type CategoryDetail = SupportedCategoryMetadata & {
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
    list: () => Promise<ApiResponse<SeriesCard[]>>;
    get: (seriesId: string) => Promise<ApiResponse<SeriesMetadata>>;
    update: (seriesId: string, input: unknown) => Promise<ApiResponse<SeriesMetadata>>;
    chooseCover: (seriesId: string) => Promise<ApiResponse<SeriesMetadata | null>>;
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
function isSupportedCategory(category: CategoryMetadata): category is SupportedCategoryMetadata {
  return category.type === "light-novel" || category.type === "web-novel";
}

function formFromSeries(series: SeriesMetadata): SeriesFormState {
  return {
    title: series.title,
    originalAuthor: series.originalAuthor ?? "",
    genres: series.genres,
    newGenre: "",
    tags: series.tags.join(", "),
    status: series.status,
    description: series.description
  };
}

function uniqueGenres(genres: string[]): string[] {
  return [...new Set(genres.map((genre) => genre.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

async function loadCategory(api: RendererApi, seriesId: string, category: SupportedCategoryMetadata): Promise<CategoryDetail> {
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
  const [coverSaving, setCoverSaving] = useState(false);
  const [detail, setDetail] = useState<DetailState>({
    loading: true,
    series: null,
    categories: [],
    error: null
  });
  const [form, setForm] = useState<SeriesFormState | null>(null);
  const [knownGenres, setKnownGenres] = useState<string[]>([]);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataSaving, setMetadataSaving] = useState(false);

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
    setForm(null);
    setMetadataError(null);

    void Promise.all([api.series.get(seriesId), api.categories.list(seriesId), api.series.list()])
      .then(async ([seriesResponse, categoriesResponse, seriesListResponse]) => {
        const series = unwrap(seriesResponse);
        const categories = await Promise.all(
          unwrap(categoriesResponse)
            .filter(isSupportedCategory)
            .map((category) => loadCategory(api, seriesId, category))
        );
        const seriesCards = unwrap(seriesListResponse);

        if (isMounted) {
          setActiveCategoryId(categories[0]?.id ?? null);
          setDetail({ loading: false, series, categories, error: null });
          setKnownGenres(uniqueGenres([...seriesCards.flatMap((item) => item.genres), ...series.genres]));
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

  async function saveSeriesMetadata(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const api = getApi();

    if (!api || !form) {
      setMetadataError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    const title = form.title.trim();

    if (!title) {
      setMetadataError("Title is required.");
      return;
    }

    setMetadataError(null);
    setMetadataSaving(true);

    try {
      const series = unwrap(
        await api.series.update(seriesId, {
          title,
          originalAuthor: form.originalAuthor.trim() || null,
          genres: form.genres,
          tags: parseTags(form.tags),
          status: form.status,
          description: form.description
        })
      );
      setDetail((current) => ({ ...current, series }));
      setKnownGenres((current) => uniqueGenres([...current, ...series.genres]));
      setForm(null);
    } catch (error) {
      setMetadataError(String(error));
    } finally {
      setMetadataSaving(false);
    }
  }

  async function chooseCover(): Promise<void> {
    const api = getApi();

    if (!api) {
      setMetadataError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setMetadataError(null);
    setCoverSaving(true);

    try {
      const series = unwrap(await api.series.chooseCover(seriesId));

      if (series) {
        setDetail((current) => ({ ...current, series }));
      }
    } catch (error) {
      setMetadataError(String(error));
    } finally {
      setCoverSaving(false);
    }
  }

  function toggleGenre(genre: string): void {
    setForm((current) =>
      current
        ? {
            ...current,
            genres: current.genres.includes(genre)
              ? current.genres.filter((item) => item !== genre)
              : uniqueGenres([...current.genres, genre])
          }
        : current
    );
  }

  function addGenre(): void {
    if (!form) {
      return;
    }

    const genre = form.newGenre.trim();

    if (!genre) {
      return;
    }

    const nextGenres = uniqueGenres([...knownGenres, genre]);
    setKnownGenres(nextGenres);
    setForm({ ...form, genres: uniqueGenres([...form.genres, genre]), newGenre: "" });
  }

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
        <div className="series-detail-cover">
          {detail.series.coverDataUrl ? (
            <img alt="" src={detail.series.coverDataUrl} />
          ) : (
            <span>{detail.series.title.trim().slice(0, 1).toUpperCase() || "N"}</span>
          )}
        </div>
        <div className="series-detail-info">
          <span>{formatLabel(detail.series.status)}</span>
          <h2>{detail.series.title}</h2>
          <p>{detail.series.originalAuthor ?? detail.series.translator ?? "Unknown author"}</p>
          {detail.series.genres.length > 0 ? (
            <p className="series-detail-genres">{detail.series.genres.join(", ")}</p>
          ) : null}
          {detail.series.tags.length > 0 ? (
            <p className="series-detail-genres">{detail.series.tags.map((tag) => `#${tag}`).join(" ")}</p>
          ) : null}
          {detail.series.description ? <p>{detail.series.description}</p> : null}
          <div className="series-detail-actions">
            <button onClick={() => setForm(form ? null : formFromSeries(detail.series!))} type="button">
              {form ? "Cancel edit" : "Edit metadata"}
            </button>
            <button disabled={coverSaving} onClick={() => void chooseCover()} type="button">
              {coverSaving ? "Saving cover" : "Choose cover"}
            </button>
          </div>
        </div>
      </header>

      {metadataError ? <p className="error-text">{metadataError}</p> : null}

      {form ? (
        <form className="series-metadata-form" onSubmit={(event) => void saveSeriesMetadata(event)}>
          <label>
            <span>Title</span>
            <input
              autoFocus
              onChange={(event) => setForm((current) => (current ? { ...current, title: event.target.value } : current))}
              value={form.title}
            />
          </label>
          <label>
            <span>Author</span>
            <input
              onChange={(event) =>
                setForm((current) => (current ? { ...current, originalAuthor: event.target.value } : current))
              }
              value={form.originalAuthor}
            />
          </label>
          <label>
            <span>Status</span>
            <select
              onChange={(event) =>
                setForm((current) => (current ? { ...current, status: event.target.value as SeriesStatus } : current))
              }
              value={form.status}
            >
              {SERIES_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {formatLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="series-genre-picker">
            <legend>Genres</legend>
            {knownGenres.length === 0 ? <p className="muted-text">No genres yet.</p> : null}
            <div className="series-genre-options">
              {knownGenres.map((genre) => (
                <label key={genre}>
                  <input checked={form.genres.includes(genre)} onChange={() => toggleGenre(genre)} type="checkbox" />
                  <span>{genre}</span>
                </label>
              ))}
            </div>
            <div className="series-genre-add">
              <input
                onChange={(event) => setForm((current) => (current ? { ...current, newGenre: event.target.value } : current))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addGenre();
                  }
                }}
                placeholder="Add genre"
                value={form.newGenre}
              />
              <button disabled={!form.newGenre.trim()} onClick={addGenre} type="button">
                Add
              </button>
            </div>
          </fieldset>
          <label>
            <span>Tags</span>
            <input
              onChange={(event) => setForm((current) => (current ? { ...current, tags: event.target.value } : current))}
              placeholder="favorite, isekai, needs edit"
              value={form.tags}
            />
          </label>
          <label className="series-description-field">
            <span>Description</span>
            <textarea
              onChange={(event) =>
                setForm((current) => (current ? { ...current, description: event.target.value } : current))
              }
              value={form.description}
            />
          </label>
          <div className="series-detail-actions">
            <button className="primary-action" disabled={metadataSaving || !form.title.trim()} type="submit">
              {metadataSaving ? "Saving" : "Save metadata"}
            </button>
            <button disabled={metadataSaving} onClick={() => setForm(null)} type="button">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {detail.categories.length === 0 ? (
        <section className="empty-state">
          <h2>No categories yet</h2>
          <p>Add a Light Novel or Web Novel category in Manager later.</p>
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
    <details className="chapter-group">
      <summary>
        <span className="chapter-group-title">{title}</span>
        <span className="chapter-group-count">
          {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}
        </span>
      </summary>
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
                <span>
                  {[formatLabel(chapter.translationStatus ?? "draft"), ...chapter.tags.map((tag) => `#${tag}`)].join(" · ")}
                </span>
              </button>
              <button className="chapter-edit-action" onClick={() => onEditChapter(targetFor(chapter))} type="button">
                Edit
              </button>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
