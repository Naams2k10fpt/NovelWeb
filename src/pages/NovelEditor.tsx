import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export type ChapterTarget = {
  seriesId: string;
  categoryId: string;
  volumeId: string | null;
  chapterId: string;
  title: string;
};

type ChapterContent = {
  html: string;
  text: string;
  wordCount: number;
  characterCount: number;
  updatedAt: string;
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
  };
};

type EditorStatus = "loading" | "ready" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_DELAY_MS = 1200;

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

export default function NovelEditor({
  onBack,
  onDirtyChange,
  target
}: {
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  target: ChapterTarget;
}) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EditorStatus>("loading");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadedRef = useRef(false);
  const lastSavedHtmlRef = useRef("");
  const latestHtmlRef = useRef("");
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        "aria-label": "Chapter editor",
        class: "novel-editor-content"
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (!isLoadedRef.current) {
        return;
      }

      latestHtmlRef.current = currentEditor.getHTML();
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

    void api.chapters
      .getContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId)
      .then((response) => {
        if (!isMounted) {
          return;
        }

        const content = unwrap(response);
        editor.commands.setContent(content.html || "<p></p>", { emitUpdate: false });
        lastSavedHtmlRef.current = editor.getHTML();
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

    return () => {
      isMounted = false;
      clearAutosave();
      isLoadedRef.current = false;
      onDirtyChange(false);
    };
  }, [editor, onDirtyChange, target.categoryId, target.chapterId, target.seriesId, target.volumeId]);

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
    latestHtmlRef.current = editor.getHTML();

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
      latestHtmlRef.current = editor.getHTML();

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

  return (
    <section className="novel-editor">
      <button className="plain-action" onClick={onBack} type="button">
        Back
      </button>

      <header className="novel-editor-header">
        <span>Editor</span>
        <h2>{target.title}</h2>
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
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
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

        <button
          className="primary-action"
          disabled={status === "loading" || status === "saving"}
          onClick={() => void save()}
          type="button"
        >
          Save
        </button>
        <span className={status === "error" ? "editor-status editor-status-error" : "editor-status"}>
          {statusText(status)}
        </span>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="editor-surface">
        <EditorContent editor={editor} />
      </div>
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
