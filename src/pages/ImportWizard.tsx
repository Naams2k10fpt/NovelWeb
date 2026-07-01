import { useMemo, useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type LibraryState = {
  loading: boolean;
  path: string | null;
  error: string | null;
};

type ImportFileType = "txt" | "md" | "docx" | "pdf";

type ImportPreviewNode = {
  id: string;
  name: string;
  relativePath: string;
  kind: "volume" | "folder" | "chapter";
  fileType?: ImportFileType;
  sizeBytes?: number;
  children?: ImportPreviewNode[];
};

type ImportPreview = {
  importSessionId: string;
  sourceFolderName: string;
  generatedAt: string;
  nodes: ImportPreviewNode[];
  counts: {
    volumes: number;
    chapters: number;
    txt: number;
    md: number;
    docx: number;
    pdf: number;
  };
};

type ImportSource = {
  importSessionId: string;
  path: string;
  name: string;
};

type ImportTextPreview = {
  fileId: string;
  sourceName: string;
  fileType: "txt" | "md";
  text: string;
};

type ImportReportLogEntry = {
  status: "imported" | "skipped" | "failed";
  fileId: string;
  title: string;
  message: string;
};

type ImportReport = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  imported: number;
  skipped: number;
  failed: number;
  logs: ImportReportLogEntry[];
};

type ImportPlanNode = Omit<ImportPreviewNode, "children"> & {
  title: string;
  selected: boolean;
  children?: ImportPlanNode[];
};

type SelectedImportChapter = ImportPlanNode & {
  volumeTitle: string;
};

type RendererApi = {
  import: {
    chooseSourceFolder: () => Promise<ApiResponse<ImportSource | null>>;
    scan: (importSessionId: string) => Promise<ApiResponse<ImportPreview>>;
    readText: (importSessionId: string, fileId: string) => Promise<ApiResponse<ImportTextPreview>>;
    execute: (importSessionId: string, input: unknown) => Promise<ApiResponse<ImportReport>>;
  };
};

type Step = "source" | "preview" | "confirm";

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.ok) {
    throw new Error(response.error.message);
  }

  return response.data;
}

function titleFromName(node: ImportPreviewNode): string {
  if (node.kind !== "chapter") {
    return node.name;
  }

  return node.name.replace(/\.[^.]+$/, "");
}

function toPlanNodes(nodes: ImportPreviewNode[]): ImportPlanNode[] {
  return nodes.map((node) => ({
    ...node,
    title: titleFromName(node),
    selected: true,
    children: node.children ? toPlanNodes(node.children) : undefined
  }));
}

function selectedChapterCount(nodes: ImportPlanNode[]): number {
  return nodes.reduce((total, node) => {
    const self = node.kind === "chapter" && node.selected ? 1 : 0;
    return total + self + (node.children ? selectedChapterCount(node.children) : 0);
  }, 0);
}

function selectedTypeCounts(nodes: ImportPlanNode[]): Record<ImportFileType, number> {
  const counts: Record<ImportFileType, number> = { txt: 0, md: 0, docx: 0, pdf: 0 };

  for (const node of nodes) {
    if (node.kind === "chapter" && node.selected && node.fileType) {
      counts[node.fileType] += 1;
    }

    if (node.children) {
      const childCounts = selectedTypeCounts(node.children);
      counts.txt += childCounts.txt;
      counts.md += childCounts.md;
      counts.docx += childCounts.docx;
      counts.pdf += childCounts.pdf;
    }
  }

  return counts;
}

function setSubtreeSelected(node: ImportPlanNode, selected: boolean): ImportPlanNode {
  return {
    ...node,
    selected,
    children: node.children?.map((child) => setSubtreeSelected(child, selected))
  };
}

function updateNodeSelected(nodes: ImportPlanNode[], nodeId: string, selected: boolean): ImportPlanNode[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? setSubtreeSelected(node, selected)
      : { ...node, children: node.children ? updateNodeSelected(node.children, nodeId, selected) : undefined }
  );
}

function updateNodeTitle(nodes: ImportPlanNode[], nodeId: string, title: string): ImportPlanNode[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? { ...node, title }
      : { ...node, children: node.children ? updateNodeTitle(node.children, nodeId, title) : undefined }
  );
}

function collectSelectedChapters(nodes: ImportPlanNode[], volumeTitle = "Imported"): SelectedImportChapter[] {
  return nodes.flatMap((node) => {
    const nextVolumeTitle = node.kind === "volume" ? node.title.trim() || node.name : volumeTitle;

    return [
      ...(node.kind === "chapter" && node.selected ? [{ ...node, volumeTitle }] : []),
      ...(node.children ? collectSelectedChapters(node.children, nextVolumeTitle) : [])
    ];
  });
}

