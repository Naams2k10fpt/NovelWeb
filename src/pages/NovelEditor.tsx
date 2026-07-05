import { Extension, Mark, mergeAttributes, Node as TiptapNode, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
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
const FONT_FAMILIES = ["Inter", "Georgia", "Times New Roman", "Arial", "Verdana", "Courier New"] as const;
const FONT_SIZES = ["14px", "16px", "18px", "20px", "24px", "28px", "32px"] as const;
const TEXT_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
const TEXT_ALIGNMENT_LABELS: Record<(typeof TEXT_ALIGNMENTS)[number], string> = {
  left: "L",
  center: "C",
  right: "R",
  justify: "J"
};

type BlockFormat = "paragraph" | "h1" | "h2" | "h3" | "codeBlock";
type TextStyleAttributes = {
  color?: string | null;
  backgroundColor?: string | null;
  fontFamily?: string | null;
  fontSize?: string | null;
};
type SelectedTextBlock = { node: ProseMirrorNode; pos: number };

function cleanColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const color = value.trim();

  if (/^#[0-9a-f]{3,8}$/i.test(color) || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(color)) {
    return color;
  }

  return null;
}

function cleanFontSize(value: unknown): string | null {
  return typeof value === "string" && FONT_SIZES.includes(value as (typeof FONT_SIZES)[number]) ? value : null;
}

function cleanFontFamily(value: unknown): string | null {
  return typeof value === "string" && FONT_FAMILIES.includes(value as (typeof FONT_FAMILIES)[number]) ? value : null;
}

function cleanTextAlign(value: unknown): string | null {
  return typeof value === "string" && TEXT_ALIGNMENTS.includes(value as (typeof TEXT_ALIGNMENTS)[number])
    ? value
    : null;
}

function colorInputValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const color = value.trim();
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);

  if (hex) {
    return hex[1].length === 3
      ? `#${hex[1]
          .split("")
          .map((part) => part + part)
          .join("")}`
      : color;
  }

  const rgb = color.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);

  if (!rgb) {
    return fallback;
  }

  return `#${rgb
    .slice(1)
    .map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0"))
    .join("")}`;
}

const TextStyle = Mark.create({
  name: "textStyle",
  priority: 101,
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => cleanColor(element.style.color)
      },
      backgroundColor: {
        default: null,
        parseHTML: (element) => cleanColor(element.style.backgroundColor)
      },
      fontFamily: {
        default: null,
        parseHTML: (element) => cleanFontFamily(element.style.fontFamily.replace(/"/g, ""))
      },
      fontSize: {
        default: null,
        parseHTML: (element) => cleanFontSize(element.style.fontSize)
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[style]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const { backgroundColor, color, fontFamily, fontSize, style: _style, ...attributes } = HTMLAttributes;
    const styles = [
      cleanColor(color) ? `color: ${color}` : "",
      cleanColor(backgroundColor) ? `background-color: ${backgroundColor}` : "",
      cleanFontFamily(fontFamily) ? `font-family: ${fontFamily}` : "",
      cleanFontSize(fontSize) ? `font-size: ${fontSize}` : ""
    ]
      .filter(Boolean)
      .join("; ");

    return ["span", mergeAttributes(attributes, styles ? { style: styles } : {}), 0];
  }
});

const TextAlign = Extension.create({
  name: "textAlign",
  addGlobalAttributes() {
    return [
      {
        types: ["heading", "paragraph"],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => cleanTextAlign(element.style.textAlign),
            renderHTML: (attributes) => {
              const textAlign = cleanTextAlign(attributes.textAlign);
              return textAlign ? { style: `text-align: ${textAlign}` } : {};
            }
          }
        }
      }
    ];
  }
});

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

function blockFormat(editor: Editor | null): BlockFormat {
  if (!editor) {
    return "paragraph";
  }

  if (editor.isActive("heading", { level: 1 })) {
    return "h1";
  }

  if (editor.isActive("heading", { level: 2 })) {
    return "h2";
  }

  if (editor.isActive("heading", { level: 3 })) {
    return "h3";
  }

  if (editor.isActive("codeBlock")) {
    return "codeBlock";
  }

  return "paragraph";
}

