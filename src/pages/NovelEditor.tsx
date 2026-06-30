import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";

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

export default function NovelEditor({ onBack, target }: { onBack: () => void; target: ChapterTarget }) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EditorStatus>("loading");
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
    onUpdate: () => {
      setError(null);
      setStatus((current) => (current === "loading" || current === "saving" ? current : "dirty"));
    }
  });

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
    };
  }, [editor, target.categoryId, target.chapterId, target.seriesId, target.volumeId]);

  async function save(): Promise<void> {
    const api = getApi();

    if (!api || !editor || status === "loading" || status === "saving") {
      return;
    }

    setStatus("saving");
    setError(null);

    try {
      const html = editor.getHTML();
      unwrap(
        await api.chapters.saveContent(target.seriesId, target.categoryId, target.volumeId, target.chapterId, {
          html
        })
      );
      setStatus(editor.getHTML() === html ? "saved" : "dirty");
    } catch (saveError) {
      setStatus("error");
      setError(String(saveError));
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
