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

type HighlightColor = "yellow" | "green" | "pink" | "blue";

type HighlightEntry = ReadingListEntry & {
  id: string;
  text: string;
  color: HighlightColor;
  note: string;
  createdAt: string;
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
  highlights?: {
    list: () => Promise<ApiResponse<HighlightEntry[]>>;
    delete: (seriesId: string, highlightId: string) => Promise<ApiResponse<{ id: string }>>;
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
  highlights: HighlightEntry[];
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
    highlights: [],
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
      setReading({ loading: false, recent: [], bookmarks: [], highlights: [], error: null });
      return;
    }

    const api = getApi();
    if (!api) {
      setSeries({
        loading: false,
        items: [],
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      setReading({ loading: false, recent: [], bookmarks: [], highlights: [], error: null });
      return;
    }

    setSeries({ loading: true, items: [], error: null });
    setReading({ loading: true, recent: [], bookmarks: [], highlights: [], error: null });

    void Promise.all([
      api.series.list(),
      api.reading?.listRecent() ?? Promise.resolve({ ok: true, data: [] } as ApiResponse<ReadingListEntry[]>),
      api.bookmarks?.list() ?? Promise.resolve({ ok: true, data: [] } as ApiResponse<ReadingListEntry[]>),
      api.highlights?.list() ?? Promise.resolve({ ok: true, data: [] } as ApiResponse<HighlightEntry[]>)
    ])
      .then(([seriesResponse, recentResponse, bookmarksResponse, highlightsResponse]) => {
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
          highlights: highlightsResponse.ok ? highlightsResponse.data : [],
          error: !recentResponse.ok
            ? recentResponse.error.message
            : !bookmarksResponse.ok
              ? bookmarksResponse.error.message
              : !highlightsResponse.ok
                ? highlightsResponse.error.message
              : null
        });
      })
      .catch((error) => {
        if (isMounted) {
          setSeries({ loading: false, items: [], error: String(error) });
          setReading({ loading: false, recent: [], bookmarks: [], highlights: [], error: null });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [library.path]);

  async function deleteHighlight(item: HighlightEntry): Promise<void> {
    const api = getApi();

    if (!api?.highlights) {
      setReading((current) => ({ ...current, error: "Highlight API is unavailable. Restart the app or check the preload script." }));
      return;
    }

    const response = await api.highlights.delete(item.seriesId, item.id);

    if (!response.ok) {
      setReading((current) => ({ ...current, error: response.error.message }));
      return;
    }

    setReading((current) => ({
      ...current,
      highlights: current.highlights.filter((highlight) => highlight.id !== item.id),
      error: null
    }));
  }

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
        [item.title, item.author ?? "", item.status].some((value) => value.toLowerCase().includes(query))
      )
    : series.items;
  const quickSections = (
    <ReadingQuickSections
      bookmarks={reading.bookmarks}
      error={reading.error}
      highlights={reading.highlights}
      loading={reading.loading}
      onDeleteHighlight={(item) => void deleteHighlight(item)}
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
  highlights,
  loading,
  onDeleteHighlight,
  onOpenChapter,
  recent
}: {
  bookmarks: ReadingListEntry[];
  error: string | null;
  highlights: HighlightEntry[];
  loading: boolean;
  onDeleteHighlight: (item: HighlightEntry) => void;
  onOpenChapter: (target: ChapterTarget) => void;
  recent: ReadingListEntry[];
}) {
  if (loading) {
    return <p className="muted-text">Loading recent reading.</p>;
  }

  if (error) {
    return <p className="error-text">{error}</p>;
  }

  if (recent.length === 0 && bookmarks.length === 0 && highlights.length === 0) {
    return null;
  }

  return (
    <section className="reading-quick-sections" aria-label="Reading shortcuts">
      <ReadingQuickList
        emptyText="No recent reading yet."
        items={recent.slice(0, 5)}
        onOpenChapter={onOpenChapter}
        title="Recent"
      />
      <ReadingQuickList
        emptyText="No bookmarks yet."
        items={bookmarks.slice(0, 5)}
        onOpenChapter={onOpenChapter}
        title="Bookmarks"
      />
      <HighlightQuickList
        items={highlights.slice(0, 5)}
        onDeleteHighlight={onDeleteHighlight}
        onOpenChapter={onOpenChapter}
      />
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

function HighlightQuickList({
  items,
  onDeleteHighlight,
  onOpenChapter
}: {
  items: HighlightEntry[];
  onDeleteHighlight: (item: HighlightEntry) => void;
  onOpenChapter: (target: ChapterTarget) => void;
}) {
  return (
    <section className="reading-quick-list">
      <h2>Highlights</h2>
      {items.length === 0 ? (
        <p className="muted-text">No highlights yet.</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li className="reading-highlight-item" key={`highlight-${item.id}`}>
              <button className="reading-quick-link" onClick={() => onOpenChapter(targetFor(item))} type="button">
                <strong>{item.chapterTitle}</strong>
                <span>{[item.seriesTitle, item.volumeTitle].filter(Boolean).join(" / ")}</span>
                <small>{item.text}</small>
                {item.note ? <small>Note: {item.note}</small> : null}
                <small>{formatDate(item.updatedAt)}</small>
              </button>
              <button className="reading-quick-delete" onClick={() => onDeleteHighlight(item)} type="button">
                Delete
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
