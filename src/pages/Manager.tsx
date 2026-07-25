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

type CategoryType = "light-novel" | "web-novel";

type SeriesCard = {
  id: string;
  title: string;
  status: string;
};

type CategoryMetadata = {
  id: string;
  type: string;
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
  categoryType: CategoryType;
  chapters: ChapterNode[];
};

type SupportedCategoryMetadata = CategoryMetadata & {
  type: CategoryType;
};

type CategoryNode = SupportedCategoryMetadata & {
  kind: "category";
  seriesId: string;
  volumes: VolumeNode[];
  directChapters: ChapterNode[];
};

type SeriesNode = SeriesCard & {
  kind: "series";
  categories: CategoryNode[];
  childrenLoaded: boolean;
  childrenLoading: boolean;
  childrenError: string | null;
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

type ChapterFolderNode = CategoryNode | VolumeNode;

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
    move?: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<ChapterMetadata>>;
    moveToTrash: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<unknown>>;
  };
  import: {
    chooseSourceFolder: () => Promise<ApiResponse<ImportSource | null>>;
    chooseSourceFiles: () => Promise<ApiResponse<ImportSource | null>>;
    scan: (importSessionId: string) => Promise<ApiResponse<ImportPreview>>;
  };
  export: {
    chapterPdf: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<{ path: string } | null>>;
    chapterEpub: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<{ path: string } | null>>;
    volumePdf: (
      seriesId: string,
      categoryId: string,
      volumeId: string
    ) => Promise<ApiResponse<{ path: string } | null>>;
    seriesPdf: (seriesId: string) => Promise<ApiResponse<{ path: string } | null>>;
  };
};

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.ok) {
    throw new Error(
      response.error.details ? `${response.error.message} ${String(response.error.details)}` : response.error.message
    );
  }

  return response.data;
}

