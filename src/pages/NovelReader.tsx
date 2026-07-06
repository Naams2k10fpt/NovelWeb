import { useEffect, useRef, useState } from "react";
import type { ChapterTarget } from "./NovelEditor";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type ChapterContent = {
  html: string;
};

type ChapterMetadata = {
  id: string;
  title: string;
  translationStatus?: string;
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
  textStart?: number;
  textEnd?: number;
  color: HighlightColor;
  note: string;
  scrollTop: number;
  createdAt: string;
  updatedAt: string;
};

type ReaderTheme = "light" | "dark";

type PendingMarker = {
  left: number;
  scrollTop: number;
  text: string;
  textStart: number;
  textEnd: number;
  top: number;
};

type RendererApi = {
  chapters: {
    list: (seriesId: string, categoryId: string, volumeId?: string | null) => Promise<ApiResponse<ChapterMetadata[]>>;
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

function normalizedMarkerText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function unwrapReaderSearchHit(hit: Element): void {
  const parent = hit.parentNode;

  if (!parent) {
    return;
  }

  while (hit.firstChild) {
    parent.insertBefore(hit.firstChild, hit);
  }

  parent.removeChild(hit);
  parent.normalize();
}

function unwrapReaderSearchHits(root: Element): void {
  for (const hit of Array.from(root.querySelectorAll("mark.reader-search-hit"))) {
    unwrapReaderSearchHit(hit);
  }

  root.normalize();
}

function unwrapReaderEditMarker(marker: Element): void {
  const parent = marker.parentNode;

  if (!parent) {
    return;
  }

  while (marker.firstChild) {
    parent.insertBefore(marker.firstChild, marker);
  }

  parent.removeChild(marker);
  parent.normalize();
}

function unwrapReaderEditMarkers(root: Element): void {
  for (const marker of Array.from(root.querySelectorAll("mark.reader-edit-marker"))) {
    unwrapReaderEditMarker(marker);
  }

  root.normalize();
}

function textPosition(root: Element, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();

  while (node) {
    const text = node.textContent ?? "";

    if (remaining <= text.length) {
      return { node: node as Text, offset: remaining };
    }

    remaining -= text.length;
    node = walker.nextNode();
  }

  return null;
}

function textRangeByOffsets(
  root: Element,
  startOffset: number | undefined,
  endOffset: number | undefined,
  expectedText: string
): { start: { node: Text; offset: number }; end: { node: Text; offset: number } } | null {
  const text = root.textContent ?? "";

  if (
    startOffset === undefined ||
    endOffset === undefined ||
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > text.length
  ) {
    return null;
  }

  if (normalizedMarkerText(text.slice(startOffset, endOffset)) !== normalizedMarkerText(expectedText)) {
    return null;
  }

  const start = textPosition(root, startOffset);
  const end = textPosition(root, endOffset);

  return start && end ? { start, end } : null;
}

function textRangeBySearch(
  root: Element,
  searchText: string
): { start: { node: Text; offset: number }; end: { node: Text; offset: number } } | null {
  const needle = searchText.trim().toLowerCase();

  if (!needle) {
    return null;
  }

  const index = (root.textContent ?? "").toLowerCase().indexOf(needle);
  if (index === -1) {
    return null;
  }

  const start = textPosition(root, index);
  const end = textPosition(root, index + needle.length);

  return start && end ? { start, end } : null;
}

function highlightSearchMatch(searchText: string): boolean {
  const root = document.querySelector(".reader-content");
  const needle = searchText.trim().toLowerCase();

  if (!root || !needle) {
    return false;
  }

  unwrapReaderSearchHits(root);

  const index = (root.textContent ?? "").toLowerCase().indexOf(needle);
  if (index === -1) {
    return false;
  }

  const start = textPosition(root, index);
  const end = textPosition(root, index + needle.length);

  if (!start || !end) {
    return false;
  }

  const range = document.createRange();
  const mark = document.createElement("mark");

  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  mark.className = "reader-search-hit reader-search-hit-active";
  mark.append(range.extractContents());
  range.insertNode(mark);
  mark.scrollIntoView({ block: "center", behavior: "smooth" });
  window.setTimeout(() => {
    mark.classList.remove("reader-search-hit-active");
    mark.classList.add("reader-search-hit-fading");
    window.setTimeout(() => unwrapReaderSearchHit(mark), 450);
  }, 4200);

  return true;
}

function markReaderText(root: Element, highlight: HighlightEntry): void {
  const textRange =
    textRangeByOffsets(root, highlight.textStart, highlight.textEnd, highlight.text) ??
    textRangeBySearch(root, highlight.text);

  if (!textRange) {
    return;
  }

  const range = document.createRange();
  const mark = document.createElement("mark");

  range.setStart(textRange.start.node, textRange.start.offset);
  range.setEnd(textRange.end.node, textRange.end.offset);
  mark.className = "reader-edit-marker";
  mark.setAttribute("data-note", highlight.note || "Needs edit");
  mark.append(range.extractContents());
  range.insertNode(mark);
}

function applyReaderEditMarkers(highlights: HighlightEntry[]): void {
  const root = document.querySelector(".reader-content");

  if (!root) {
    return;
  }

  unwrapReaderEditMarkers(root);
  for (const highlight of highlights) {
    markReaderText(root, highlight);
  }
}

export default function NovelReader({
  onBack,
  onBackToSeries,
  onEdit,
  onOpenChapter,
  target
}: {
  onBack: () => void;
  onBackToSeries: () => void;
  onEdit: (target?: ChapterTarget) => void;
  onOpenChapter: (target: ChapterTarget) => void;
  target: ChapterTarget;
}) {
  const [chapterList, setChapterList] = useState<ChapterMetadata[]>([]);
  const [chapterListOpen, setChapterListOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookmark, setBookmark] = useState<BookmarkEntry | null>(null);
  const [bookmarkError, setBookmarkError] = useState<string | null>(null);
  const [bookmarkSaving, setBookmarkSaving] = useState(false);
  const [highlightError, setHighlightError] = useState<string | null>(null);
  const [highlightSaving, setHighlightSaving] = useState(false);
  const [highlights, setHighlights] = useState<HighlightEntry[]>([]);
  const [pendingMarker, setPendingMarker] = useState<PendingMarker | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [fontSize, setFontSize] = useState(18);
  const [html, setHtml] = useState("");
  const [readingWidth, setReadingWidth] = useState(760);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);
  const pendingScrollTopRef = useRef(0);
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
    setChapterList([]);
    setChapterListOpen(false);
    setHighlights([]);
    setPendingMarker(null);
    setPendingNote("");

    void Promise.all([
      api.chapters.list(target.seriesId, target.categoryId, target.volumeId),
      api.chapters.getContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId),
      api.chapters.getProgress(target.seriesId, target.categoryId, target.volumeId, target.chapterId),
      api.bookmarks?.get(target.seriesId, target.categoryId, target.volumeId, target.chapterId) ??
        Promise.resolve({ ok: true, data: null } as ApiResponse<BookmarkEntry | null>),
      api.highlights?.listForChapter(target.seriesId, target.categoryId, target.volumeId, target.chapterId) ??
        Promise.resolve({ ok: true, data: [] } as ApiResponse<HighlightEntry[]>)
    ])
      .then(([chaptersResponse, contentResponse, progressResponse, bookmarkResponse, highlightsResponse]) => {
        if (!isMounted) {
          return;
        }

        setChapterList(unwrap(chaptersResponse));
        setHtml(unwrap(contentResponse).html || "<p>No content yet.</p>");
        setBookmark(unwrap(bookmarkResponse));
        setHighlights(unwrap(highlightsResponse));
        pendingScrollTopRef.current = target.scrollTop ?? unwrap(progressResponse).scrollTop;
        loadedRef.current = true;
        setLoading(false);
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
  }, [target.categoryId, target.chapterId, target.scrollTop, target.searchText, target.seriesId, target.volumeId]);

  useEffect(() => {
    if (loading || !html) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const didHighlightSearchMatch = target.searchText ? highlightSearchMatch(target.searchText) : false;

      if (!didHighlightSearchMatch) {
        window.scrollTo({ top: pendingScrollTopRef.current });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [html, loading, target.categoryId, target.chapterId, target.searchText, target.seriesId, target.volumeId]);

  useEffect(() => {
    if (loading || !html) {
      return;
    }

    const frame = window.requestAnimationFrame(() => applyReaderEditMarkers(highlights));
    return () => window.cancelAnimationFrame(frame);
  }, [highlights, html, loading]);

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

  function selectedMarkerTarget(): PendingMarker | null {
    const selection = window.getSelection();
    const readerContent = document.querySelector(".reader-content");

    if (!selection || selection.isCollapsed || !readerContent || !selection.anchorNode || !selection.focusNode) {
      return null;
    }

    if (!readerContent.contains(selection.anchorNode) || !readerContent.contains(selection.focusNode)) {
      return null;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const rawText = range?.toString() ?? "";
    const text = rawText.trim();
    const firstRect = range ? Array.from(range.getClientRects()).find((rect) => rect.width || rect.height) : null;
    const rect = firstRect ?? range?.getBoundingClientRect();

    if (!range || !text || !rect) {
      return null;
    }

    const prefixRange = document.createRange();
    const leadingTrim = rawText.length - rawText.trimStart().length;

    prefixRange.selectNodeContents(readerContent);
    prefixRange.setEnd(range.startContainer, range.startOffset);

    const textStart = prefixRange.toString().length + leadingTrim;
    const textEnd = textStart + text.length;

    return {
      left: Math.max(12, Math.min(window.innerWidth - 320, rect.left)),
      scrollTop: window.scrollY,
      text,
      textStart,
      textEnd,
      top: Math.max(12, Math.min(window.innerHeight - 180, rect.bottom + 8))
    };
  }

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

  function openMarkerComposer(): void {
    const marker = selectedMarkerTarget();

    if (!marker) {
      setHighlightError("Select text in the chapter first.");
      return;
    }

    setHighlightError(null);
    setPendingMarker(marker);
    setPendingNote("");
  }

  async function createEditMarker(): Promise<void> {
    const api = getApi();

    if (!api?.highlights || !loadedRef.current || !pendingMarker) {
      setHighlightError("Highlight API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setHighlightError(null);
    setHighlightSaving(true);

    try {
      const created = unwrap(
        await api.highlights.create(target.seriesId, target.categoryId, target.volumeId, target.chapterId, {
          text: pendingMarker.text,
          textStart: pendingMarker.textStart,
          textEnd: pendingMarker.textEnd,
          color: "yellow",
          note: pendingNote,
          scrollTop: pendingMarker.scrollTop
        })
      );
      setHighlights((current) => [created, ...current]);
      setPendingMarker(null);
      setPendingNote("");
      window.getSelection()?.removeAllRanges();
    } catch (createError) {
      setHighlightError(String(createError));
    } finally {
      setHighlightSaving(false);
    }
  }

  function chapterTarget(chapter: ChapterMetadata): ChapterTarget {
    return {
      categoryId: target.categoryId,
      categoryType: target.categoryType,
      chapterId: chapter.id,
      seriesId: target.seriesId,
      seriesTitle: target.seriesTitle,
      title: chapter.title,
      volumeId: target.volumeId
    };
  }

  function openReaderChapter(chapter: ChapterMetadata): void {
    setChapterListOpen(false);
    onOpenChapter(chapterTarget(chapter));
  }

  function openAdjacentChapter(delta: number): void {
    const currentIndex = chapterList.findIndex((chapter) => chapter.id === target.chapterId);
    const chapter = currentIndex >= 0 ? chapterList[currentIndex + delta] : null;

    if (chapter) {
      openReaderChapter(chapter);
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

  const currentChapterIndex = chapterList.findIndex((chapter) => chapter.id === target.chapterId);
  const hasPreviousChapter = currentChapterIndex > 0;
  const hasNextChapter = currentChapterIndex >= 0 && currentChapterIndex < chapterList.length - 1;

  return (
    <section className={`novel-reader novel-reader-${theme}`}>
      <div className="reader-side-toolbar" aria-label="Reader toolbar">
        <button
          aria-label="Previous chapter"
          disabled={!hasPreviousChapter}
          onClick={() => openAdjacentChapter(-1)}
          title="Previous chapter"
          type="button"
        >
          {"<<"}
        </button>
        <button aria-label="Back to chapter list" onClick={onBackToSeries} title="Back to chapter list" type="button">
          Home
        </button>
        <button
          aria-label="Open chapter list"
          aria-pressed={chapterListOpen}
          onClick={() => setChapterListOpen((current) => !current)}
          title="Chapter list"
          type="button"
        >
          List
        </button>
        <button
          aria-label="Highlight selected text"
          disabled={highlightSaving}
          onClick={openMarkerComposer}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          title="Highlight selected text"
          type="button"
        >
          Mark
        </button>
        <button
          aria-label={bookmark ? "Remove bookmark" : "Bookmark"}
          disabled={bookmarkSaving}
          onClick={() => void toggleBookmark()}
          title={bookmark ? "Remove bookmark" : "Bookmark"}
          type="button"
        >
          {bookmark ? "Saved" : "Book"}
        </button>
        <button
          aria-label="Next chapter"
          disabled={!hasNextChapter}
          onClick={() => openAdjacentChapter(1)}
          title="Next chapter"
          type="button"
        >
          {">>"}
        </button>
      </div>

      {pendingMarker ? (
        <form
          className="reader-note-popover"
          onSubmit={(event) => {
            event.preventDefault();
            void createEditMarker();
          }}
          style={{ left: pendingMarker.left, top: pendingMarker.top }}
        >
          <label>
            <span>Note</span>
            <textarea
              autoFocus
              onChange={(event) => setPendingNote(event.target.value)}
              placeholder="What needs fixing?"
              rows={3}
              value={pendingNote}
            />
          </label>
          <div>
            <button disabled={highlightSaving} type="submit">
              {highlightSaving ? "Saving" : "Save"}
            </button>
            <button
              disabled={highlightSaving}
              onClick={() => {
                setPendingMarker(null);
                setPendingNote("");
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {chapterListOpen ? (
        <aside className="reader-chapter-jump" aria-label="Chapter list">
          <div className="reader-panel-header">
            <strong>Chapters</strong>
            <button onClick={() => setChapterListOpen(false)} type="button">
              Close
            </button>
          </div>
          <ol>
            {chapterList.map((chapter) => (
              <li key={chapter.id}>
                <button
                  aria-current={chapter.id === target.chapterId ? "page" : undefined}
                  onClick={() => openReaderChapter(chapter)}
                  type="button"
                >
                  <span>{chapter.title}</span>
                  <small>{chapter.translationStatus ?? "draft"}</small>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}

      <div className="reader-settings-bar">
        <button className="plain-action" onClick={() => onEdit()} type="button">
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

      <header className="reader-heading" style={{ maxWidth: readingWidth }}>
        <span>{target.seriesTitle ?? target.title}</span>
      </header>

      {bookmarkError ? <p className="error-text">{bookmarkError}</p> : null}
      {highlightError ? <p className="error-text">{highlightError}</p> : null}

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