function isTextChapter(node: ImportPlanNode): boolean {
  return node.fileType === "txt" || node.fileType === "md";
}

function fallbackChapterTitle(chapter: ImportPlanNode): string {
  return chapter.title.trim() || chapter.name.replace(/\.[^.]+$/, "");
}

function formatFileType(fileType?: ImportFileType): string {
  return fileType ? fileType.toUpperCase() : "Folder";
}

export default function ImportWizard({
  library,
  onOpenSettings
}: {
  library: LibraryState;
  onOpenSettings: () => void;
}) {
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<ImportPlanNode[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [step, setStep] = useState<Step>("source");
  const [textLoading, setTextLoading] = useState(false);
  const [textPreviews, setTextPreviews] = useState<Record<string, ImportTextPreview>>({});
  const selectedCount = selectedChapterCount(nodes);
  const selectedTypes = useMemo(() => selectedTypeCounts(nodes), [nodes]);
  const selectedChapters = useMemo(() => collectSelectedChapters(nodes), [nodes]);
  const selectedTextChapters = useMemo(() => selectedChapters.filter((chapter) => isTextChapter(chapter)), [selectedChapters]);
  const unsupportedSelectedCount = selectedCount - selectedTextChapters.length;
  const textReady = selectedTextChapters.every((chapter) => typeof editedTexts[chapter.id] === "string");

  async function chooseSourceFolder(): Promise<void> {
    const api = getApi();

    if (!api) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setEditedTexts({});
    setError(null);
    setLoading(true);
    setReport(null);
    setTextPreviews({});

    try {
      const nextSource = unwrap(await api.import.chooseSourceFolder());

      if (!nextSource) {
        return;
      }

      const nextPreview = unwrap(await api.import.scan(nextSource.importSessionId));
      setSource(nextSource);
      setPreview(nextPreview);
      setNodes(toPlanNodes(nextPreview.nodes));
      setStep("preview");
    } catch (chooseError) {
      setError(String(chooseError));
    } finally {
      setLoading(false);
    }
  }

  async function loadTextPreviews(chapters: SelectedImportChapter[]): Promise<void> {
    const api = getApi();

    if (!api || !source) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    const missingChapters = chapters.filter((chapter) => !textPreviews[chapter.id]);

    if (missingChapters.length === 0) {
      return;
    }

    setError(null);
    setTextLoading(true);

    try {
      const previews = await Promise.all(
        missingChapters.map((chapter) => api.import.readText(source.importSessionId, chapter.id).then(unwrap))
      );

      setTextPreviews((current) => ({
        ...current,
        ...Object.fromEntries(previews.map((textPreview) => [textPreview.fileId, textPreview]))
      }));
      setEditedTexts((current) => ({
        ...current,
        ...Object.fromEntries(
          previews
            .filter((textPreview) => current[textPreview.fileId] === undefined)
            .map((textPreview) => [textPreview.fileId, textPreview.text])
        )
      }));
    } catch (textError) {
      setError(String(textError));
    } finally {
      setTextLoading(false);
    }
  }

  async function openConfirmStep(): Promise<void> {
    setReport(null);
    setStep("confirm");
    await loadTextPreviews(selectedTextChapters);
  }

  async function executeImport(): Promise<void> {
    const api = getApi();

    if (!api || !source) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    if (selectedTextChapters.length === 0) {
      setError("Select at least one TXT or MD chapter.");
      return;
    }

    setError(null);
    setImporting(true);
    setReport(null);

    try {
      const nextReport = unwrap(
        await api.import.execute(source.importSessionId, {
          seriesTitle: source.name,
          chapters: selectedChapters.map((chapter) => ({
            fileId: chapter.id,
            title: fallbackChapterTitle(chapter),
            volumeTitle: chapter.volumeTitle || source.name,
            text: editedTexts[chapter.id] ?? ""
          }))
        })
      );
      setReport(nextReport);
    } catch (importError) {
      setError(String(importError));
    } finally {
      setImporting(false);
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
    <section className="import-wizard">
      <div className="import-steps" aria-label="Import steps">
        <StepButton current={step === "source"} label="Source" onClick={() => setStep("source")} />
        <StepButton current={step === "preview"} disabled={!preview} label="Preview" onClick={() => setStep("preview")} />
        <StepButton
          current={step === "confirm"}
          disabled={!preview || selectedCount === 0}
          label="Confirm"
          onClick={() => void openConfirmStep()}
        />
      </div>

      {step === "source" ? (
        <section className="import-panel">
          <div>
            <h2>Source folder</h2>
            <p className="muted-text">{source ? source.path : "No source folder selected."}</p>
          </div>
          <button className="primary-action" disabled={loading} onClick={() => void chooseSourceFolder()} type="button">
            {loading ? "Scanning" : source ? "Choose another folder" : "Choose folder"}
          </button>
        </section>
      ) : null}

      {step === "preview" && preview ? (
        <section className="import-panel import-preview">
          <div className="import-panel-header">
            <div>
              <h2>{preview.sourceFolderName}</h2>
              <p className="muted-text">
                {selectedCount} of {preview.counts.chapters} chapters selected
              </p>
            </div>
            <button
              className="primary-action"
              disabled={selectedCount === 0}
              onClick={() => {
                void openConfirmStep();
              }}
              type="button"
            >
              Review
            </button>
          </div>

          {nodes.length === 0 ? (
            <p className="muted-text">No supported files found.</p>
          ) : (
            <div className="import-tree" aria-label="Import preview">
              {nodes.map((node) => (
                <ImportNodeRow
                  key={node.id}
                  node={node}
                  onRename={(nodeId, title) => setNodes((current) => updateNodeTitle(current, nodeId, title))}
                  onToggle={(nodeId, selected) => setNodes((current) => updateNodeSelected(current, nodeId, selected))}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {step === "confirm" && preview ? (
        <section className="import-panel">
          <div className="import-panel-header">
            <div>
              <h2>Import plan</h2>
              <p className="muted-text">
                {selectedCount} chapters - TXT {selectedTypes.txt} - MD {selectedTypes.md} - DOCX {selectedTypes.docx} - PDF {selectedTypes.pdf}
              </p>
            </div>
            <button
              className="primary-action"
              disabled={importing || textLoading || selectedTextChapters.length === 0 || !textReady}
              onClick={() => void executeImport()}
              type="button"
            >
              {importing ? "Importing" : "Import selected"}
            </button>
          </div>

          {textLoading ? <p className="muted-text">Loading text preview.</p> : null}
          {unsupportedSelectedCount > 0 ? (
            <p className="muted-text">{unsupportedSelectedCount} selected DOCX/PDF chapters will be skipped in this step.</p>
          ) : null}
          {importing ? <progress className="import-progress" aria-label="Import progress" /> : null}

          <ol className="import-summary">
            {selectedChapters.map((chapter) => (
              <li key={chapter.id}>
                <span>{fallbackChapterTitle(chapter)}</span>
                <small>{formatFileType(chapter.fileType)}</small>
              </li>
            ))}
          </ol>

          {selectedTextChapters.length > 0 ? (
            <div className="import-text-editors">
              {selectedTextChapters.map((chapter) => (
                <label className="import-text-editor" key={chapter.id}>
                  <span>{fallbackChapterTitle(chapter)}</span>
                  <small>
                    {formatFileType(chapter.fileType)} - {chapter.volumeTitle}
                  </small>
                  <textarea
                    onChange={(event) =>
                      setEditedTexts((current) => ({ ...current, [chapter.id]: event.target.value }))
                    }
                    value={editedTexts[chapter.id] ?? ""}
                  />
                </label>
              ))}
            </div>
          ) : null}

          {report ? (
            <div className="import-report">
              <h3>{report.seriesTitle}</h3>
              <p className="muted-text">
                Imported {report.imported} - skipped {report.skipped} - failed {report.failed}
              </p>
              <ol className="import-summary">
                {report.logs.map((entry, index) => (
                  <li key={`${entry.fileId}-${index}`}>
                    <span>{entry.title}</span>
                    <small>
                      {entry.status.toUpperCase()} - {entry.message}
                    </small>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}

function StepButton({
  current,
  disabled = false,
  label,
  onClick
}: {
  current: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button aria-current={current ? "step" : undefined} disabled={disabled} onClick={onClick} type="button">
      {label}
    </button>
  );
}

function ImportNodeRow({
  node,
  onRename,
  onToggle
}: {
  node: ImportPlanNode;
  onRename: (nodeId: string, title: string) => void;
  onToggle: (nodeId: string, selected: boolean) => void;
}) {
  return (
    <div className={node.kind === "chapter" ? "import-node import-node-chapter" : "import-node"}>
      <label className="import-node-row">
        <input checked={node.selected} onChange={(event) => onToggle(node.id, event.target.checked)} type="checkbox" />
        <input
          aria-label={`${node.name} import title`}
          onChange={(event) => onRename(node.id, event.target.value)}
          type="text"
          value={node.title}
        />
        <small>{formatFileType(node.fileType)}</small>
      </label>

      {node.children ? (
        <div className="import-node-children">
          {node.children.map((child) => (
            <ImportNodeRow key={child.id} node={child} onRename={onRename} onToggle={onToggle} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
