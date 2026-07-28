import { useState } from "react";
import type { ChapterTarget } from "./NovelEditor";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type LibraryState = {
  loading: boolean;
  path: string | null;
  error: string | null;
};

type SearchResult = {
  seriesId: string;
  seriesTitle: string;
  seriesStatus: string;
  categoryId: string;
  categoryTitle: string;
  volumeId: string | null;
  volumeTitle: string | null;
  chapterId: string;
  chapterTitle: string;
  tags: string[];
  snippet: string;
  updatedAt: string;
};

type SearchIndexSummary = {
  documentCount: number;
  generatedAt: string;
};

type RendererApi = {
  search?: {
    query: (query: string) => Promise<ApiResponse<SearchResult[]>>;
    rebuild: () => Promise<ApiResponse<SearchIndexSummary>>;
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

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/gi, (letter) => (letter === "Đ" ? "D" : "d"))
    .toLowerCase();
}

function highlightedParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = normalizeSearchText(query.trim());
  const haystack = normalizeSearchText(text);
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  if (!needle) {
    return [{ text, match: false }];
  }

  while (cursor < text.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }

    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), match: false });
    }

    parts.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }

  return parts;
}

function resultTarget(result: SearchResult, searchText: string): ChapterTarget {
  return {
    seriesId: result.seriesId,
    categoryId: result.categoryId,
    volumeId: result.volumeId,
    chapterId: result.chapterId,
    seriesTitle: result.seriesTitle,
    searchText,
    title: result.chapterTitle
  };
}

export default function Search({
  library,
  onOpenChapter,
  onOpenSettings
}: {
  library: LibraryState;
  onOpenChapter: (target: ChapterTarget) => void;
  onOpenSettings: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [indexSummary, setIndexSummary] = useState<SearchIndexSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [seriesFilter, setSeriesFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const filteredResults = results.filter(
    (result) =>
      (!seriesFilter || result.seriesId === seriesFilter) &&
      (!categoryFilter || result.categoryId === categoryFilter) &&
      (!tagFilter || result.tags.includes(tagFilter)) &&
      (!statusFilter || result.seriesStatus === statusFilter)
  );
  const seriesOptions = [...new Map(results.map((result) => [result.seriesId, result.seriesTitle])).entries()];
  const categoryOptions = [...new Map(results.map((result) => [result.categoryId, result.categoryTitle])).entries()];
  const tagOptions = [...new Set(results.flatMap((result) => result.tags))].sort();
  const statusOptions = [...new Set(results.map((result) => result.seriesStatus))].sort();

  async function runSearch(): Promise<void> {
    const api = getApi();
    const nextQuery = query.trim();

    if (!api?.search) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setError(null);
    setLoading(true);
    setSearched(true);

    try {
      setResults(nextQuery ? unwrap(await api.search.query(nextQuery)) : []);
    } catch (searchError) {
      setResults([]);
      setError(String(searchError));
    } finally {
      setLoading(false);
    }
  }

  async function rebuildIndex(): Promise<void> {
    const api = getApi();

    if (!api?.search) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const summary = unwrap(await api.search.rebuild());
      setIndexSummary(summary);
      if (query.trim()) {
        setResults(unwrap(await api.search.query(query.trim())));
        setSearched(true);
      }
    } catch (rebuildError) {
      setError(String(rebuildError));
    } finally {
      setLoading(false);
    }
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

  return (
    <section className="search-page">
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <label>
          <span>Keyword</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chapter text"
            type="search"
            value={query}
          />
        </label>

        <div className="search-actions">
          <button className="primary-action" disabled={loading} type="submit">
            {loading ? "Searching" : "Search"}
          </button>
          <button disabled={loading} onClick={() => void rebuildIndex()} type="button">
            Rebuild index
          </button>
        </div>

        {results.length > 0 ? (
          <div className="search-filters">
            <label>
              <span>Series</span>
              <select onChange={(event) => setSeriesFilter(event.target.value)} value={seriesFilter}>
                <option value="">All series</option>
                {seriesOptions.map(([id, title]) => (
                  <option key={id} value={id}>{title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Category</span>
              <select onChange={(event) => setCategoryFilter(event.target.value)} value={categoryFilter}>
                <option value="">All categories</option>
                {categoryOptions.map(([id, title]) => (
                  <option key={id} value={id}>{title}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Tag</span>
              <select onChange={(event) => setTagFilter(event.target.value)} value={tagFilter}>
                <option value="">All tags</option>
                {tagOptions.map((tag) => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                <option value="">All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </form>

      {indexSummary ? (
        <p className="muted-text">
          Indexed {indexSummary.documentCount} chapters at {new Date(indexSummary.generatedAt).toLocaleString()}.
        </p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}

      {searched && !loading && filteredResults.length === 0 ? (
        <section className="empty-state">
          <h2>No matches</h2>
          <p>Try another keyword, clear a filter, or rebuild the index.</p>
        </section>
      ) : null}

      {filteredResults.length > 0 ? (
        <ol className="search-results">
          {filteredResults.map((result) => (
            <li key={`${result.seriesId}-${result.categoryId}-${result.volumeId ?? "direct"}-${result.chapterId}`}>
              <button
                className="search-result-card"
                onClick={() => onOpenChapter(resultTarget(result, query.trim()))}
                type="button"
              >
                <span className="search-result-path">
                  {[result.seriesTitle, result.categoryTitle, result.volumeTitle].filter(Boolean).join(" / ")}
                </span>
                <strong>{result.chapterTitle}</strong>
                <span className="search-result-snippet">
                  {highlightedParts(result.snippet, query).map((part, index) =>
                    part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
