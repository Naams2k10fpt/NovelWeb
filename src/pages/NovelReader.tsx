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

    void Promise.all([
      api.chapters.getContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId),
      api.chapters.getProgress(target.seriesId, target.categoryId, target.volumeId, target.chapterId)
    ])
      .then(([contentResponse, progressResponse]) => {
        if (!isMounted) {
          return;
        }

        setHtml(unwrap(contentResponse).html || "<p>No content yet.</p>");
        loadedRef.current = true;
        setLoading(false);
        window.setTimeout(() => window.scrollTo({ top: unwrap(progressResponse).scrollTop }), 0);
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
  }, [target.categoryId, target.chapterId, target.seriesId, target.volumeId]);

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
      </div>

      <article className="reader-page" style={{ maxWidth: readingWidth }}>
        <h2>{target.title}</h2>
        <div
          className="reader-content"
          dangerouslySetInnerHTML={{ __html: html }}
          style={{ fontSize }}
        />
      </article>
    </section>
  );
}
