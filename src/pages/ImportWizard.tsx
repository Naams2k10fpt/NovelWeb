import { useEffect, useMemo, useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type LibraryState = {
  loading: boolean;
  path: string | null;
  error: string | null;
};

type ImportFileType = "txt" | "md" | "docx" | "pdf" | "images";
type ImportVolumeMode = "source" | "existing" | "none";

type ImportPreviewNode = {
  id: string;
  name: string;
  relativePath: string;
  kind: "volume" | "folder" | "chapter";
  fileType?: ImportFileType;
  sizeBytes?: number;
  children?: ImportPreviewNode[];
};

export type ImportPreview = {
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
    images: number;
  };
};

export type ImportSource = {
  importSessionId: string;
  path: string;
  name: string;
};

type ImportReportLogEntry = {
  status: "imported" | "unsupported" | "skipped" | "failed";
  fileId: string;
  title: string;
  message: string;
};

type ImportReport = {
  seriesId: string;
  seriesTitle: string;
  categoryId: string;
  imported: number;
  unsupported: number;
  skipped: number;
  failed: number;
  logs: ImportReportLogEntry[];
};

type ImportHistoryEntry = ImportReport & {
  id: string;
  createdAt: string;
  sourceName: string;
};

type ImportPlanNode = Omit<ImportPreviewNode, "children"> & {
  title: string;
  selected: boolean;
  children?: ImportPlanNode[];
};

type SelectedImportChapter = ImportPlanNode & {
  volumeTitle: string;
};

export type ImportTargetPreset =
  | {
      mode: "new";
      label?: string;
    }
  | {
      mode: "existing";
      seriesId: string;
      categoryId: string;
      volumeMode: ImportVolumeMode;
      volumeId: string | null;
      label: string;
    };