function currentTextAlign(editor: Editor | null): string {
  if (!editor) {
    return "left";
  }

  const firstBlock = selectedTextBlocks(editor)[0];

  if (firstBlock) {
    return cleanTextAlign(firstBlock.node.attrs.textAlign) ?? "left";
  }

  return "left";
}

function normalizedLinkHref(value: string): string {
  const href = value.trim();

  if (!href) {
    return "";
  }

  return /^(https?:|mailto:)/i.test(href) ? href : `https://${href}`;
}

function isTextBlock(node: ProseMirrorNode): boolean {
  return node.type.name === "paragraph" || node.type.name === "heading";
}

function addTextBlockAt(blocks: Map<number, SelectedTextBlock>, position: ResolvedPos): void {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    const node = position.node(depth);

    if (isTextBlock(node)) {
      blocks.set(position.before(depth), { node, pos: position.before(depth) });
      return;
    }
  }
}

function selectedTextBlocks(editor: Editor): SelectedTextBlock[] {
  const blocks = new Map<number, SelectedTextBlock>();
  const { doc, selection } = editor.state;

  addTextBlockAt(blocks, selection.$from);
  addTextBlockAt(blocks, selection.$to);

  if (!selection.empty) {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (isTextBlock(node)) {
        blocks.set(pos, { node, pos });
      }
    });
  }

  return [...blocks.values()].sort((a, b) => a.pos - b.pos);
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
  const [linkHref, setLinkHref] = useState("");
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadedRef = useRef(false);
  const lastSavedHtmlRef = useRef("");
  const latestHtmlRef = useRef("");
  const saveInFlightRef = useRef(false);
  const saveAgainRef = useRef(false);
  const titleRef = useRef("");
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TextStyle, TextAlign, InlineImage],
    content: "",
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        "aria-label": "Chapter editor",
        class: "novel-editor-content",
        spellcheck: "false"
      }
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      const href = currentEditor.getAttributes("link").href;
      setLinkHref(typeof href === "string" ? href : "");
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
    setLinkHref("");
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

  function applyBlockFormat(format: BlockFormat): void {
    if (!editor) {
      return;
    }

    if (format === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }

    if (format === "codeBlock") {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    editor
      .chain()
      .focus()
      .setHeading({ level: Number(format.replace("h", "")) as 1 | 2 | 3 })
      .run();
  }

  function applyTextAlign(textAlign: string): void {
    if (!editor) {
      return;
    }

    const value = textAlign === "left" ? null : cleanTextAlign(textAlign);
    const tr = editor.state.tr;
    const blocks = selectedTextBlocks(editor);

    if (!blocks.length) {
      return;
    }

    for (const block of blocks) {
      tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, textAlign: value });
    }

    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  }

  function applyTextStyle(attribute: keyof TextStyleAttributes, value: string | null): void {
    if (!editor) {
      return;
    }

    const current = editor.getAttributes("textStyle") as TextStyleAttributes;
    const next = { ...current, [attribute]: value };

    if (!next.color && !next.backgroundColor && !next.fontFamily && !next.fontSize) {
      editor.chain().focus().unsetMark("textStyle").run();
      return;
    }

    editor.chain().focus().setMark("textStyle", next).run();
  }

  function applyLink(): void {
    if (!editor) {
      return;
    }

    const href = normalizedLinkHref(linkHref);

    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    setLinkHref(href);
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  function clearFormatting(): void {
    editor?.chain().focus().unsetAllMarks().clearNodes().run();
  }

  const textStyle = (editor?.getAttributes("textStyle") ?? {}) as TextStyleAttributes;
  const selectedFontFamily = cleanFontFamily(textStyle.fontFamily) ?? "";
  const selectedFontSize = cleanFontSize(textStyle.fontSize) ?? "";

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
        <div className="toolbar-group toolbar-style-group">
          <select
            aria-label="Block format"
            disabled={!editor}
            onChange={(event) => applyBlockFormat(event.target.value as BlockFormat)}
            title="Block format"
            value={blockFormat(editor)}
          >
            <option value="paragraph">Paragraph</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="codeBlock">Code block</option>
          </select>
          <select
            aria-label="Font family"
            disabled={!editor}
            onChange={(event) => applyTextStyle("fontFamily", event.target.value || null)}
            title="Font family"
            value={selectedFontFamily}
          >
            <option value="">Font</option>
            {FONT_FAMILIES.map((fontFamily) => (
              <option key={fontFamily} value={fontFamily}>
                {fontFamily}
              </option>
            ))}
          </select>
          <select
            aria-label="Font size"
            disabled={!editor}
            onChange={(event) => applyTextStyle("fontSize", event.target.value || null)}
            title="Font size"
            value={selectedFontSize}
          >
            <option value="">Size</option>
            {FONT_SIZES.map((fontSize) => (
              <option key={fontSize} value={fontSize}>
                {fontSize}
              </option>
            ))}
          </select>
        </div>

        <div className="toolbar-group toolbar-compact-group">
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
            active={editor?.isActive("underline") ?? false}
            disabled={!editor}
            label="U"
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
            title="Underline"
          />
          <ToolbarButton
            active={editor?.isActive("strike") ?? false}
            disabled={!editor}
            label="S"
            onClick={() => editor?.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          />
          <label className="toolbar-swatch" title="Text color">
            <span>A</span>
            <input
              aria-label="Text color"
              disabled={!editor}
              onChange={(event) => applyTextStyle("color", event.target.value)}
              type="color"
              value={colorInputValue(textStyle.color, "#23272f")}
            />
          </label>
          <label className="toolbar-swatch" title="Highlight color">
            <span>H</span>
            <input
              aria-label="Highlight color"
              disabled={!editor}
              onChange={(event) => applyTextStyle("backgroundColor", event.target.value)}
              type="color"
              value={colorInputValue(textStyle.backgroundColor, "#f7d56f")}
            />
          </label>
          <ToolbarButton
            active={editor?.isActive("code") ?? false}
            disabled={!editor}
            label="Code"
            onClick={() => editor?.chain().focus().toggleCode().run()}
            title="Inline code"
          />
        </div>

        <div className="toolbar-group toolbar-compact-group">
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
            label="Bullets"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
            title="Bullet list"
          />
          <ToolbarButton
            active={editor?.isActive("orderedList") ?? false}
            disabled={!editor}
            label="Numbered"
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            title="Numbered list"
          />
          <ToolbarButton
            active={editor?.isActive("codeBlock") ?? false}
            disabled={!editor}
            label="Block code"
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            title="Code block"
          />
          <ToolbarButton
            active={false}
            disabled={!editor}
            label="Rule"
            onClick={() => editor?.chain().focus().setHorizontalRule().run()}
            title="Horizontal rule"
          />
        </div>

        <div className="toolbar-group toolbar-compact-group">
          {TEXT_ALIGNMENTS.map((textAlign) => (
            <ToolbarButton
              active={currentTextAlign(editor) === textAlign}
              disabled={!editor}
              key={textAlign}
              label={TEXT_ALIGNMENT_LABELS[textAlign]}
              onClick={() => applyTextAlign(textAlign)}
              title={`Align ${textAlign}`}
            />
          ))}
        </div>

        <div className="toolbar-group toolbar-link-group">
          <input
            aria-label="Link URL"
            className="editor-link-input"
            disabled={!editor}
            onChange={(event) => setLinkHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              }
            }}
            placeholder="https://..."
            title="Link URL"
            type="url"
            value={linkHref}
          />
          <ToolbarButton
            active={editor?.isActive("link") ?? false}
            disabled={!editor}
            label="Link"
            onClick={applyLink}
            title="Apply link"
          />
          <ToolbarButton
            active={false}
            disabled={!editor}
            label="Unlink"
            onClick={() => editor?.chain().focus().extendMarkRange("link").unsetLink().run()}
            title="Remove link"
          />
        </div>

        <div className="toolbar-group toolbar-compact-group">
          <ToolbarButton
            active={false}
            disabled={!editor || !editor.can().undo()}
            label="Undo"
            onClick={() => editor?.chain().focus().undo().run()}
            title="Undo"
          />
          <ToolbarButton
            active={false}
            disabled={!editor || !editor.can().redo()}
            label="Redo"
            onClick={() => editor?.chain().focus().redo().run()}
            title="Redo"
          />
          <ToolbarButton active={false} disabled={!editor} label="Clear" onClick={clearFormatting} title="Clear formatting" />
          <ToolbarButton
            active={false}
            disabled={!editor || status === "loading"}
            label="Image"
            onClick={() => void insertImage()}
            title="Insert image"
          />
        </div>

        <div className="toolbar-actions">
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
