import { useEffect, useState } from "react";
import type { ChapterTarget } from "./NovelEditor";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type LibraryPageProps = {
  library: {
    loading: boolean;
    path: string | null;
    error: string | null;
  };
  onOpenSettings: () => void;
  onOpenChapter: (target: ChapterTarget) => void;
  onOpenSeries: (seriesId: string) => void;
};

type SeriesCard = {
  id: string;
  title: string;
  author: string | null;
  genres: string[];
  status: string;
  coverDataUrl: string | null;
};

type ReadingListEntry = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
  scrollTop: number;
  updatedAt: string;
};

type RendererApi = {
  series: {
    list: () => Promise<ApiResponse<SeriesCard[]>>;
  };
  reading?: {
    listRecent: () => Promise<ApiResponse<ReadingListEntry[]>>;
  };
  bookmarks?: {
    list: () => Promise<ApiResponse<ReadingListEntry[]>>;
  };
};

type SeriesState = {
  loading: boolean;
  items: SeriesCard[];
  error: string | null;
};

type ReadingState = {
  loading: boolean;
  recent: ReadingListEntry[];
  bookmarks: ReadingListEntry[];
  error: string | null;
};

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

function formatStatus(status: string): string {
  return status.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function targetFor(entry: ReadingListEntry): ChapterTarget {
  return {
    seriesId: entry.seriesId,
    categoryId: entry.categoryId,
    volumeId: entry.volumeId,
    chapterId: entry.chapterId,
    seriesTitle: entry.seriesTitle,
    title: entry.chapterTitle,
    scrollTop: entry.scrollTop
  };
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export default function Library({ library, onOpenChapter, onOpenSettings, onOpenSeries }: LibraryPageProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [reading, setReading] = useState<ReadingState>({
    loading: false,
    recent: [],
    bookmarks: [],
    error: null
  });
  const [series, setSeries] = useState<SeriesState>({
    loading: false,
    items: [],
    error: null
  });

  useEffect(() => {
    let isMounted = true;

    if (!library.path) {
      setSeries({ loading: false, items: [], error: null });
      setReading({ loading: false, recent: [], bookmarks: [], error: null });
      return;
    }

    const api = getApi();
    if (!api) {
      setSeries({
        loading: false,
        items: [],
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      setReading({ loading: false, recent: [], bookmarks: [], error: null });
      return;
    }

    setSeries({ loading: true, items: [], error: null });
    setReading({ loading: true, recent: [], bookmarks: [], error: null });

    void Promise.all([
      api.series.list(),
      api.reading?.listRecent() ?? Promise.resolve({ ok: true, data: [] } as ApiResponse<ReadingListEntry[]>),
      api.bookmarks?.list() ?? Promise.resolve({ ok: true, data: [] } as ApiResponse<ReadingListEntry[]>)
    ])
      .then(([seriesResponse, recentResponse, bookmarksResponse]) => {
        if (!isMounted) {
          return;
        }

        if (seriesResponse.ok) {
          setSeries({ loading: false, items: seriesResponse.data, error: null });
        } else {
          setSeries({ loading: false, items: [], error: seriesResponse.error.message });
        }

        setReading({
          loading: false,
          recent: recentResponse.ok ? recentResponse.data : [],
          bookmarks: bookmarksResponse.ok ? bookmarksResponse.data : [],
          error: !recentResponse.ok
            ? recentResponse.error.message
            : !bookmarksResponse.ok
              ? bookmarksResponse.error.message
              : null
        });
      })
      .catch((error) => {
        if (isMounted) {
          setSeries({ loading: false, items: [], error: String(error) });
          setReading({ loading: false, recent: [], bookmarks: [], error: null });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [library.path]);

  if (library.loading) {
    return (
      <section className="empty-state">
        <h2>Checking library</h2>
        <p>Loading the current Library folder.</p>
      </section>
    );
  }

  if (!library.path) {
    return (
      <section className="empty-state">
        <h2>No library selected</h2>
        <p>{library.error ?? "Choose a Library folder in Settings."}</p>
        <button className="primary-action" onClick={onOpenSettings} type="button">
          Open Settings
        </button>
      </section>
    );
  }

  if (series.loading) {
    return (
      <section className="empty-state">
        <h2>Loading series</h2>
        <p>Reading series metadata from the Library.</p>
      </section>
    );
  }

  if (series.error) {
    return (
      <section className="empty-state">
        <h2>Could not load series</h2>
        <p>{series.error}</p>
      </section>
    );
  }

  const query = searchQuery.trim().toLowerCase();
  const filteredSeries = query
    ? series.items.filter((item) =>
        [item.title, item.author ?? "", item.status, ...item.genres].some((value) => value.toLowerCase().includes(query))
      )
    : series.items;
  const quickSections = (
    <ReadingQuickSections
      bookmarks={reading.bookmarks}
      error={reading.error}
      loading={reading.loading}
      onOpenChapter={onOpenChapter}
      recent={reading.recent}
    />
  );

  if (series.items.length === 0) {
    return (
      <>
        {quickSections}
        <section className="empty-state">
          <h2>No series yet</h2>
          <p>Library folder is ready.</p>
        </section>
      </>
    );
  }

  return (
    <>
      {quickSections}

      <label className="library-search">
        <span>Search</span>
        <input
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Title, author, status"
          type="search"
          value={searchQuery}
        />
      </label>

      {filteredSeries.length === 0 ? (
        <section className="empty-state">
          <h2>No matches</h2>
          <p>Try another title, author, or status.</p>
        </section>
      ) : (
        <section className="series-grid" aria-label="Series">
          {filteredSeries.map((item) => (
            <button className="series-card" key={item.id} onClick={() => onOpenSeries(item.id)} type="button">
              <div className="series-cover" aria-label={`${item.title} cover`}>
                {item.coverDataUrl ? (
                  <img alt="" src={item.coverDataUrl} />
                ) : (
                  <span className="series-cover-placeholder">
                    {item.title.trim().slice(0, 1).toUpperCase() || "N"}
                  </span>
                )}
              </div>
              <div className="series-card-body">
                <h2>{item.title}</h2>
                <p className="series-author">{item.author ?? "Unknown author"}</p>
                {item.genres.length > 0 ? <p className="series-genres">{item.genres.slice(0, 3).join(", ")}</p> : null}
                <span className="series-status">{formatStatus(item.status)}</span>
              </div>
            </button>
          ))}
        </section>
      )}
    </>
  );
}

function ReadingQuickSections({
  bookmarks,
  error,
  loading,
  onOpenChapter,
  recent
}: {
  bookmarks: ReadingListEntry[];
  error: string | null;
  loading: boolean;
  onOpenChapter: (target: ChapterTarget) => void;
  recent: ReadingListEntry[];
}) {
  if (loading) {
    return <p className="muted-text">Loading recent reading.</p>;
  }

  if (error) {
    return <p className="error-text">{error}</p>;
  }

  if (recent.length === 0 && bookmarks.length === 0) {
    return null;
  }

  return (
    <section className="reading-quick-sections" aria-label="Reading shortcuts">
      <RecentQuickList items={recent} onOpenChapter={onOpenChapter} />
      <ReadingQuickList
        emptyText="No bookmarks yet."
        items={bookmarks.slice(0, 5)}
        onOpenChapter={onOpenChapter}
        title="Bookmarks"
      />
    </section>
  );
}

function RecentQuickList({
  items,
  onOpenChapter
}: {
  items: ReadingListEntry[];
  onOpenChapter: (target: ChapterTarget) => void;
}) {
  const [page, setPage] = useState(0);
  const recent = items.slice(0, 6);
  const pageCount = Math.max(1, Math.ceil(recent.length / 3));
  const pageIndex = Math.min(page, pageCount - 1);
  const visibleItems = recent.slice(pageIndex * 3, pageIndex * 3 + 3);

  return (
    <section className="reading-quick-list">
      <div className="reading-quick-header">
        <h2>Recent</h2>
        {pageCount > 1 ? (
          <div className="reading-quick-pager">
            <button disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)} type="button">
              Prev
            </button>
            <span>
              {pageIndex + 1}/{pageCount}
            </span>
            <button disabled={pageIndex === pageCount - 1} onClick={() => setPage(pageIndex + 1)} type="button">
              Next
            </button>
          </div>
        ) : null}
      </div>
      {visibleItems.length === 0 ? (
        <p className="muted-text">No recent reading yet.</p>
      ) : (
        <ol>
          {visibleItems.map((item) => (
            <li key={`Recent-${item.seriesId}-${item.categoryId}-${item.volumeId ?? "direct"}-${item.chapterId}`}>
              <button className="reading-quick-link" onClick={() => onOpenChapter(targetFor(item))} type="button">
                <strong>{item.chapterTitle}</strong>
                <span>{[item.seriesTitle, item.volumeTitle].filter(Boolean).join(" / ")}</span>
                <small>{formatDate(item.updatedAt)}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ReadingQuickList({
  emptyText,
  items,
  onOpenChapter,
  title
}: {
  emptyText: string;
  items: ReadingListEntry[];
  onOpenChapter: (target: ChapterTarget) => void;
  title: string;
}) {
  return (
    <section className="reading-quick-list">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="muted-text">{emptyText}</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={`${title}-${item.seriesId}-${item.categoryId}-${item.volumeId ?? "direct"}-${item.chapterId}`}>
              <button className="reading-quick-link" onClick={() => onOpenChapter(targetFor(item))} type="button">
                <strong>{item.chapterTitle}</strong>
                <span>{[item.seriesTitle, item.volumeTitle].filter(Boolean).join(" / ")}</span>
                <small>{formatDate(item.updatedAt)}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
