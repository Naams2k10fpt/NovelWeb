import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type PointerEvent
} from "react";
import ImportWizard, { type ImportPreview, type ImportSource, type ImportTargetPreset } from "./ImportWizard";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type ManagerProps = {
  library: {
    loading: boolean;
    path: string | null;
    error: string | null;
  };
  onOpenSettings: () => void;
};

type CategoryType = "light-novel" | "web-novel" | "manga";

type SeriesCard = {
  id: string;
  title: string;
  status: string;
};

type CategoryMetadata = {
  id: string;
  type: CategoryType;
  title: string;
};

type VolumeMetadata = {
  id: string;
  title: string;
};

type ChapterMetadata = {
  id: string;
  title: string;
  translationStatus?: string;
  pageCount?: number;
  totalSizeBytes?: number;
};

type ChapterNode = ChapterMetadata & {
  kind: "chapter";
  seriesId: string;
  categoryId: string;
  categoryType: CategoryType;
  volumeId: string | null;
};

type VolumeNode = VolumeMetadata & {
  kind: "volume";
  seriesId: string;
  categoryId: string;
  chapters: ChapterNode[];
};

type CategoryNode = CategoryMetadata & {
  kind: "category";
  seriesId: string;
  volumes: VolumeNode[];
  directChapters: ChapterNode[];
};

type SeriesNode = SeriesCard & {
  kind: "series";
  categories: CategoryNode[];
};

type TreeNode = SeriesNode | CategoryNode | VolumeNode | ChapterNode;

type TreeState = {
  loading: boolean;
  series: SeriesNode[];
  error: string | null;
};

type ContextMenuState = {
  x: number;
  y: number;
  nodeKey: string | null;
};

type ChapterDropState = {
  nodeKey: string;
  placement: "before" | "after";
};

type ManagerFormState = {
  heading: string;
  label: string;
  title: string;
  categoryType: CategoryType | null;
  submit: (title: string, categoryType: CategoryType | null) => Promise<void>;
};

type ManagerImportState = {
  heading: string;
  preview: ImportPreview;
  source: ImportSource;
  target: ImportTargetPreset;
};

type MangaPageSummary = {
  fileName: string;
  thumbnailFileName: string;
  thumbnailDataUrl: string | null;
  sizeBytes: number;
};

type MangaChapterPages = {
  chapter: ChapterMetadata;
  pages: MangaPageSummary[];
};

type MangaPageData = {
  fileName: string;
  dataUrl: string;
  sizeBytes: number;
};

type ManagerAction = {
  label: string;
  run: () => Promise<void | false>;
};