function formatLabel(value: string): string {
  return value.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function isSupportedCategory(category: CategoryMetadata): category is SupportedCategoryMetadata {
  return category.type === "light-novel" || category.type === "web-novel";
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

function folderTarget(node: ChapterFolderNode): { seriesId: string; categoryId: string; volumeId: string | null } {
  return {
    seriesId: node.seriesId,
    categoryId: node.kind === "category" ? node.id : node.categoryId,
    volumeId: node.kind === "volume" ? node.id : null
  };
}

function canDropChapterInFolder(chapter: ChapterNode | null, folder: ChapterFolderNode): boolean {
  if (!chapter || chapter.seriesId !== folder.seriesId) {
    return false;
  }

  const target = folderTarget(folder);

  if (chapter.categoryId === target.categoryId && chapter.volumeId === target.volumeId) {
    return false;
  }

  return folder.kind === "volume" ? true : folder.type === "web-novel";
}

function canDropChaptersInFolder(chapters: ChapterNode[], folder: ChapterFolderNode): boolean {
  return chapters.length > 0 && chapters.every((chapter) => canDropChapterInFolder(chapter, folder));
}

function canDropChaptersAtChapter(chapters: ChapterNode[], target: ChapterNode): boolean {
  if (chapters.length === 0 || chapters.some((chapter) => chapter.id === target.id)) {
    return false;
  }

  return chapters.every((chapter) => {
    if (chapter.seriesId !== target.seriesId) {
      return false;
    }

    if (sameChapterContainer(chapter, target)) {
      return true;
    }

    return target.volumeId ? true : target.categoryType === "web-novel";
  });
}

function chapterSiblings(series: SeriesNode[], chapter: ChapterNode): ChapterNode[] {
  return allNodes(series).filter(
    (node): node is ChapterNode => node.kind === "chapter" && sameChapterContainer(node, chapter)
  );
}

function placedChapterOrder(chapters: ChapterNode[], draggedIds: string[], targetId: string, placement: "before" | "after"): string[] {
  const movingIds = new Set(draggedIds);
  const nextOrder = chapters.map((chapter) => chapter.id).filter((chapterId) => !movingIds.has(chapterId));
  const targetIndex = nextOrder.indexOf(targetId);

  if (targetIndex < 0) {
    return chapters.map((chapter) => chapter.id);
  }

  nextOrder.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, ...draggedIds);
  return nextOrder;
}

function selectedChapterNodes(series: SeriesNode[], selectedKeys: Set<string>): ChapterNode[] {
  return allNodes(series).filter((node): node is ChapterNode => node.kind === "chapter" && selectedKeys.has(nodeKey(node)));
}

function chapterRangeKeys(series: SeriesNode[], anchor: ChapterNode, target: ChapterNode): string[] {
  if (!sameChapterContainer(anchor, target)) {
    return [nodeKey(target)];
  }

  const siblings = chapterSiblings(series, target);
  const anchorIndex = siblings.findIndex((chapter) => chapter.id === anchor.id);
  const targetIndex = siblings.findIndex((chapter) => chapter.id === target.id);

  if (anchorIndex < 0 || targetIndex < 0) {
    return [nodeKey(target)];
  }

  const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return siblings.slice(start, end + 1).map(nodeKey);
}

async function loadCategory(api: RendererApi, seriesId: string, category: SupportedCategoryMetadata): Promise<CategoryNode> {
  const volumes = unwrap(await api.volumes.list(seriesId, category.id));
  const volumeNodes = await Promise.all(
    volumes.map(async (volume): Promise<VolumeNode> => ({
      ...volume,
      kind: "volume",
      seriesId,
      categoryId: category.id,
      categoryType: category.type,
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

  return series.map((seriesNode): SeriesNode => ({
    ...seriesNode,
    kind: "series",
    categories: [],
    childrenLoaded: false,
    childrenLoading: false,
    childrenError: null
  }));
}

async function loadSeriesChildren(api: RendererApi, seriesNode: SeriesNode): Promise<CategoryNode[]> {
  return Promise.all(
    unwrap(await api.categories.list(seriesNode.id))
      .filter(isSupportedCategory)
      .map((category) => loadCategory(api, seriesNode.id, category))
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
  const [folderDropKey, setFolderDropKey] = useState<string | null>(null);
  const [selectedChapterKeys, setSelectedChapterKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);
  const [treePaneWidth, setTreePaneWidth] = useState(38);
  const [resizing, setResizing] = useState(false);
  const managerLayoutRef = useRef<HTMLElement | null>(null);
  const api = getApi();
  const nodes = allNodes(tree.series);
  const selectedNode = nodes.find((node) => nodeKey(node) === selectedKey) ?? null;
  const menuNode = nodes.find((node) => nodeKey(node) === contextMenu?.nodeKey) ?? null;
  const selectedChapters = selectedChapterNodes(tree.series, selectedChapterKeys);

  async function refreshTree(options: { quiet?: boolean } = {}): Promise<void> {
    if (!api || !library.path) {
      return;
    }

    if (!options.quiet) {
      setTree((current) => ({ ...current, loading: true, error: null }));
    }

    try {
      const rootSeries = await loadTree(api);
      const expandedSeriesIds = new Set(
        Array.from(expandedKeys)
          .filter((key) => key.startsWith("series:"))
          .map((key) => key.slice("series:".length))
      );
      const series = await Promise.all(
        rootSeries.map(async (seriesNode) =>
          expandedSeriesIds.has(seriesNode.id)
            ? {
                ...seriesNode,
                categories: await loadSeriesChildren(api, seriesNode),
                childrenLoaded: true
              }
            : seriesNode
        )
      );
      setTree({ loading: false, series, error: null });
    } catch (error) {
      setTree({ loading: false, series: [], error: String(error) });
    }
  }

  async function ensureSeriesChildren(seriesId: string): Promise<void> {
    if (!api) {
      return;
    }

    const currentSeries = tree.series.find((seriesNode) => seriesNode.id === seriesId);
    if (!currentSeries || currentSeries.childrenLoaded || currentSeries.childrenLoading) {
      return;
    }

    setTree((current) => ({
      ...current,
      series: current.series.map((seriesNode) =>
        seriesNode.id === seriesId ? { ...seriesNode, childrenLoading: true, childrenError: null } : seriesNode
      )
    }));

    try {
      const categories = await loadSeriesChildren(api, currentSeries);
      setTree((current) => ({
        ...current,
        series: current.series.map((seriesNode) =>
          seriesNode.id === seriesId
            ? { ...seriesNode, categories, childrenLoaded: true, childrenLoading: false, childrenError: null }
            : seriesNode
        )
      }));
    } catch (error) {
      setTree((current) => ({
        ...current,
        series: current.series.map((seriesNode) =>
          seriesNode.id === seriesId ? { ...seriesNode, childrenLoading: false, childrenError: String(error) } : seriesNode
        )
      }));
    }
  }

  useEffect(() => {
    if (!library.path) {
      setTree({ loading: false, series: [], error: null });
      setExpandedKeys(new Set());
      setSelectedChapterKeys(new Set());
      setSelectionAnchorKey(null);
      return;
    }

    setExpandedKeys(new Set());
    setSelectedChapterKeys(new Set());
    setSelectionAnchorKey(null);
    void refreshTree();
  }, [library.path]);

  function selectTreeNode(event: MouseEvent<HTMLButtonElement>, node: TreeNode): void {
    const key = nodeKey(node);
    setSelectedKey(key);

    if (node.kind !== "chapter") {
      setSelectedChapterKeys(new Set());
      setSelectionAnchorKey(null);
      return;
    }

    if (event.shiftKey && selectionAnchorKey) {
      const anchor = nodes.find(
        (item): item is ChapterNode => item.kind === "chapter" && nodeKey(item) === selectionAnchorKey
      );
      const rangeKeys = anchor ? chapterRangeKeys(tree.series, anchor, node) : [key];

      setSelectedChapterKeys((current) => {
        const next = event.ctrlKey || event.metaKey ? new Set(current) : new Set<string>();
        rangeKeys.forEach((rangeKey) => next.add(rangeKey));
        return next;
      });
      return;
    }

    setSelectionAnchorKey(key);

    if (event.ctrlKey || event.metaKey) {
      setSelectedChapterKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      return;
    }

    setSelectedChapterKeys(new Set([key]));
  }

  function draggedChaptersFor(dragged: ChapterNode | null): ChapterNode[] {
    if (!dragged) {
      return [];
    }

    return selectedChapterKeys.has(nodeKey(dragged)) ? selectedChapters : [dragged];
  }

  function toggleExpanded(key: string): void {
    const shouldLoadSeriesId = key.startsWith("series:") && !expandedKeys.has(key) ? key.slice("series:".length) : null;

    setExpandedKeys((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });

    if (shouldLoadSeriesId) {
      void ensureSeriesChildren(shouldLoadSeriesId);
    }
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

  async function moveChaptersToPosition(
    dragged: ChapterNode | null,
    targetChapter: ChapterNode,
    placement: "before" | "after"
  ): Promise<void> {
    const chapters = draggedChaptersFor(dragged);

    if (!api || chapters.length === 0) {
      return;
    }

    const move = api.chapters.move;
    const reorder = api.chapters.reorder;

    if (typeof move !== "function" || typeof reorder !== "function") {
      setActionError("Restart the app to load the latest Manager API.");
      return;
    }

    if (!canDropChaptersAtChapter(chapters, targetChapter)) {
      return;
    }

    const movingIds = chapters.map((chapter) => chapter.id);
    const chapterOrder = placedChapterOrder(chapterSiblings(tree.series, targetChapter), movingIds, targetChapter.id, placement);
    const nextSelectedKeys = chapters.map(
      (chapter) =>
        `chapter:${chapter.seriesId}:${targetChapter.categoryId}:${targetChapter.volumeId ?? "direct"}:${chapter.id}`
    );
    const nextSelectedKey = nextSelectedKeys[nextSelectedKeys.length - 1] ?? null;

    setContextMenu(null);
    setActionError(null);

    try {
      for (const chapter of chapters) {
        if (sameChapterContainer(chapter, targetChapter)) {
          continue;
        }

        unwrap(
          await move(chapter.seriesId, chapter.categoryId, chapter.volumeId, chapter.id, {
            targetCategoryId: targetChapter.categoryId,
            targetVolumeId: targetChapter.volumeId
          })
        );
      }

      unwrap(await reorder(targetChapter.seriesId, targetChapter.categoryId, targetChapter.volumeId, { chapterOrder }));
      await refreshTree({ quiet: true });
      setSelectedChapterKeys(new Set(nextSelectedKeys));
      setSelectionAnchorKey(nextSelectedKey);
      setSelectedKey(nextSelectedKey);
    } catch (error) {
      setActionError(String(error));
    }
  }

  async function moveChaptersToFolder(dragged: ChapterNode | null, folder: ChapterFolderNode): Promise<void> {
    const chapters = draggedChaptersFor(dragged);

    if (!api || chapters.length === 0) {
      return;
    }

    const move = api.chapters.move;

    if (typeof move !== "function") {
      setActionError("Restart the app to load the latest Manager API.");
      return;
    }

    if (!canDropChaptersInFolder(chapters, folder)) {
      return;
    }

    const target = folderTarget(folder);
    const nextSelectedKeys = chapters.map(
      (chapter) => `chapter:${chapter.seriesId}:${target.categoryId}:${target.volumeId ?? "direct"}:${chapter.id}`
    );
    const nextSelectedKey = nextSelectedKeys[nextSelectedKeys.length - 1] ?? null;

    setContextMenu(null);
    setActionError(null);

    try {
      for (const chapter of chapters) {
        unwrap(
          await move(chapter.seriesId, chapter.categoryId, chapter.volumeId, chapter.id, {
            targetCategoryId: target.categoryId,
            targetVolumeId: target.volumeId
          })
        );
      }
      setExpandedKeys((current) => new Set(current).add(nodeKey(folder)));
      await refreshTree({ quiet: true });
      setSelectedChapterKeys(new Set(nextSelectedKeys));
      setSelectionAnchorKey(nextSelectedKey);
      setSelectedKey(nextSelectedKey);
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
          label: "Export PDF",
          run: async () => {
            unwrap(await api.export.seriesPdf(node.id));
            return false;
          }
        },
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

      if (node.type === "web-novel") {
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
          label: "Export PDF",
          run: async () => {
            unwrap(await api.export.volumePdf(node.seriesId, node.categoryId, node.id));
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
        label: "Export PDF",
        run: async () => {
          unwrap(await api.export.chapterPdf(node.seriesId, node.categoryId, node.volumeId, node.id));
          return false;
        }
      },
      {
        label: "Export EPUB",
        run: async () => {
          unwrap(await api.export.chapterEpub(node.seriesId, node.categoryId, node.volumeId, node.id));
          return false;
        }
      },
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
                  const key = nodeKey(node);
                  if (node.kind === "chapter") {
                    if (!selectedChapterKeys.has(key)) {
                      setSelectedChapterKeys(new Set([key]));
                    }
                    setSelectionAnchorKey(key);
                  } else if (node.kind === "series") {
                    setSelectedChapterKeys(new Set());
                    setSelectionAnchorKey(null);
                  }
                  setSelectedKey(key);
                  setContextMenu({ x: event.clientX, y: event.clientY, nodeKey: nodeKey(node) });
                }}
                onSelect={selectTreeNode}
                expandedKeys={expandedKeys}
                onToggle={toggleExpanded}
                draggedChapter={draggedChapter}
                dropTarget={dropTarget}
                folderDropKey={folderDropKey}
                onChapterDragEnd={() => {
                  setDraggedChapter(null);
                  setDropTarget(null);
                  setFolderDropKey(null);
                }}
                onChapterDragOver={(event, node) => {
                  const draggedChapters = draggedChaptersFor(draggedChapter);
                  if (!draggedChapter || !canDropChaptersAtChapter(draggedChapters, node)) {
                    return;
                  }

                  event.preventDefault();
                  setFolderDropKey(null);
                  const rect = event.currentTarget.getBoundingClientRect();
                  const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
                  setDropTarget({ nodeKey: nodeKey(node), placement });
                }}
                onChapterDragStart={(event, node) => {
                  const key = nodeKey(node);
                  if (!selectedChapterKeys.has(key)) {
                    setSelectedChapterKeys(new Set([key]));
                    setSelectionAnchorKey(key);
                    setSelectedKey(key);
                  }
                  setDraggedChapter(node);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", nodeKey(node));
                }}
                onChapterDrop={(event, node) => {
                  event.preventDefault();
                  const placement = dropTarget?.nodeKey === nodeKey(node) ? dropTarget.placement : "before";
                  void moveChaptersToPosition(draggedChapter, node, placement).finally(() => {
                    setDraggedChapter(null);
                    setDropTarget(null);
                  });
                }}
                onFolderDragLeave={(node) => {
                  if (folderDropKey === nodeKey(node)) {
                    setFolderDropKey(null);
                  }
                }}
                onFolderDragOver={(event, node) => {
                  if (!canDropChaptersInFolder(draggedChaptersFor(draggedChapter), node)) {
                    return;
                  }

                  event.preventDefault();
                  setDropTarget(null);
                  setFolderDropKey(nodeKey(node));
                }}
                onFolderDrop={(event, node) => {
                  event.preventDefault();
                  void moveChaptersToFolder(draggedChapter, node).finally(() => {
                    setDraggedChapter(null);
                    setDropTarget(null);
                    setFolderDropKey(null);
                  });
                }}
                selectedKey={selectedKey}
                selectedChapterKeys={selectedChapterKeys}
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

  return `Chapter - ${formatLabel(node.translationStatus ?? "draft")}`;
}

type TreeItemSharedProps = {
  draggedChapter: ChapterNode | null;
  dropTarget: ChapterDropState | null;
  expandedKeys: Set<string>;
  folderDropKey: string | null;
  onChapterDragEnd: () => void;
  onChapterDragOver: (event: DragEvent<HTMLButtonElement>, node: ChapterNode) => void;
  onChapterDragStart: (event: DragEvent<HTMLButtonElement>, node: ChapterNode) => void;
  onChapterDrop: (event: DragEvent<HTMLButtonElement>, node: ChapterNode) => void;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onFolderDragLeave: (node: ChapterFolderNode) => void;
  onFolderDragOver: (event: DragEvent<HTMLButtonElement>, node: ChapterFolderNode) => void;
  onFolderDrop: (event: DragEvent<HTMLButtonElement>, node: ChapterFolderNode) => void;
  onSelect: (event: MouseEvent<HTMLButtonElement>, node: TreeNode) => void;
  onToggle: (key: string) => void;
  selectedChapterKeys: Set<string>;
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
  onFolderDragLeave,
  onFolderDragOver,
  onFolderDrop,
  onSelect,
  onToggle,
  selectedChapterKeys,
  selectedKey,
  dropTarget,
  folderDropKey
}: TreeItemSharedProps & {
  expanded?: boolean;
  hasChildren?: boolean;
  node: TreeNode;
}) {
  const key = nodeKey(node);
  const isChapter = node.kind === "chapter";
  const isFolder = node.kind === "category" || node.kind === "volume";
  const selected = selectedKey === key || (isChapter && selectedChapterKeys.has(key));
  const dropClass =
    dropTarget?.nodeKey === key
      ? ` tree-node-drop-${dropTarget.placement}`
      : folderDropKey === key
        ? " tree-node-drop-folder"
        : "";

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
        className={`${selected ? "tree-node tree-node-active" : "tree-node"}${dropClass}`}
        draggable={isChapter}
        onClick={(event) => onSelect(event, node)}
        onContextMenu={(event) => onContextMenu(event, node)}
        onDragEnd={isChapter ? onChapterDragEnd : undefined}
        onDragStart={isChapter ? (event) => onChapterDragStart(event, node) : undefined}
        onDragLeave={isFolder ? () => onFolderDragLeave(node) : undefined}
        onDragOver={isChapter ? (event) => onChapterDragOver(event, node) : isFolder ? (event) => onFolderDragOver(event, node) : undefined}
        onDrop={isChapter ? (event) => onChapterDrop(event, node) : isFolder ? (event) => onFolderDrop(event, node) : undefined}
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
      <TreeButton {...props} expanded={expanded} hasChildren={!node.childrenLoaded || node.categories.length > 0} node={node} />
      {expanded ? (
        <div className="tree-children">
          {node.childrenLoading ? (
            <div className="tree-loading">
              <span className="spinner"></span>
              <span>Loading...</span>
            </div>
          ) : null}
          {node.childrenError ? <p className="error-text">{node.childrenError}</p> : null}
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
