import { useEffect, useState } from "react";

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
  onOpenSeries: (seriesId: string) => void;
};

type SeriesCard = {
  id: string;
  title: string;
  author: string | null;
  status: string;
  coverDataUrl: string | null;
};

type RendererApi = {
  series: {
    list: () => Promise<ApiResponse<SeriesCard[]>>;
  };
};

type SeriesState = {
  loading: boolean;
  items: SeriesCard[];
  error: string | null;
};

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

function formatStatus(status: string): string {
  return status.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export default function Library({ library, onOpenSettings, onOpenSeries }: LibraryPageProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [series, setSeries] = useState<SeriesState>({
    loading: false,
    items: [],
    error: null
  });

  useEffect(() => {
    let isMounted = true;

    if (!library.path) {
      setSeries({ loading: false, items: [], error: null });
      return;
    }

    const api = getApi();
    if (!api) {
      setSeries({
        loading: false,
        items: [],
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      return;
    }

    setSeries({ loading: true, items: [], error: null });

    void api.series
      .list()
      .then((response) => {
        if (!isMounted) {
          return;
        }

        if (response.ok) {
          setSeries({ loading: false, items: response.data, error: null });
        } else {
          setSeries({ loading: false, items: [], error: response.error.message });
        }
      })
      .catch((error) => {
        if (isMounted) {
          setSeries({ loading: false, items: [], error: String(error) });
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
        [item.title, item.author ?? "", item.status].some((value) => value.toLowerCase().includes(query))
      )
    : series.items;

  if (series.items.length === 0) {
    return (
      <section className="empty-state">
        <h2>No series yet</h2>
        <p>Library folder is ready.</p>
      </section>
    );
  }

  return (
    <>
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