type RendererApi = {
  series: {
    list: () => Promise<ApiResponse<SeriesCard[]>>;
    create: (input: unknown) => Promise<ApiResponse<unknown>>;
    update: (seriesId: string, input: unknown) => Promise<ApiResponse<unknown>>;
    moveToTrash: (seriesId: string) => Promise<ApiResponse<unknown>>;
  };
  categories: {
    list: (seriesId: string) => Promise<ApiResponse<CategoryMetadata[]>>;
    create: (seriesId: string, input: unknown) => Promise<ApiResponse<unknown>>;
    update: (seriesId: string, categoryId: string, input: unknown) => Promise<ApiResponse<unknown>>;
    moveToTrash: (seriesId: string, categoryId: string) => Promise<ApiResponse<unknown>>;
  };
  volumes: {
    list: (seriesId: string, categoryId: string) => Promise<ApiResponse<VolumeMetadata[]>>;
    create: (seriesId: string, categoryId: string, input: unknown) => Promise<ApiResponse<unknown>>;
    update: (seriesId: string, categoryId: string, volumeId: string, input: unknown) => Promise<ApiResponse<unknown>>;
    moveToTrash: (seriesId: string, categoryId: string, volumeId: string) => Promise<ApiResponse<unknown>>;
  };
  chapters: {
    list: (seriesId: string, categoryId: string, volumeId?: string | null) => Promise<ApiResponse<ChapterMetadata[]>>;
    create: (seriesId: string, categoryId: string, volumeId: string | null, input: unknown) => Promise<ApiResponse<unknown>>;
    update: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<unknown>>;
    reorder?: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      input: unknown
    ) => Promise<ApiResponse<ChapterMetadata[]>>;
    moveToTrash: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<unknown>>;
  };
  manga?: {
    listPages: (seriesId: string, categoryId: string, chapterId: string) => Promise<ApiResponse<MangaChapterPages>>;
    choosePages: (seriesId: string, categoryId: string, chapterId: string) => Promise<ApiResponse<MangaChapterPages | null>>;
    addDroppedPages: (
      seriesId: string,
      categoryId: string,
      chapterId: string,
      files: File[]
    ) => Promise<ApiResponse<MangaChapterPages>>;
    getPage: (
      seriesId: string,
      categoryId: string,
      chapterId: string,
      pageFileName: string
    ) => Promise<ApiResponse<MangaPageData>>;
    removePages: (
      seriesId: string,
      categoryId: string,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<MangaChapterPages>>;
    reorderPages: (
      seriesId: string,
      categoryId: string,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<MangaChapterPages>>;
  };
  import: {
    chooseSourceFolder: () => Promise<ApiResponse<ImportSource | null>>;
    chooseSourceFiles: () => Promise<ApiResponse<ImportSource | null>>;
    scan: (importSessionId: string) => Promise<ApiResponse<ImportPreview>>;
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

function formatLabel(value: string): string {
  return value.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function nodeKey(node: TreeNode): string {
  if (node.kind === "series") {
    return `series:${node.id}`;
  }

  if (node.kind === "category") {
    return `category:${node.seriesId}:${node.id}`;
  }

  if (node.kind === "volume") {
    return `volume:${node.seriesId}:${node.categoryId}:${node.id}`;
  }

  return `chapter:${node.seriesId}:${node.categoryId}:${node.volumeId ?? "direct"}:${node.id}`;
}

function allNodes(series: SeriesNode[]): TreeNode[] {
  return series.flatMap((seriesNode) => [
    seriesNode,
    ...seriesNode.categories.flatMap((category) => [
      category,
      ...category.directChapters,
      ...category.volumes.flatMap((volume) => [volume, ...volume.chapters])
    ])
  ]);
}

function sameChapterContainer(left: ChapterNode, right: ChapterNode): boolean {
  return left.seriesId === right.seriesId && left.categoryId === right.categoryId && left.volumeId === right.volumeId;
}

function chapterSiblings(series: SeriesNode[], chapter: ChapterNode): ChapterNode[] {
  return allNodes(series).filter(
    (node): node is ChapterNode => node.kind === "chapter" && sameChapterContainer(node, chapter)
  );
}

function movedChapterOrder(chapters: ChapterNode[], draggedId: string, targetId: string, placement: "before" | "after"): string[] {
  const nextOrder = chapters.map((chapter) => chapter.id).filter((chapterId) => chapterId !== draggedId);
  const targetIndex = nextOrder.indexOf(targetId);

  if (targetIndex < 0) {
    return chapters.map((chapter) => chapter.id);
  }

  nextOrder.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, draggedId);
  return nextOrder;
}

function mergeOrderedChapters(chapters: ChapterNode[], orderedMetadata: ChapterMetadata[]): ChapterNode[] {
  const chaptersById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  return orderedMetadata
    .map((metadata) => {
      const chapter = chaptersById.get(metadata.id);
      return chapter ? { ...chapter, ...metadata } : null;
    })
    .filter((chapter): chapter is ChapterNode => !!chapter);
}

function replaceChapterOrder(series: SeriesNode[], target: ChapterNode, orderedMetadata: ChapterMetadata[]): SeriesNode[] {
  return series.map((seriesNode) => {
    if (seriesNode.id !== target.seriesId) {
      return seriesNode;
    }

    return {
      ...seriesNode,
      categories: seriesNode.categories.map((category) => {
        if (category.id !== target.categoryId) {
          return category;
        }

        if (target.volumeId === null) {
          return { ...category, directChapters: mergeOrderedChapters(category.directChapters, orderedMetadata) };
        }

        return {
          ...category,
          volumes: category.volumes.map((volume) =>
            volume.id === target.volumeId
              ? { ...volume, chapters: mergeOrderedChapters(volume.chapters, orderedMetadata) }
              : volume
          )
        };
      })
    };
  });
}

async function loadCategory(api: RendererApi, seriesId: string, category: CategoryMetadata): Promise<CategoryNode> {
  if (category.type === "manga") {
    return {
      ...category,
      kind: "category",
      seriesId,
      volumes: [],
      directChapters: unwrap(await api.chapters.list(seriesId, category.id, null)).map((chapter) => ({
        ...chapter,
        kind: "chapter",
        seriesId,
        categoryId: category.id,
        categoryType: category.type,
        volumeId: null
      }))
    };
  }

  const volumes = unwrap(await api.volumes.list(seriesId, category.id));
  const volumeNodes = await Promise.all(
    volumes.map(async (volume): Promise<VolumeNode> => ({
      ...volume,
      kind: "volume",
      seriesId,
      categoryId: category.id,
      chapters: unwrap(await api.chapters.list(seriesId, category.id, volume.id)).map((chapter) => ({
        ...chapter,
        kind: "chapter",
        seriesId,
        categoryId: category.id,
        categoryType: category.type,
        volumeId: volume.id
      }))
    }))
  );
  const directChapters =
    category.type === "web-novel"
      ? unwrap(await api.chapters.list(seriesId, category.id, null)).map((chapter) => ({
          ...chapter,
          kind: "chapter" as const,
          seriesId,
          categoryId: category.id,
          categoryType: category.type,
          volumeId: null
        }))
      : [];

  return { ...category, kind: "category", seriesId, volumes: volumeNodes, directChapters };
}

async function loadTree(api: RendererApi): Promise<SeriesNode[]> {
  const series = unwrap(await api.series.list());

  return Promise.all(
    series.map(async (seriesNode): Promise<SeriesNode> => ({
      ...seriesNode,
      kind: "series",
      categories: await Promise.all(
        unwrap(await api.categories.list(seriesNode.id)).map((category) => loadCategory(api, seriesNode.id, category))
      )
    }))
  );
}

export default function Manager({ library, onOpenSettings }: ManagerProps) {
  const [tree, setTree] = useState<TreeState>({ loading: false, series: [], error: null });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<ManagerFormState | null>(null);
  const [importPanel, setImportPanel] = useState<ManagerImportState | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [draggedChapter, setDraggedChapter] = useState<ChapterNode | null>(null);
  const [dropTarget, setDropTarget] = useState<ChapterDropState | null>(null);
  const [treePaneWidth, setTreePaneWidth] = useState(38);
  const [resizing, setResizing] = useState(false);
  const managerLayoutRef = useRef<HTMLElement | null>(null);
  const api = getApi();
  const nodes = allNodes(tree.series);
  const selectedNode = nodes.find((node) => nodeKey(node) === selectedKey) ?? null;
  const menuNode = nodes.find((node) => nodeKey(node) === contextMenu?.nodeKey) ?? null;

  async function refreshTree(options: { quiet?: boolean } = {}): Promise<void> {
    if (!api || !library.path) {
      return;
    }

    if (!options.quiet) {
      setTree((current) => ({ ...current, loading: true, error: null }));
    }

    try {
      setTree({ loading: false, series: await loadTree(api), error: null });
    } catch (error) {
      setTree({ loading: false, series: [], error: String(error) });
    }
  }

  useEffect(() => {
    if (!library.path) {
      setTree({ loading: false, series: [], error: null });
      setExpandedKeys(new Set());
      return;
    }

    setExpandedKeys(new Set());
    void refreshTree();
  }, [library.path]);

  function toggleExpanded(key: string): void {
    setExpandedKeys((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }

  function startPanelResize(event: PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setResizing(true);

    const handlePointerMove = (moveEvent: globalThis.PointerEvent): void => {
      const rect = managerLayoutRef.current?.getBoundingClientRect();

      if (!rect) {
        return;
      }

      const nextWidth = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setTreePaneWidth(Math.min(65, Math.max(24, nextWidth)));
    };

    const stopResize = (): void => {
      setResizing(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
  }

  async function reorderChapters(
    dragged: ChapterNode | null,
    target: ChapterNode,
    placement: "before" | "after"
  ): Promise<void> {
    if (!api || !dragged || dragged.id === target.id) {
      return;
    }

    const reorder = api.chapters.reorder;

    if (typeof reorder !== "function") {
      setActionError("Restart the app to load the latest Manager API.");
      return;
    }

    if (!sameChapterContainer(dragged, target)) {
      setActionError("Drag chapters inside the same volume/category for now.");
      return;
    }

    const siblings = chapterSiblings(tree.series, target);
    const chapterOrder = movedChapterOrder(siblings, dragged.id, target.id, placement);

    if (chapterOrder.join("|") === siblings.map((chapter) => chapter.id).join("|")) {
      return;
    }

    setContextMenu(null);
    setActionError(null);

    try {
      const orderedChapters = unwrap(await reorder(target.seriesId, target.categoryId, target.volumeId, { chapterOrder }));
      setTree((current) => ({ ...current, series: replaceChapterOrder(current.series, target, orderedChapters) }));
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function runAction(action: ManagerAction["run"]): Promise<void> {
    setContextMenu(null);
    setActionError(null);

    try {
      const shouldRefresh = await action();
      if (shouldRefresh !== false) {
        await refreshTree();
      }
    } catch (error) {
      setActionError(String(error));
    }
  }

  function openForm(
    heading: string,
    label: string,
    title: string,
    submit: ManagerFormState["submit"],
    categoryType: CategoryType | null = null
  ): void {
    setImportPanel(null);
    setForm({ heading, label, title, categoryType, submit });
  }

  async function openImport(heading: string, target: ImportTargetPreset, sourceKind: "folder" | "files" = "folder"): Promise<void> {
    if (!api) {
      throw new Error("App API is unavailable. Restart the app or check the preload script.");
    }

    const source = unwrap(
      await (sourceKind === "files" ? api.import.chooseSourceFiles() : api.import.chooseSourceFolder())
    );
    if (!source) {
      return;
    }

    const preview = unwrap(await api.import.scan(source.importSessionId));
    setForm(null);
    setImportPanel({ heading, preview, source, target });
  }

  async function submitForm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!form) {
      return;
    }

    const title = form.title.trim();
    if (!title) {
      return;
    }

    await runAction(async () => {
      await form.submit(title, form.categoryType);
      setForm(null);
    });
  }

  function actionsFor(node: TreeNode | null): ManagerAction[] {
    if (!api) {
      return [];
    }

    if (!node) {
      return [
        {
          label: "Add series",
          run: async () => {
            await openImport("Import new series", { mode: "new", label: "New series from selected folder" });
            return false;
          }
        },
        {
          label: "Add empty series",
          run: async () => {
            openForm("Add series", "Series title", "", async (title) => {
              unwrap(await api.series.create({ title }));
            });
            return false;
          }
        }
      ];
    }

    if (node.kind === "series") {
      return [
        {
          label: "Add category",
          run: async () => {
            openForm(
              "Add category",
              "Category title",
              "Light Novel",
              async (title, categoryType) => {
                unwrap(await api.categories.create(node.id, { title, type: categoryType ?? "light-novel" }));
              },
              "light-novel"
            );
            return false;
          }
        },
        {
          label: "Rename",
          run: async () => {
            openForm("Rename series", "Series title", node.title, async (title) => {
              unwrap(await api.series.update(node.id, { title }));
            });
            return false;
          }
        },
        {
          label: "Move to trash",
          run: async () => {
            if (window.confirm(`Move "${node.title}" to trash?`)) {
              unwrap(await api.series.moveToTrash(node.id));
              setSelectedKey(null);
              setForm(null);
              setImportPanel(null);
            }
          }
        }
      ];
    }

    if (node.kind === "category") {
      const actions: ManagerAction[] = [];

      if (node.type !== "manga") {
        actions.push({
          label: node.type === "web-novel" ? "Import chapters" : "Import volumes/chapters",
          run: async () => {
            await openImport(
              `Import into ${node.title}`,
              {
                mode: "existing",
                seriesId: node.seriesId,
                categoryId: node.id,
                volumeMode: node.type === "web-novel" ? "none" : "source",
                volumeId: null,
                label: `${node.title} (${formatLabel(node.type)})`
              },
              node.type === "web-novel" ? "files" : "folder"
            );
            return false;
          }
        });
        actions.push({
          label: "Add empty volume",
          run: async () => {
            openForm("Add volume", "Volume title", `Volume ${node.volumes.length + 1}`, async (title) => {
              unwrap(await api.volumes.create(node.seriesId, node.id, { title }));
            });
            return false;
          }
        });
      }

      if (node.type === "web-novel" || node.type === "manga") {
        actions.push({
          label: "Add empty chapter",
          run: async () => {
            openForm("Add chapter", "Chapter title", `Chapter ${node.directChapters.length + 1}`, async (title) => {
              unwrap(await api.chapters.create(node.seriesId, node.id, null, { title }));
            });
            return false;
          }
        });
      }

      return [
        ...actions,
        {
          label: "Rename",
          run: async () => {
            openForm("Rename category", "Category title", node.title, async (title) => {
              unwrap(await api.categories.update(node.seriesId, node.id, { title }));
            });
            return false;
          }
        },
        {
          label: "Move to trash",
          run: async () => {
            if (window.confirm(`Move "${node.title}" to trash?`)) {
              unwrap(await api.categories.moveToTrash(node.seriesId, node.id));
              setSelectedKey(null);
              setForm(null);
              setImportPanel(null);
            }
          }
        }
      ];
    }

    if (node.kind === "volume") {
      return [
        {
          label: "Import chapters",
          run: async () => {
            await openImport(
              `Import into ${node.title}`,
              {
                mode: "existing",
                seriesId: node.seriesId,
                categoryId: node.categoryId,
                volumeMode: "existing",
                volumeId: node.id,
                label: node.title
              },
              "files"
            );
            return false;
          }
        },
        {
          label: "Add empty chapter",
          run: async () => {
            openForm("Add chapter", "Chapter title", `Chapter ${node.chapters.length + 1}`, async (title) => {
              unwrap(await api.chapters.create(node.seriesId, node.categoryId, node.id, { title }));
            });
            return false;
          }
        },
        {
          label: "Rename",
          run: async () => {
            openForm("Rename volume", "Volume title", node.title, async (title) => {
              unwrap(await api.volumes.update(node.seriesId, node.categoryId, node.id, { title }));
            });
            return false;
          }
        },
        {
          label: "Move to trash",
          run: async () => {
            if (window.confirm(`Move "${node.title}" to trash?`)) {
              unwrap(await api.volumes.moveToTrash(node.seriesId, node.categoryId, node.id));
              setSelectedKey(null);
              setForm(null);
              setImportPanel(null);
            }
          }
        }
      ];
    }

    return [
      {
        label: "Rename",
        run: async () => {
          openForm("Rename chapter", "Chapter title", node.title, async (title) => {
            unwrap(await api.chapters.update(node.seriesId, node.categoryId, node.volumeId, node.id, { title }));
          });
          return false;
        }
      },
      {
        label: "Move to trash",
        run: async () => {
          if (window.confirm(`Move "${node.title}" to trash?`)) {
            unwrap(await api.chapters.moveToTrash(node.seriesId, node.categoryId, node.volumeId, node.id));
            setSelectedKey(null);
            setForm(null);
            setImportPanel(null);
          }
        }
      }
    ];
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

  if (!api) {
    return (
      <section className="empty-state">
        <h2>Manager unavailable</h2>
        <p>App API is unavailable. Restart the app or check the preload script.</p>
      </section>
    );
  }

  if (tree.loading) {
    return (
      <section className="empty-state">
        <h2>Loading Manager</h2>
        <p>Reading series, categories, volumes, and chapters.</p>
      </section>
    );
  }

  if (tree.error) {
    return (
      <section className="empty-state">
        <h2>Could not load Manager</h2>
        <p>{tree.error}</p>
      </section>
    );
  }

  const selectedActions = actionsFor(selectedNode);

  return (
    <section
      className={resizing ? "manager-layout manager-layout-resizing" : "manager-layout"}
      onClick={() => setContextMenu(null)}
      ref={managerLayoutRef}
      style={{ "--manager-tree-width": `${treePaneWidth}%` } as CSSProperties}
    >
      <aside className="manager-tree-panel">
        <div className="manager-panel-header">
          <h2>Tree</h2>
          <button className="primary-action" onClick={() => void runAction(actionsFor(null)[0].run)} type="button">
            Add series
          </button>
        </div>

        {tree.series.length === 0 ? (
          <section className="empty-state manager-empty">
            <h2>No series yet</h2>
            <p>Add a series to start building the Library tree.</p>
          </section>
        ) : (
          <div className="manager-tree" role="tree">
            {tree.series.map((seriesNode) => (
              <SeriesTreeItem
                key={seriesNode.id}
                node={seriesNode}
                onContextMenu={(event, node) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedKey(nodeKey(node));
                  setContextMenu({ x: event.clientX, y: event.clientY, nodeKey: nodeKey(node) });
                }}
                onSelect={(node) => setSelectedKey(nodeKey(node))}
                expandedKeys={expandedKeys}
                onToggle={toggleExpanded}
                draggedChapter={draggedChapter}
                dropTarget={dropTarget}
                onChapterDragEnd={() => {
                  setDraggedChapter(null);
                  setDropTarget(null);
                }}
                onChapterDragOver={(event, node) => {
                  if (!draggedChapter || !sameChapterContainer(draggedChapter, node) || draggedChapter.id === node.id) {
                    return;
                  }

                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                  setDropTarget({ nodeKey: nodeKey(node), placement });
                }}
                onChapterDragStart={(event, node) => {
                  setDraggedChapter(node);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", nodeKey(node));
                }}
                onChapterDrop={(event, node) => {
                  event.preventDefault();
                  const placement = dropTarget?.nodeKey === nodeKey(node) ? dropTarget.placement : "before";
                  void reorderChapters(draggedChapter, node, placement).finally(() => {
                    setDraggedChapter(null);
                    setDropTarget(null);
                  });
                }}
                selectedKey={selectedKey}
              />
            ))}
          </div>
        )}
      </aside>

      <button
        aria-label="Resize Manager panels"
        className="manager-resize-handle"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={startPanelResize}
        type="button"
      />

      <section className="manager-detail-panel">
        <h2>{selectedNode ? selectedNode.title : "Select an item"}</h2>
        <p>{selectedNode ? nodeDescription(selectedNode) : "Right-click a tree item for quick actions."}</p>

        {actionError ? <p className="error-text">{actionError}</p> : null}

        {!importPanel && !form && selectedNode?.kind === "chapter" && selectedNode.categoryType === "manga" ? (
          <MangaPageManager chapter={selectedNode} onChanged={refreshTree} />
        ) : null}

        {importPanel ? (
          <div className="manager-import-panel">
            <div className="manager-panel-header">
              <h3>{importPanel.heading}</h3>
              <button onClick={() => setImportPanel(null)} type="button">
                Close
              </button>
            </div>
            <ImportWizard
              key={importPanel.source.importSessionId}
              initialPreview={importPanel.preview}
              initialSource={importPanel.source}
              library={library}
              onCancel={() => setImportPanel(null)}
              onImported={() => void refreshTree({ quiet: true })}
              onOpenSettings={onOpenSettings}
              targetPreset={importPanel.target}
            />
          </div>
        ) : form ? (
          <form className="manager-form" onSubmit={(event) => void submitForm(event)}>
            <h3>{form.heading}</h3>
            {form.categoryType ? (
              <label>
                <span>Category type</span>
                <select
                  value={form.categoryType}
                  onChange={(event) =>
                    setForm((current) =>
                      current ? { ...current, categoryType: event.target.value as CategoryType } : current
                    )
                  }
                >
                  <option value="light-novel">Light Novel</option>
                  <option value="web-novel">Web Novel</option>
                  <option value="manga">Manga</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>{form.label}</span>
              <input
                autoFocus
                value={form.title}
                onChange={(event) =>
                  setForm((current) => (current ? { ...current, title: event.target.value } : current))
                }
              />
            </label>
            <div className="manager-actions">
              <button className="primary-action" disabled={!form.title.trim()} type="submit">
                Save
              </button>
              <button onClick={() => setForm(null)} type="button">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="manager-actions">
            {(selectedNode ? selectedActions : actionsFor(null)).map((action) => (
              <button key={action.label} onClick={() => void runAction(action.run)} type="button">
                {action.label}
              </button>
            ))}
          </div>
        )}
      </section>

      {contextMenu ? (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {actionsFor(menuNode).map((action) => (
            <button key={action.label} onClick={() => void runAction(action.run)} type="button">
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function nodeDescription(node: TreeNode): string {
  if (node.kind === "series") {
    return `Series - ${formatLabel(node.status)}`;
  }

  if (node.kind === "category") {
    return `Category - ${formatLabel(node.type)}`;
  }

  if (node.kind === "volume") {
    return "Volume";
  }

  if (node.categoryType === "manga") {
    return `Manga chapter - ${node.pageCount ?? 0} pages`;
  }

  return `Chapter - ${formatLabel(node.translationStatus ?? "draft")}`;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) {
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function MangaPageManager({ chapter, onChanged }: { chapter: ChapterNode; onChanged: () => Promise<void> }) {
  const [checked, setChecked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState<MangaChapterPages | null>(null);
  const [preview, setPreview] = useState<MangaPageData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedPage, setSelectedPage] = useState<string | null>(null);
  const api = getApi();

  async function loadPages(): Promise<void> {
    if (!api?.manga) {
      setError("Manga API is unavailable. Restart the app or check the preload script.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const nextPages = unwrap(await api.manga.listPages(chapter.seriesId, chapter.categoryId, chapter.id));
      setPages(nextPages);
      setSelectedPage((current) =>
        current && nextPages.pages.some((page) => page.fileName === current) ? current : nextPages.pages[0]?.fileName ?? null
      );
      setChecked((current) => current.filter((fileName) => nextPages.pages.some((page) => page.fileName === fileName)));
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPages();
  }, [chapter.seriesId, chapter.categoryId, chapter.id]);

  useEffect(() => {
    let isMounted = true;

    if (!api?.manga || !selectedPage) {
      setPreview(null);
      return;
    }

    setPreviewLoading(true);
    void api.manga
      .getPage(chapter.seriesId, chapter.categoryId, chapter.id, selectedPage)
      .then((response) => {
        if (isMounted) {
          setPreview(unwrap(response));
        }
      })
      .catch((previewError) => {
        if (isMounted) {
          setError(String(previewError));
          setPreview(null);
        }
      })
      .finally(() => {
        if (isMounted) {
          setPreviewLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [chapter.seriesId, chapter.categoryId, chapter.id, selectedPage]);

  async function applyPages(action: () => Promise<MangaChapterPages | null>): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      const nextPages = await action();
      if (nextPages) {
        setPages(nextPages);
        setSelectedPage((current) =>
          current && nextPages.pages.some((page) => page.fileName === current) ? current : nextPages.pages[0]?.fileName ?? null
        );
        setChecked((current) => current.filter((fileName) => nextPages.pages.some((page) => page.fileName === fileName)));
        await onChanged();
      }
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setLoading(false);
    }
  }

  async function addPages(): Promise<void> {
    if (!api?.manga) {
      setError("Manga API is unavailable. Restart the app or check the preload script.");
      return;
    }

    await applyPages(() => api.manga!.choosePages(chapter.seriesId, chapter.categoryId, chapter.id).then(unwrap));
  }

  async function addDroppedPages(files: File[]): Promise<void> {
    if (!api?.manga || files.length === 0) {
      return;
    }

    await applyPages(() => api.manga!.addDroppedPages(chapter.seriesId, chapter.categoryId, chapter.id, files).then(unwrap));
  }

  async function removeCheckedPages(): Promise<void> {
    if (!api?.manga || checked.length === 0) {
      return;
    }

    if (!window.confirm(`Remove ${checked.length} page(s) from "${chapter.title}"?`)) {
      return;
    }

    await applyPages(() =>
      api.manga!.removePages(chapter.seriesId, chapter.categoryId, chapter.id, { fileNames: checked }).then(unwrap)
    );
  }

  async function movePage(fileName: string, offset: number): Promise<void> {
    if (!api?.manga || !pages) {
      return;
    }

    const index = pages.pages.findIndex((page) => page.fileName === fileName);
    const nextIndex = index + offset;

    if (index < 0 || nextIndex < 0 || nextIndex >= pages.pages.length) {
      return;
    }

    const pageOrder = pages.pages.map((page) => page.fileName);
    [pageOrder[index], pageOrder[nextIndex]] = [pageOrder[nextIndex], pageOrder[index]];
    await applyPages(() => api.manga!.reorderPages(chapter.seriesId, chapter.categoryId, chapter.id, { pageOrder }).then(unwrap));
  }

  function toggleChecked(fileName: string): void {
    setChecked((current) =>
      current.includes(fileName) ? current.filter((item) => item !== fileName) : [...current, fileName]
    );
  }

  return (
    <section
      className="manga-page-manager"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void addDroppedPages(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="manga-page-manager-header">
        <div>
          <h3>Pages</h3>
          <p>
            {pages
              ? `${pages.pages.length} page(s), ${formatBytes(pages.chapter.totalSizeBytes ?? 0)}`
              : "Load manga pages."}
          </p>
        </div>
        <div className="manager-actions">
          <button disabled={loading} onClick={() => void addPages()} type="button">
            Add pages
          </button>
          <button disabled={loading || checked.length === 0} onClick={() => void removeCheckedPages()} type="button">
            Remove selected
          </button>
        </div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {loading && !pages ? <p className="muted-text">Loading pages...</p> : null}

      {pages && pages.pages.length === 0 ? <p className="muted-text">No pages yet.</p> : null}

      {pages && pages.pages.length > 0 ? (
        <div className="manga-page-workspace">
          <ol className="manga-page-grid">
            {pages.pages.map((page, index) => (
              <li className={selectedPage === page.fileName ? "manga-page-card manga-page-card-active" : "manga-page-card"} key={page.fileName}>
                <label className="manga-page-check">
                  <input
                    checked={checked.includes(page.fileName)}
                    onChange={() => toggleChecked(page.fileName)}
                    type="checkbox"
                  />
                  <span>Page {index + 1}</span>
                </label>
                <button className="manga-page-thumb" onClick={() => setSelectedPage(page.fileName)} type="button">
                  {page.thumbnailDataUrl ? <img alt={`Page ${index + 1}`} loading="lazy" src={page.thumbnailDataUrl} /> : <span>No preview</span>}
                </button>
                <small>{formatBytes(page.sizeBytes)}</small>
                <div className="manager-actions">
                  <button disabled={index === 0 || loading} onClick={() => void movePage(page.fileName, -1)} type="button">
                    Up
                  </button>
                  <button disabled={index === pages.pages.length - 1 || loading} onClick={() => void movePage(page.fileName, 1)} type="button">
                    Down
                  </button>
                </div>
              </li>
            ))}
          </ol>

          <aside className="manga-page-preview">
            <h3>Preview</h3>
            {previewLoading ? <p className="muted-text">Loading preview...</p> : null}
            {preview ? <img alt={preview.fileName} src={preview.dataUrl} /> : <p className="muted-text">Select a page.</p>}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

type TreeItemSharedProps = {
  draggedChapter: ChapterNode | null;
  dropTarget: ChapterDropState | null;
  expandedKeys: Set<string>;
  onChapterDragEnd: () => void;
  onChapterDragOver: (event: DragEvent<HTMLButtonElement>, node: ChapterNode) => void;
  onChapterDragStart: (event: DragEvent<HTMLButtonElement>, node: ChapterNode) => void;
  onChapterDrop: (event: DragEvent<HTMLButtonElement>, node: ChapterNode) => void;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  onToggle: (key: string) => void;
  selectedKey: string | null;
};

function TreeButton({
  expanded,
  hasChildren = false,
  node,
  onChapterDragEnd,
  onChapterDragOver,
  onChapterDragStart,
  onChapterDrop,
  onContextMenu,
  onSelect,
  onToggle,
  selectedKey,
  dropTarget
}: TreeItemSharedProps & {
  expanded?: boolean;
  hasChildren?: boolean;
  node: TreeNode;
}) {
  const key = nodeKey(node);
  const isChapter = node.kind === "chapter";
  const dropClass =
    dropTarget?.nodeKey === key ? ` tree-node-drop-${dropTarget.placement}` : "";

  return (
    <div className="tree-row">
      {hasChildren ? (
        <button
          aria-label={expanded ? "Collapse item" : "Expand item"}
          aria-expanded={expanded}
          className="tree-caret"
          onClick={(event) => {
            event.stopPropagation();
            onToggle(key);
          }}
          type="button"
        >
          <span className="tree-caret-icon" aria-hidden="true" />
        </button>
      ) : (
        <span className="tree-caret tree-caret-empty" />
      )}
      <button
        className={`${selectedKey === key ? "tree-node tree-node-active" : "tree-node"}${dropClass}`}
        draggable={isChapter}
        onClick={() => onSelect(node)}
        onContextMenu={(event) => onContextMenu(event, node)}
        onDragEnd={isChapter ? onChapterDragEnd : undefined}
        onDragOver={isChapter ? (event) => onChapterDragOver(event, node) : undefined}
        onDragStart={isChapter ? (event) => onChapterDragStart(event, node) : undefined}
        onDrop={isChapter ? (event) => onChapterDrop(event, node) : undefined}
        type="button"
      >
        <span className={isChapter ? "tree-icon tree-icon-chapter" : "tree-icon tree-icon-folder"} aria-hidden="true" />
        <span>{node.title}</span>
        <small>{node.kind}</small>
      </button>
    </div>
  );
}

function SeriesTreeItem({
  node,
  ...props
}: TreeItemSharedProps & {
  node: SeriesNode;
}) {
  const expanded = props.expandedKeys.has(nodeKey(node));

  return (
    <div className="tree-group" aria-expanded={expanded} role="treeitem">
      <TreeButton {...props} expanded={expanded} hasChildren={node.categories.length > 0} node={node} />
      {expanded ? (
        <div className="tree-children">
          {node.categories.map((category) => (
            <CategoryTreeItem key={category.id} node={category} {...props} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CategoryTreeItem({
  node,
  ...props
}: TreeItemSharedProps & {
  node: CategoryNode;
}) {
  const expanded = props.expandedKeys.has(nodeKey(node));
  const hasChildren = node.directChapters.length > 0 || node.volumes.length > 0;

  return (
    <div className="tree-group" aria-expanded={expanded} role="treeitem">
      <TreeButton {...props} expanded={expanded} hasChildren={hasChildren} node={node} />
      {expanded ? (
        <div className="tree-children">
          {node.directChapters.map((chapter) => (
            <TreeButton key={chapter.id} node={chapter} {...props} />
          ))}
          {node.volumes.map((volume) => (
            <VolumeTreeItem key={volume.id} node={volume} {...props} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VolumeTreeItem({
  node,
  ...props
}: TreeItemSharedProps & {
  node: VolumeNode;
}) {
  const expanded = props.expandedKeys.has(nodeKey(node));

  return (
    <div className="tree-group" aria-expanded={expanded} role="treeitem">
      <TreeButton {...props} expanded={expanded} hasChildren={node.chapters.length > 0} node={node} />
      {expanded ? (
        <div className="tree-children">
          {node.chapters.map((chapter) => (
            <TreeButton key={chapter.id} node={chapter} {...props} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
