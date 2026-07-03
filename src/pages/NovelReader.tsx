import { useEffect, useRef, useState } from "react";
import type { ChapterTarget } from "./NovelEditor";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type ChapterContent = {
  html: string;
};

type ChapterReadingProgress = {
  scrollTop: number;
  updatedAt: string | null;
};

type BookmarkEntry = {
  scrollTop: number;
  updatedAt: string;
};

type HighlightColor = "yellow" | "green" | "pink" | "blue";

type HighlightEntry = {
  id: string;
  text: string;
  color: HighlightColor;
  note: string;
  scrollTop: number;
  createdAt: string;
  updatedAt: string;
};

type ReaderTheme = "light" | "dark";

type RendererApi = {
  chapters: {
    getContent: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<ChapterContent>>;
    getProgress: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<ChapterReadingProgress>>;
    saveProgress: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<ChapterReadingProgress>>;
  };
  bookmarks?: {
    get: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<BookmarkEntry | null>>;
    toggle: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<BookmarkEntry | null>>;
  };
  highlights?: {
    listForChapter: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<HighlightEntry[]>>;
    create: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<HighlightEntry>>;
    delete: (seriesId: string, highlightId: string) => Promise<ApiResponse<{ id: string }>>;
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

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export default function NovelReader({
  onBack,
  onEdit,
  target
}: {
  onBack: () => void;
  onEdit: () => void;
  target: ChapterTarget;
}) {
  const [error, setError] = useState<string | null>(null);
  const [bookmark, setBookmark] = useState<BookmarkEntry | null>(null);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [bookmarkSaving, setBookmarkSaving] = useState(false);
  const [highlightColor, setHighlightColor] = useState<HighlightColor>("yellow");
  const [highlightError, setHighlightError] = useState<string | null>(null);
  const [highlightNote, setHighlightNote] = useState("");
  const [highlightSaving, setHighlightSaving] = useState(false);
  const [highlights, setHighlights] = useState<HighlightEntry[]>([]);
  const [fontSize, setFontSize] = useState(18);
  const [html, setHtml] = useState("");
  const [readingWidth, setReadingWidth] = useState(760);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function saveProgress(): void {
    const api = getApi();

    if (!api || !loadedRef.current) {
      return;
    }

    void api.chapters.saveProgress(target.seriesId, target.categoryId, target.volumeId, target.chapterId, {
      scrollTop: window.scrollY
    });
  }

  useEffect(() => {
    let isMounted = true;
    const api = getApi();

    if (!api) {
      setLoading(false);
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setLoading(true);
    loadedRef.current = false;
    setError(null);
    setHighlightError(null);
    setHighlights([]);

    void Promise.all([
      api.chapters.getContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId),
      api.chapters.getProgress(target.seriesId, target.categoryId, target.volumeId, target.chapterId),
      api.bookmarks?.get(target.seriesId, target.categoryId, target.volumeId, target.chapterId) ??
        Promise.resolve({ ok: true, data: null } as ApiResponse<BookmarkEntry | null>),
      api.highlights?.listForChapter(target.seriesId, target.categoryId, target.volumeId, target.chapterId) ??
        Promise.resolve({ ok: true, data: [] } as ApiResponse<HighlightEntry[]>)
    ])
      .then(([contentResponse, progressResponse, bookmarkResponse, highlightsResponse]) => {
        if (!isMounted) {
          return;
        }

        setHtml(unwrap(contentResponse).html || "<p>No content yet.</p>");
        setBookmark(unwrap(bookmarkResponse));
        setHighlights(unwrap(highlightsResponse));
        loadedRef.current = true;
        setLoading(false);
        window.setTimeout(() => window.scrollTo({ top: target.scrollTop ?? unwrap(progressResponse).scrollTop }), 0);
      })
      .catch((loadError) => {
        if (isMounted) {
          setLoading(false);
          setError(String(loadError));
        }
      });

    return () => {
      isMounted = false;
      saveProgress();
      loadedRef.current = false;
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
      }
    };
  }, [target.categoryId, target.chapterId, target.scrollTop, target.seriesId, target.volumeId]);

  useEffect(() => {
    function handleScroll(): void {
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
      }

      progressTimerRef.current = setTimeout(saveProgress, 500);
    }

    window.addEventListener("scroll", handleScroll);

    return () => window.removeEventListener("scroll", handleScroll);
  });

  async function toggleBookmark(): Promise<void> {
    const api = getApi();

    if (!api?.bookmarks || !loadedRef.current) {
      setBookmarkError("Bookmark API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setBookmarkError(null);
    setBookmarkSaving(true);

    try {
      setBookmark(
        unwrap(
          await api.bookmarks.toggle(target.seriesId, target.categoryId, target.volumeId, target.chapterId, {
            scrollTop: window.scrollY
          })
        )
      );
    } catch (toggleError) {
      setBookmarkError(String(toggleError));
    } finally {
      setBookmarkSaving(false);
    }
  }

  function selectedReaderText(): string {
    const selection = window.getSelection();
    const readerContent = document.querySelector(".reader-content");

    if (!selection || selection.isCollapsed || !readerContent || !selection.anchorNode || !selection.focusNode) {
      return "";
    }

    if (!readerContent.contains(selection.anchorNode) || !readerContent.contains(selection.focusNode)) {
      return "";
    }

    return selection.toString().replace(/\s+/g, " ").trim();
  }

  async function createHighlight(): Promise<void> {
    const api = getApi();

    if (!api?.highlights || !loadedRef.current) {
      setHighlightError("Highlight API is unavailable. Restart the app or check the preload script.");
      return;
    }

    const text = selectedReaderText();
    if (!text) {
      setHighlightError("Select text in the chapter first.");
      return;
    }

    setHighlightError(null);
    setHighlightSaving(true);

    try {
      const created = unwrap(
        await api.highlights.create(target.seriesId, target.categoryId, target.volumeId, target.chapterId, {
          text,
          color: highlightColor,
          note: highlightNote,
          scrollTop: window.scrollY
        })
      );
      setHighlights((current) => [created, ...current]);
      setHighlightNote("");
      window.getSelection()?.removeAllRanges();
    } catch (createError) {
      setHighlightError(String(createError));
    } finally {
      setHighlightSaving(false);
    }
  }

  async function deleteHighlight(highlightId: string): Promise<void> {
    const api = getApi();

    if (!api?.highlights) {
      setHighlightError("Highlight API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setHighlightError(null);

    try {
      unwrap(await api.highlights.delete(target.seriesId, highlightId));
      setHighlights((current) => current.filter((item) => item.id !== highlightId));
    } catch (deleteError) {
      setHighlightError(String(deleteError));
    }
  }

  if (loading) {
    return (
      <section className="empty-state">
        <h2>Loading reader</h2>
        <p>Reading chapter content.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="empty-state">
        <h2>Could not load reader</h2>
        <p>{error}</p>
        <button className="primary-action" onClick={onBack} type="button">
          Back
        </button>
      </section>
    );
  }

  return (
    <section className={`novel-reader novel-reader-${theme}`}>
      <div className="reader-toolbar">
        <button className="plain-action" onClick={onBack} type="button">
          Back
        </button>
        <button className="plain-action" onClick={onEdit} type="button">
          Edit
        </button>
        <label>
          Font
          <input max="24" min="14" onChange={(event) => setFontSize(Number(event.target.value))} type="range" value={fontSize} />
        </label>
        <label>
          Width
          <input
            max="980"
            min="560"
            onChange={(event) => setReadingWidth(Number(event.target.value))}
            step="20"
            type="range"
            value={readingWidth}
          />
        </label>
        <button onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))} type="button">
          {theme === "light" ? "Dark" : "Light"}
        </button>
        <button disabled={bookmarkSaving} onClick={() => void toggleBookmark()} type="button">
          {bookmark ? "Bookmarked" : "Bookmark"}
        </button>
      </div>

      <header className="reader-heading" style={{ maxWidth: readingWidth }}>
        <span>{target.seriesTitle ?? target.title}</span>
      </header>

      <div className="highlight-toolbar" aria-label="Highlight tools">
        <label>
          Color
          <select onChange={(event) => setHighlightColor(event.target.value as HighlightColor)} value={highlightColor}>
            <option value="yellow">Yellow</option>
            <option value="green">Green</option>
            <option value="pink">Pink</option>
            <option value="blue">Blue</option>
          </select>
        </label>
        <input
          onChange={(event) => setHighlightNote(event.target.value)}
          placeholder="Note"
          type="text"
          value={highlightNote}
        />
        <button disabled={highlightSaving} onClick={() => void createHighlight()} type="button">
          {highlightSaving ? "Saving" : "Highlight selection"}
        </button>
      </div>

      {bookmarkError ? <p className="error-text">{bookmarkError}</p> : null}
      {highlightError ? <p className="error-text">{highlightError}</p> : null}

      {highlights.length > 0 ? (
        <section className="chapter-highlights" aria-label="Chapter highlights">
          <h3>Highlights</h3>
          <ol>
            {highlights.map((item) => (
              <li key={item.id}>
                <span className={`highlight-dot highlight-dot-${item.color}`} aria-hidden="true" />
                <div>
                  <blockquote>{item.text}</blockquote>
                  {item.note ? <p>{item.note}</p> : null}
                  <small>{formatDate(item.updatedAt)}</small>
                </div>
                <button onClick={() => void deleteHighlight(item.id)} type="button">
                  Delete
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <article className="reader-page" style={{ maxWidth: readingWidth }}>
        <div
          className="reader-content"
          dangerouslySetInnerHTML={{ __html: html }}
          style={{ fontSize }}
        />
      </article>
    </section>
  );
}
