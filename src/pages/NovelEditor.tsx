import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export type ChapterTarget = {
  seriesId: string;
  seriesTitle?: string;
  categoryId: string;
  categoryType?: "light-novel" | "web-novel" | "manga";
  volumeId: string | null;
  chapterId: string;
  title: string;
  scrollTop?: number;
};

type ChapterContent = {
  html: string;
  text: string;
  wordCount: number;
  characterCount: number;
  updatedAt: string;
};

type ChapterImageAsset = {
  src: string;
  dataUrl: string;
  fileName: string;
};

type ChapterOriginalPdf = {
  dataUrl: string;
  fileName: string;
};

type RendererApi = {
  chapters: {
    getContent: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<ChapterContent>>;
    saveContent: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<ChapterContent>>;
    getOriginalPdf: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<ChapterOriginalPdf | null>>;
    chooseImage: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<ChapterImageAsset | null>>;
  };
};

type EditorStatus = "loading" | "ready" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_DELAY_MS = 1200;

const InlineImage = TiptapNode.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      assetSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-asset-src"),
        renderHTML: (attributes) => {
          const assetSrc = attributes.assetSrc;
          return typeof assetSrc === "string" && assetSrc ? { "data-asset-src": assetSrc } : {};
        }
      }
    };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  }
});

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.data;
}

