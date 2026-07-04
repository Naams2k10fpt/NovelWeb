import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ChapterTarget } from "./NovelEditor";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type MangaReadingDirection = "rtl" | "ltr";
type MangaViewMode = "long-strip" | "page";
type MangaFitMode = "width" | "height";

type MangaChapterMetadata = {
  id: string;
  title: string;
  pageCount: number;
  pageOrder: string[];
  readingDirection: MangaReadingDirection;
  viewMode: MangaViewMode;
  totalSizeBytes: number;
};

type MangaPageSummary = {
  fileName: string;
  thumbnailDataUrl: string | null;
  sizeBytes: number;
};

type MangaChapterPages = {
  chapter: MangaChapterMetadata;
  pages: MangaPageSummary[];
};

type MangaPageData = {
  fileName: string;
  dataUrl: string;
  sizeBytes: number;
};

type MangaReadingProgress = {
  pageIndex: number;
  updatedAt: string | null;
};

type ChapterMetadata = {
  id: string;
  title: string;
  pageCount?: number;
};

type RendererApi = {
  chapters: {
    list: (seriesId: string, categoryId: string, volumeId?: string | null) => Promise<ApiResponse<ChapterMetadata[]>>;
  };
  manga: {
    listPages: (seriesId: string, categoryId: string, chapterId: string) => Promise<ApiResponse<MangaChapterPages>>;
    getPage: (
      seriesId: string,
      categoryId: string,
      chapterId: string,
      pageFileName: string
    ) => Promise<ApiResponse<MangaPageData>>;
    getProgress: (
      seriesId: string,
      categoryId: string,
      chapterId: string
    ) => Promise<ApiResponse<MangaReadingProgress>>;
    saveProgress: (
      seriesId: string,
      categoryId: string,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<MangaReadingProgress>>;
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

function clampPageIndex(index: number, total: number): number {
  return Math.min(Math.max(index, 0), Math.max(total - 1, 0));
}

function pageElementId(index: number): string {
  return `manga-reader-page-${index}`;
}

function imageFitStyle(fitMode: MangaFitMode, zoom: number): CSSProperties {
  return fitMode === "width"
    ? { width: `${zoom}%`, maxWidth: "none", height: "auto" }
    : { width: "auto", maxWidth: "100%", maxHeight: `${Math.max(50, zoom)}vh` };
}

function isFormControl(element: EventTarget | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement;
}

function isActuallyVisible(entry: IntersectionObserverEntry): boolean {
  return entry.boundingClientRect.top < window.innerHeight && entry.boundingClientRect.bottom > 0;
}

export default function MangaReader({
  onBack,
  onOpenChapter,
  target
}: {
  onBack: () => void;
  onOpenChapter: (target: ChapterTarget) => void;
  target: ChapterTarget;
}) {
  const [chapterList, setChapterList] = useState<ChapterMetadata[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [direction, setDirection] = useState<MangaReadingDirection>("rtl");
  const [error, setError] = useState<string | null>(null);
  const [fitMode, setFitMode] = useState<MangaFitMode>("width");
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<MangaViewMode>("long-strip");
  const [pages, setPages] = useState<MangaChapterPages | null>(null);
  const [zoom, setZoom] = useState(100);
  const currentIndexRef = useRef(0);
  const loadedRef = useRef(false);

  function saveProgress(pageIndex: number): void {
    const api = getApi();

    if (!api || !loadedRef.current) {
      return;
    }

    void api.manga.saveProgress(target.seriesId, target.categoryId, target.chapterId, { pageIndex });
  }

  function goPage(delta: number): void {
    if (!pages?.pages.length) {
      return;
    }

    const nextIndex = clampPageIndex(currentIndexRef.current + delta, pages.pages.length);
    setCurrentIndex(nextIndex);

    if (mode === "long-strip") {
      document.getElementById(pageElementId(nextIndex))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function openAdjacentChapter(delta: number): void {
    const currentChapterIndex = chapterList.findIndex((chapter) => chapter.id === target.chapterId);
    const nextChapter = currentChapterIndex >= 0 ? chapterList[currentChapterIndex + delta] : null;

    if (!nextChapter) {
      return;
    }

    onOpenChapter({
      categoryId: target.categoryId,
      categoryType: "manga",
      chapterId: nextChapter.id,
      seriesId: target.seriesId,
      seriesTitle: target.seriesTitle,
      title: nextChapter.title,
      volumeId: null
    });
  }

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    let isMounted = true;
    const api = getApi();

    if (!api) {
      setLoading(false);
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setLoading(true);
    setError(null);
    loadedRef.current = false;

    void Promise.all([
      api.manga.listPages(target.seriesId, target.categoryId, target.chapterId),
      api.manga.getProgress(target.seriesId, target.categoryId, target.chapterId),
      api.chapters.list(target.seriesId, target.categoryId, null)
    ])
      .then(([pagesResponse, progressResponse, chaptersResponse]) => {
        if (!isMounted) {
          return;
        }

        const nextPages = unwrap(pagesResponse);
        const progress = unwrap(progressResponse);
        const restoredIndex = clampPageIndex(progress.pageIndex, nextPages.pages.length);

        setPages(nextPages);
        setChapterList(unwrap(chaptersResponse));
        setMode(nextPages.chapter.viewMode);
        setDirection(nextPages.chapter.readingDirection);
        setCurrentIndex(restoredIndex);
        currentIndexRef.current = restoredIndex;
        loadedRef.current = true;
        setLoading(false);

        window.setTimeout(() => {
          if (nextPages.chapter.viewMode === "long-strip") {
            document.getElementById(pageElementId(restoredIndex))?.scrollIntoView({ block: "start" });
          }
        }, 0);
      })
      .catch((loadError) => {
        if (isMounted) {
          setLoading(false);
          setError(String(loadError));
        }
      });

    return () => {
      isMounted = false;
      saveProgress(currentIndexRef.current);
      loadedRef.current = false;
    };
  }, [target.categoryId, target.chapterId, target.seriesId]);

  useEffect(() => {
    if (!loadedRef.current || !pages) {
      return;
    }

    const progressTimer = window.setTimeout(() => saveProgress(currentIndex), 250);
    return () => window.clearTimeout(progressTimer);
  }, [currentIndex, pages, target.categoryId, target.chapterId, target.seriesId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (isFormControl(event.target)) {
        return;
      }

      const forwardKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
      const backKey = direction === "rtl" ? "ArrowRight" : "ArrowLeft";

      if (event.key === forwardKey || event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        goPage(1);
      }

      if (event.key === backKey || event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        goPage(-1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [direction, mode, pages]);

  if (loading) {
    return (
      <section className="empty-state">
        <h2>Loading manga reader</h2>
        <p>Reading manga pages.</p>
      </section>
    );
  }

  if (error || !pages) {
    return (
      <section className="empty-state">
        <h2>Could not load manga reader</h2>
        <p>{error ?? "Manga chapter is unavailable."}</p>
        <button className="primary-action" onClick={onBack} type="button">
          Back
        </button>
      </section>
    );
  }

  const chapterIndex = chapterList.findIndex((chapter) => chapter.id === target.chapterId);
  const hasPreviousChapter = chapterIndex > 0;
  const hasNextChapter = chapterIndex >= 0 && chapterIndex < chapterList.length - 1;
  const pageCount = pages.pages.length;

  return (
    <section className="manga-reader">
      <div className="reader-toolbar manga-reader-toolbar">
        <button className="plain-action" onClick={onBack} type="button">
          Back
        </button>
        <button disabled={!hasPreviousChapter} onClick={() => openAdjacentChapter(-1)} type="button">
          Previous Chapter
        </button>
        <button disabled={!hasNextChapter} onClick={() => openAdjacentChapter(1)} type="button">
          Next Chapter
        </button>
        <label>
          Mode
          <select onChange={(event) => setMode(event.target.value as MangaViewMode)} value={mode}>
            <option value="long-strip">Long strip</option>
            <option value="page">Page</option>
          </select>
        </label>
        <label>
          Direction
          <select onChange={(event) => setDirection(event.target.value as MangaReadingDirection)} value={direction}>
            <option value="rtl">RTL</option>
            <option value="ltr">LTR</option>
          </select>
        </label>
        <label>
          Fit
          <select onChange={(event) => setFitMode(event.target.value as MangaFitMode)} value={fitMode}>
            <option value="width">Width</option>
            <option value="height">Height</option>
          </select>
        </label>
        <label>
          Zoom
          <input max="160" min="50" onChange={(event) => setZoom(Number(event.target.value))} type="range" value={zoom} />
        </label>
        <button disabled={currentIndex <= 0} onClick={() => goPage(-1)} type="button">
          Previous
        </button>
        <span className="manga-reader-status">
          {pageCount === 0 ? 0 : currentIndex + 1}/{pageCount}
        </span>
        <button disabled={currentIndex >= pageCount - 1} onClick={() => goPage(1)} type="button">
          Next
        </button>
      </div>

      <header className="reader-heading manga-reader-heading">
        <span>{target.seriesTitle ?? target.title}</span>
        <p>{target.title}</p>
      </header>

      {pageCount === 0 ? (
        <section className="empty-state manga-reader-empty">
          <h2>No pages yet</h2>
          <p>Add pages in Manager before reading this chapter.</p>
        </section>
      ) : mode === "long-strip" ? (
        <ol className="manga-long-strip">
          {pages.pages.map((page, index) => (
            <MangaLazyPage
              fitMode={fitMode}
              index={index}
              key={page.fileName}
              onVisible={setCurrentIndex}
              page={page}
              target={target}
              zoom={zoom}
            />
          ))}
        </ol>
      ) : (
        <div className="manga-page-mode">
          <MangaPageImage
            fitMode={fitMode}
            page={pages.pages[currentIndex]}
            pageNumber={currentIndex + 1}
            target={target}
            zoom={zoom}
          />
        </div>
      )}
    </section>
  );
}

function MangaLazyPage({
  fitMode,
  index,
  onVisible,
  page,
  target,
  zoom
}: {
  fitMode: MangaFitMode;
  index: number;
  onVisible: (index: number) => void;
  page: MangaPageSummary;
  target: ChapterTarget;
  zoom: number;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const pageRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    setDataUrl(null);
    setError(null);
    loadedRef.current = false;
  }, [page.fileName, target.categoryId, target.chapterId, target.seriesId]);

  useEffect(() => {
    let cancelled = false;
    const element = pageRef.current;

    async function loadPage(): Promise<void> {
      const api = getApi();

      if (!api || loadedRef.current) {
        return;
      }

      loadedRef.current = true;

      try {
        const fullPage = unwrap(await api.manga.getPage(target.seriesId, target.categoryId, target.chapterId, page.fileName));
        if (!cancelled) {
          setDataUrl(fullPage.dataUrl);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(String(loadError));
        }
      }
    }

    if (!element) {
      return;
    }

    if (!("IntersectionObserver" in window)) {
      onVisible(index);
      void loadPage();
      return () => {
        cancelled = true;
      };
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (isActuallyVisible(entry)) {
            onVisible(index);
          }
          void loadPage();
        }
      },
      { rootMargin: "600px 0px" }
    );

    observer.observe(element);

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [index, onVisible, page.fileName, target.categoryId, target.chapterId, target.seriesId]);

  return (
    <li className="manga-long-strip-page" id={pageElementId(index)} ref={pageRef}>
      <span className="manga-page-number">{index + 1}</span>
      {dataUrl ? (
        <img
          alt={`Page ${index + 1}`}
          className="manga-reader-image"
          loading="lazy"
          src={dataUrl}
          style={imageFitStyle(fitMode, zoom)}
        />
      ) : (
        <div className="manga-reader-placeholder">
          {page.thumbnailDataUrl ? <img alt="" src={page.thumbnailDataUrl} /> : <span>Page {index + 1}</span>}
        </div>
      )}
      {error ? <p className="error-text">{error}</p> : null}
    </li>
  );
}

function MangaPageImage({
  fitMode,
  page,
  pageNumber,
  target,
  zoom
}: {
  fitMode: MangaFitMode;
  page: MangaPageSummary;
  pageNumber: number;
  target: ChapterTarget;
  zoom: number;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = getApi();

    setDataUrl(null);
    setError(null);

    if (!api) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    void api.manga
      .getPage(target.seriesId, target.categoryId, target.chapterId, page.fileName)
      .then((response) => {
        if (!cancelled) {
          setDataUrl(unwrap(response).dataUrl);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(String(loadError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [page.fileName, target.categoryId, target.chapterId, target.seriesId]);

  return (
    <div className="manga-page-stage">
      {dataUrl ? (
        <img
          alt={`Page ${pageNumber}`}
          className="manga-reader-image"
          src={dataUrl}
          style={imageFitStyle(fitMode, zoom)}
        />
      ) : (
        <div className="manga-reader-placeholder">
          {page.thumbnailDataUrl ? <img alt="" src={page.thumbnailDataUrl} /> : <span>Page {pageNumber}</span>}
        </div>
      )}
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}
