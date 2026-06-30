import { useEffect, useState, type MouseEvent } from "react";

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

type NovelChapterMetadata = {
  id: string;
  title: string;
  translationStatus: string;
};

type ChapterNode = NovelChapterMetadata & {
  kind: "chapter";
  seriesId: string;
  categoryId: string;
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
    list: (seriesId: string, categoryId: string, volumeId?: string | null) => Promise<ApiResponse<NovelChapterMetadata[]>>;
    create: (seriesId: string, categoryId: string, volumeId: string | null, input: unknown) => Promise<ApiResponse<unknown>>;
    update: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string,
      input: unknown
    ) => Promise<ApiResponse<unknown>>;
    moveToTrash: (
      seriesId: string,
      categoryId: string,
      volumeId: string | null,
      chapterId: string
    ) => Promise<ApiResponse<unknown>>;
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

async function loadCategory(api: RendererApi, seriesId: string, category: CategoryMetadata): Promise<CategoryNode> {
  if (category.type === "manga") {
    return { ...category, kind: "category", seriesId, volumes: [], directChapters: [] };
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

function promptTitle(label: string, fallback = ""): string | null {
  const value = window.prompt(label, fallback);
  const title = value?.trim();
  return title || null;
}

function promptCategoryInput(): { title: string; type: CategoryType } | null {
  const type = window.prompt("Category type: light-novel, web-novel, manga", "light-novel")?.trim();

  if (type !== "light-novel" && type !== "web-novel" && type !== "manga") {
    return null;
  }

  const title = promptTitle("Category title", formatLabel(type));
  return title ? { title, type } : null;
}

export default function Manager({ library, onOpenSettings }: ManagerProps) {
  const [tree, setTree] = useState<TreeState>({ loading: false, series: [], error: null });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const api = getApi();
  const nodes = allNodes(tree.series);
  const selectedNode = nodes.find((node) => nodeKey(node) === selectedKey) ?? null;
  const menuNode = nodes.find((node) => nodeKey(node) === contextMenu?.nodeKey) ?? null;

  async function refreshTree(): Promise<void> {
    if (!api || !library.path) {
      return;
    }

    setTree((current) => ({ ...current, loading: true, error: null }));
    try {
      setTree({ loading: false, series: await loadTree(api), error: null });
    } catch (error) {
      setTree({ loading: false, series: [], error: String(error) });
    }
  }

  useEffect(() => {
    if (!library.path) {
      setTree({ loading: false, series: [], error: null });
      return;
    }

    void refreshTree();
  }, [library.path]);

  async function runAction(action: () => Promise<void>): Promise<void> {
    setContextMenu(null);
    setActionError(null);

    try {
      await action();
      await refreshTree();
    } catch (error) {
      setActionError(String(error));
    }
  }

  function actionsFor(node: TreeNode | null): Array<{ label: string; run: () => Promise<void> }> {
    if (!api) {
      return [];
    }

    if (!node) {
      return [
        {
          label: "Add series",
          run: async () => {
            const title = promptTitle("Series title");
            if (title) {
              unwrap(await api.series.create({ title }));
            }
          }
        }
      ];
    }

    if (node.kind === "series") {
      return [
        {
          label: "Add category",
          run: async () => {
            const input = promptCategoryInput();
            if (input) {
              unwrap(await api.categories.create(node.id, input));
            }
          }
        },
        {
          label: "Rename",
          run: async () => {
            const title = promptTitle("Series title", node.title);
            if (title) {
              unwrap(await api.series.update(node.id, { title }));
            }
          }
        },
        {
          label: "Move to trash",
          run: async () => {
            if (window.confirm(`Move "${node.title}" to trash?`)) {
              unwrap(await api.series.moveToTrash(node.id));
              setSelectedKey(null);
            }
          }
        }
      ];
    }

    if (node.kind === "category") {
      const actions: Array<{ label: string; run: () => Promise<void> }> = [];

      if (node.type !== "manga") {
        actions.push({
          label: "Add volume",
          run: async () => {
            const title = promptTitle("Volume title", `Volume ${node.volumes.length + 1}`);
            if (title) {
              unwrap(await api.volumes.create(node.seriesId, node.id, { title }));
            }
          }
        });
      }

      if (node.type === "web-novel") {
        actions.push({
          label: "Add chapter",
          run: async () => {
            const title = promptTitle("Chapter title", `Chapter ${node.directChapters.length + 1}`);
            if (title) {
              unwrap(await api.chapters.create(node.seriesId, node.id, null, { title }));
            }
          }
        });
      }

      return [
        ...actions,
        {
          label: "Rename",
          run: async () => {
            const title = promptTitle("Category title", node.title);
            if (title) {
              unwrap(await api.categories.update(node.seriesId, node.id, { title }));
            }
          }
        },
        {
          label: "Move to trash",
          run: async () => {
            if (window.confirm(`Move "${node.title}" to trash?`)) {
              unwrap(await api.categories.moveToTrash(node.seriesId, node.id));
              setSelectedKey(null);
            }
          }
        }
      ];
    }

    if (node.kind === "volume") {
      return [
        {
          label: "Add chapter",
          run: async () => {
            const title = promptTitle("Chapter title", `Chapter ${node.chapters.length + 1}`);
            if (title) {
              unwrap(await api.chapters.create(node.seriesId, node.categoryId, node.id, { title }));
            }
          }
        },
        {
          label: "Rename",
          run: async () => {
            const title = promptTitle("Volume title", node.title);
            if (title) {
              unwrap(await api.volumes.update(node.seriesId, node.categoryId, node.id, { title }));
            }
          }
        },
        {
          label: "Move to trash",
          run: async () => {
            if (window.confirm(`Move "${node.title}" to trash?`)) {
              unwrap(await api.volumes.moveToTrash(node.seriesId, node.categoryId, node.id));
              setSelectedKey(null);
            }
          }
        }
      ];
    }

    return [
      {
        label: "Rename",
        run: async () => {
          const title = promptTitle("Chapter title", node.title);
          if (title) {
            unwrap(await api.chapters.update(node.seriesId, node.categoryId, node.volumeId, node.id, { title }));
          }
        }
      },
      {
        label: "Move to trash",
        run: async () => {
          if (window.confirm(`Move "${node.title}" to trash?`)) {
            unwrap(await api.chapters.moveToTrash(node.seriesId, node.categoryId, node.volumeId, node.id));
            setSelectedKey(null);
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
    <section className="manager-layout" onClick={() => setContextMenu(null)}>
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
                selectedKey={selectedKey}
              />
            ))}
          </div>
        )}
      </aside>

      <section className="manager-detail-panel">
        <h2>{selectedNode ? selectedNode.title : "Select an item"}</h2>
        <p>{selectedNode ? nodeDescription(selectedNode) : "Right-click a tree item for quick actions."}</p>

        {actionError ? <p className="error-text">{actionError}</p> : null}

        <div className="manager-actions">
          {(selectedNode ? selectedActions : actionsFor(null)).map((action) => (
            <button key={action.label} onClick={() => void runAction(action.run)} type="button">
              {action.label}
            </button>
          ))}
        </div>
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

  return `Chapter - ${formatLabel(node.translationStatus)}`;
}

function TreeButton({
  node,
  onContextMenu,
  onSelect,
  selectedKey
}: {
  node: TreeNode;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  selectedKey: string | null;
}) {
  return (
    <button
      className={selectedKey === nodeKey(node) ? "tree-node tree-node-active" : "tree-node"}
      onClick={() => onSelect(node)}
      onContextMenu={(event) => onContextMenu(event, node)}
      type="button"
    >
      <span>{node.title}</span>
      <small>{node.kind}</small>
    </button>
  );
}

function SeriesTreeItem({
  node,
  onContextMenu,
  onSelect,
  selectedKey
}: {
  node: SeriesNode;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  selectedKey: string | null;
}) {
  return (
    <div className="tree-group" role="treeitem">
      <TreeButton node={node} onContextMenu={onContextMenu} onSelect={onSelect} selectedKey={selectedKey} />
      <div className="tree-children">
        {node.categories.map((category) => (
          <CategoryTreeItem
            key={category.id}
            node={category}
            onContextMenu={onContextMenu}
            onSelect={onSelect}
            selectedKey={selectedKey}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryTreeItem({
  node,
  onContextMenu,
  onSelect,
  selectedKey
}: {
  node: CategoryNode;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  selectedKey: string | null;
}) {
  return (
    <div className="tree-group" role="treeitem">
      <TreeButton node={node} onContextMenu={onContextMenu} onSelect={onSelect} selectedKey={selectedKey} />
      <div className="tree-children">
        {node.directChapters.map((chapter) => (
          <TreeButton
            key={chapter.id}
            node={chapter}
            onContextMenu={onContextMenu}
            onSelect={onSelect}
            selectedKey={selectedKey}
          />
        ))}
        {node.volumes.map((volume) => (
          <VolumeTreeItem
            key={volume.id}
            node={volume}
            onContextMenu={onContextMenu}
            onSelect={onSelect}
            selectedKey={selectedKey}
          />
        ))}
      </div>
    </div>
  );
}

function VolumeTreeItem({
  node,
  onContextMenu,
  onSelect,
  selectedKey
}: {
  node: VolumeNode;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onSelect: (node: TreeNode) => void;
  selectedKey: string | null;
}) {
  return (
    <div className="tree-group" role="treeitem">
      <TreeButton node={node} onContextMenu={onContextMenu} onSelect={onSelect} selectedKey={selectedKey} />
      <div className="tree-children">
        {node.chapters.map((chapter) => (
          <TreeButton
            key={chapter.id}
            node={chapter}
            onContextMenu={onContextMenu}
            onSelect={onSelect}
            selectedKey={selectedKey}
          />
        ))}
      </div>
    </div>
  );
}