type RendererApi = {
  import: {
    history: () => Promise<ApiResponse<ImportHistoryEntry[]>>;
    chooseSourceFolder: () => Promise<ApiResponse<ImportSource | null>>;
    scan: (importSessionId: string) => Promise<ApiResponse<ImportPreview>>;
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
  const counts: Record<ImportFileType, number> = { txt: 0, md: 0, docx: 0, pdf: 0, images: 0 };

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
      counts.images += childCounts.images;
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
  return node.fileType === "txt" || node.fileType === "md" || node.fileType === "docx" || node.fileType === "pdf";
}

function isImportableChapter(node: ImportPlanNode): boolean {
  return isTextChapter(node) || node.fileType === "images";
}

function fallbackChapterTitle(chapter: ImportPlanNode): string {
  return chapter.title.trim() || chapter.name.replace(/\.[^.]+$/, "");
}

function formatFileType(fileType?: ImportFileType): string {
  return fileType === "images" ? "Images" : fileType ? fileType.toUpperCase() : "Folder";
}

export default function ImportWizard({
  library,
  onOpenSettings,
  initialPreview = null,
  initialSource = null,
  onCancel,
  onImported,
  targetPreset
}: {
  library: LibraryState;
  onOpenSettings: () => void;
  initialPreview?: ImportPreview | null;
  initialSource?: ImportSource | null;
  onCancel?: () => void;
  onImported?: (report: ImportReport) => void;
  targetPreset?: ImportTargetPreset;
}) {
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
  const [nodes, setNodes] = useState<ImportPlanNode[]>(() => (initialPreview ? toPlanNodes(initialPreview.nodes) : []));
  const [preview, setPreview] = useState<ImportPreview | null>(initialPreview);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [source, setSource] = useState<ImportSource | null>(initialSource);
  const [step, setStep] = useState<Step>(initialPreview ? "preview" : "source");
  const selectedCount = selectedChapterCount(nodes);
  const selectedTypes = useMemo(() => selectedTypeCounts(nodes), [nodes]);
  const selectedChapters = useMemo(() => collectSelectedChapters(nodes), [nodes]);
  const selectedImportableChapters = useMemo(
    () => selectedChapters.filter((chapter) => isImportableChapter(chapter)),
    [selectedChapters]
  );
  const skippedSelectedCount = selectedCount - selectedImportableChapters.length;

  useEffect(() => {
    const api = getApi();

    if (!api || !library.path) {
      return;
    }

    void api.import.history().then((response) => {
      if (response.ok) {
        setHistory(response.data);
      }
    });
  }, [library.path]);

  async function chooseSourceFolder(): Promise<void> {
    const api = getApi();

    if (!api) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setError(null);
    setLoading(true);
    setReport(null);

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

  function openConfirmStep(): void {
    setReport(null);
    setStep("confirm");
  }

  async function executeImport(): Promise<void> {
    const api = getApi();

    if (!api || !source) {
      setError("App API is unavailable. Restart the app or check the preload script.");
      return;
    }

    if (selectedImportableChapters.length === 0) {
      setError("Select at least one TXT, MD, DOCX, PDF, or illustrations chapter.");
      return;
    }

    setError(null);
    setImporting(true);
    setReport(null);

    try {
      const target =
        targetPreset?.mode === "existing"
          ? {
              mode: "existing",
              seriesId: targetPreset.seriesId,
              categoryId: targetPreset.categoryId,
              volumeMode: targetPreset.volumeMode,
              volumeId: targetPreset.volumeId
            }
          : { mode: "new", seriesTitle: source.name };
      const nextReport = unwrap(
        await api.import.execute(source.importSessionId, {
          seriesTitle: source.name,
          target,
          chapters: selectedChapters.map((chapter) => ({
            fileId: chapter.id,
            title: fallbackChapterTitle(chapter),
            volumeTitle: chapter.volumeTitle || source.name
          }))
        })
      );
      setReport(nextReport);
      const historyResponse = await api.import.history();
      if (historyResponse.ok) {
        setHistory(historyResponse.data);
      }
      onImported?.(nextReport);
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
        <StepButton current={step === "preview"} disabled={!preview} label="Files" onClick={() => setStep("preview")} />
        <StepButton
          current={step === "confirm"}
          disabled={!preview || selectedCount === 0}
          label="Confirm"
          onClick={openConfirmStep}
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
          {onCancel ? (
            <button onClick={onCancel} type="button">
              Cancel
            </button>
          ) : null}
          {history.length > 0 ? (
            <div className="import-report">
              <h3>Recent imports</h3>
              {history.map((entry) => (
                <details key={entry.id}>
                  <summary>
                    {entry.sourceName} to {entry.seriesTitle} - {new Date(entry.createdAt).toLocaleString()}
                  </summary>
                  <p className="muted-text">
                    Imported {entry.imported} - unsupported {entry.unsupported} - skipped {entry.skipped} - failed{" "}
                    {entry.failed}
                  </p>
                  <ol className="import-summary">
                    {entry.logs.map((log, index) => (
                      <li key={`${log.fileId}-${index}`}>
                        <span>{log.title}</span>
                        <small>
                          {log.status.toUpperCase()} - {log.message}
                        </small>
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
            </div>
          ) : null}
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
              onClick={openConfirmStep}
              type="button"
            >
              Continue
            </button>
          </div>

          {nodes.length === 0 ? (
            <p className="muted-text">No supported files found.</p>
          ) : (
            <div className="import-tree" aria-label="Import files">
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
                {selectedCount} chapters - TXT {selectedTypes.txt} - MD {selectedTypes.md} - DOCX {selectedTypes.docx} - PDF {selectedTypes.pdf} - Images {selectedTypes.images}
              </p>
            </div>
            <button
              className="primary-action"
              disabled={importing || selectedImportableChapters.length === 0}
              onClick={() => void executeImport()}
              type="button"
            >
              {importing ? "Importing" : "Import selected"}
            </button>
          </div>

          <p className="muted-text">
            Destination: {targetPreset?.label ?? `New series: ${source?.name ?? preview.sourceFolderName}`}
          </p>
          {selectedTypes.pdf > 0 ? (
            <p className="muted-text">Selected PDFs will import extracted text and keep the original file.</p>
          ) : null}
          {selectedTypes.images > 0 ? (
            <p className="muted-text">Selected illustrations folders will import as image chapters.</p>
          ) : null}
          {skippedSelectedCount > 0 ? (
            <p className="muted-text">{skippedSelectedCount} selected chapters cannot be imported in this step.</p>
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

          {report ? (
            <div className="import-report">
              <h3>{report.seriesTitle}</h3>
              <p className="muted-text">
                Imported {report.imported} - unsupported {report.unsupported} - skipped {report.skipped} - failed {report.failed}
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