function statusText(status: EditorStatus): string {
  if (status === "loading") {
    return "Đang tải";
  }

  if (status === "dirty") {
    return "Chưa lưu";
  }

  if (status === "saving") {
    return "Đang lưu";
  }

  if (status === "saved") {
    return "Đã lưu";
  }

  if (status === "error") {
    return "Lỗi lưu";
  }

  return "Sẵn sàng";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function splitTitleHtml(html: string): { title: string; bodyHtml: string } {
  const document = new DOMParser().parseFromString(html || "<p></p>", "text/html");
  const heading = Array.from(document.body.children).find((element) => element.tagName.toLowerCase() === "h1");
  const title = heading?.textContent?.trim() ?? "";

  heading?.remove();

  return {
    title,
    bodyHtml: document.body.innerHTML.trim() || "<p></p>"
  };
}

function composeChapterHtml(title: string, bodyHtml: string): string {
  const heading = title.trim();
  const body = bodyHtml.trim() || "<p></p>";

  return heading ? `<h1>${escapeHtml(heading)}</h1>\n${body}` : body;
}

export default function NovelEditor({
  onBack,
  onDirtyChange,
  onRead,
  target
}: {
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onRead: () => void;
  target: ChapterTarget;
}) {
  const [error, setError] = useState<string | null>(null);
  const [originalPdf, setOriginalPdf] = useState<ChapterOriginalPdf | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [status, setStatus] = useState<EditorStatus>("loading");
  const [title, setTitle] = useState("");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadedRef = useRef(false);
  const lastSavedHtmlRef = useRef("");
  const latestHtmlRef = useRef("");
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const titleRef = useRef("");
  const editor = useEditor({
    extensions: [StarterKit, InlineImage],
    content: "",
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        "aria-label": "Chapter editor",
        class: "novel-editor-content",
        spellcheck: "false"
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (!isLoadedRef.current) {
        return;
      }

      latestHtmlRef.current = composeChapterHtml(titleRef.current, currentEditor.getHTML());
      onDirtyChange(latestHtmlRef.current !== lastSavedHtmlRef.current);
      setError(null);
      setStatus((current) => (current === "loading" || current === "saving" ? current : "dirty"));
      scheduleAutosave();
    }
  });

  function clearAutosave(): void {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }

  function scheduleAutosave(): void {
    clearAutosave();
    autosaveTimerRef.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }

  useEffect(() => {
    if (!editor) {
      return;
    }

    let isMounted = true;
    const api = getApi();

    if (!api) {
      setStatus("error");
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    clearAutosave();
    isLoadedRef.current = false;
    lastSavedHtmlRef.current = "";
    latestHtmlRef.current = "";
    onDirtyChange(false);
    setStatus("loading");
    setError(null);
    setOriginalPdf(null);
    setPdfError(null);
    setTitle("");
    titleRef.current = "";

    void api.chapters
      .getContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId)
      .then((response) => {
        if (!isMounted) {
          return;
        }

        const content = unwrap(response);
        const nextContent = splitTitleHtml(content.html);
        setTitle(nextContent.title);
        titleRef.current = nextContent.title;
        editor.commands.setContent(nextContent.bodyHtml, { emitUpdate: false });
        lastSavedHtmlRef.current = composeChapterHtml(nextContent.title, editor.getHTML());
        latestHtmlRef.current = lastSavedHtmlRef.current;
        isLoadedRef.current = true;
        setStatus("ready");
      })
      .catch((loadError) => {
        if (isMounted) {
          setStatus("error");
          setError(String(loadError));
        }
      });

    void api.chapters
      .getOriginalPdf(target.seriesId, target.categoryId, target.volumeId, target.chapterId)
      .then((response) => {
        if (isMounted) {
          setOriginalPdf(unwrap(response));
        }
      })
      .catch((loadPdfError) => {
        if (isMounted) {
          setPdfError(String(loadPdfError));
        }
      });

    return () => {
      isMounted = false;
      clearAutosave();
      isLoadedRef.current = false;
      onDirtyChange(false);
    };
  }, [editor, onDirtyChange, target.categoryId, target.chapterId, target.seriesId, target.volumeId]);

  function updateTitle(value: string): void {
    setTitle(value);
    titleRef.current = value;

    if (!editor || !isLoadedRef.current) {
      return;
    }

    latestHtmlRef.current = composeChapterHtml(value, editor.getHTML());
    onDirtyChange(latestHtmlRef.current !== lastSavedHtmlRef.current);
    setError(null);
    setStatus((current) => (current === "loading" || current === "saving" ? current : "dirty"));
    scheduleAutosave();
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      if (latestHtmlRef.current === lastSavedHtmlRef.current) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  });

  async function save(): Promise<void> {
    const api = getApi();

    if (!api || !editor || !isLoadedRef.current) {
      return;
    }

    clearAutosave();
    latestHtmlRef.current = composeChapterHtml(titleRef.current, editor.getHTML());

    if (saveInFlightRef.current) {
      saveAgainRef.current = true;
      return;
    }

    if (latestHtmlRef.current === lastSavedHtmlRef.current) {
      onDirtyChange(false);
      setStatus("saved");
      return;
    }

    const html = latestHtmlRef.current;
    saveInFlightRef.current = true;
    saveAgainRef.current = false;
    setStatus("saving");
    setError(null);

    try {
      unwrap(
        await api.chapters.saveContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId, {
          html
        })
      );
      lastSavedHtmlRef.current = html;
      latestHtmlRef.current = composeChapterHtml(titleRef.current, editor.getHTML());

      if (latestHtmlRef.current !== html || saveAgainRef.current) {
        onDirtyChange(true);
        saveAgainRef.current = true;
        setStatus("dirty");
      } else {
        onDirtyChange(false);
        setStatus("saved");
      }
    } catch (saveError) {
      onDirtyChange(true);
      setStatus("error");
      setError(String(saveError));
    } finally {
      saveInFlightRef.current = false;

      if (saveAgainRef.current) {
        saveAgainRef.current = false;
        void save();
      }
    }
  }

  async function insertImage(): Promise<void> {
    const api = getApi();

    if (!api || !editor || !isLoadedRef.current) {
      return;
    }

    try {
      const asset = unwrap(
        await api.chapters.chooseImage(target.seriesId, target.categoryId, target.volumeId, target.chapterId)
      );

      if (!asset) {
        return;
      }

      editor
        .chain()
        .focus()
        .insertContent({ type: "image", attrs: { src: asset.dataUrl, assetSrc: asset.src, alt: asset.fileName } })
        .run();
    } catch (insertError) {
      setStatus("error");
      setError(String(insertError));
    }
  }

  function toggleHeadingBlock(): void {
    if (!editor) {
      return;
    }

    const { doc, selection } = editor.state;
    const from = doc.resolve(selection.from).start();
    const to = doc.resolve(selection.to).end();

    editor.chain().focus().setTextSelection({ from, to }).toggleHeading({ level: 2 }).run();
  }

  return (
    <section className={originalPdf ? "novel-editor novel-editor-split" : "novel-editor"}>
      <button className="plain-action" onClick={onBack} type="button">
        Back
      </button>

      <header className="novel-editor-header">
        <span>{target.seriesTitle ?? "Editor"}</span>
        <input
          aria-label="Chapter title"
          className="novel-title-input"
          onChange={(event) => updateTitle(event.target.value)}
          placeholder="Chapter title"
          spellCheck={false}
          value={title}
        />
        <small>{target.title}</small>
      </header>

      <div className="editor-toolbar" aria-label="Editor toolbar">
        <ToolbarButton
          active={editor?.isActive("bold") ?? false}
          disabled={!editor}
          label="B"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title="Bold"
        />
        <ToolbarButton
          active={editor?.isActive("italic") ?? false}
          disabled={!editor}
          label="I"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title="Italic"
        />
        <ToolbarButton
          active={editor?.isActive("heading", { level: 2 }) ?? false}
          disabled={!editor}
          label="H2"
          onClick={toggleHeadingBlock}
          title="Heading"
        />
        <ToolbarButton
          active={editor?.isActive("blockquote") ?? false}
          disabled={!editor}
          label="Quote"
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          title="Quote"
        />
        <ToolbarButton
          active={editor?.isActive("bulletList") ?? false}
          disabled={!editor}
          label="List"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          title="List"
        />
        <ToolbarButton
          active={false}
          disabled={!editor || status === "loading"}
          label="Image"
          onClick={() => void insertImage()}
          title="Insert image"
        />

        <button
          className="primary-action"
          disabled={status === "loading" || status === "saving"}
          onClick={() => void save()}
          type="button"
        >
          Save
        </button>
        <button onClick={onRead} type="button">
          Read
        </button>
        <span className={status === "error" ? "editor-status editor-status-error" : "editor-status"}>
          {statusText(status)}
        </span>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {pdfError ? <p className="error-text">{pdfError}</p> : null}

      {originalPdf ? (
        <div className="pdf-split-view">
          <section className="pdf-pane" aria-label="Original PDF">
            <div className="pdf-pane-header">
              <span>Original PDF</span>
              <strong>{originalPdf.fileName}</strong>
            </div>
            <iframe
              className="pdf-frame"
              src={`${originalPdf.dataUrl}#toolbar=0&navpanes=0&view=FitH`}
              title={originalPdf.fileName}
            />
          </section>

          <div className="editor-surface editor-surface-split">
            <EditorContent editor={editor} />
          </div>
        </div>
      ) : (
        <div className="editor-surface">
          <EditorContent editor={editor} />
        </div>
      )}
    </section>
  );
}

function ToolbarButton({
  active,
  disabled,
  label,
  onClick,
  title
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button aria-pressed={active} disabled={disabled} onClick={onClick} title={title} type="button">
      {label}
    </button>
  );
}
