import { useEffect, useState } from "react";
import Library from "./pages/Library";
import Manager from "./pages/Manager";
import NovelEditor, { type ChapterTarget } from "./pages/NovelEditor";
import NovelReader from "./pages/NovelReader";
import Search from "./pages/Search";
import SeriesDetail from "./pages/SeriesDetail";

type Mode = "library" | "search" | "manager" | "settings";
type ChapterMode = "edit" | "read";
type LibraryBackupType = "metadata" | "content" | "full";
type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type RendererApi = {
  library: {
    getCurrent: () => Promise<ApiResponse<{ path: string | null }>>;
    chooseFolder: () => Promise<ApiResponse<{ path: string | null }>>;
    createBackup: (
      type: LibraryBackupType
    ) => Promise<ApiResponse<{ name: string; path: string; createdAt: string; type: LibraryBackupType }>>;
    restoreFullBackup: () => Promise<ApiResponse<{ path: string | null }>>;
  };
};

type LibraryState = {
  loading: boolean;
  path: string | null;
  error: string | null;
};

function getApi(): RendererApi | null {
  return (window as unknown as { api?: RendererApi }).api ?? null;
}

const modes: Record<Mode, { label: string; eyebrow: string; title: string }> = {
  library: {
    label: "Library",
    eyebrow: "Library",
    title: "Your novels"
  },
  search: {
    label: "Search",
    eyebrow: "Search",
    title: "Find chapters"
  },
  manager: {
    label: "Manager",
    eyebrow: "Manager",
    title: "Manage structure"
  },
  settings: {
    label: "Settings",
    eyebrow: "Settings",
    title: "App settings"
  }
};

export default function App() {
  const [libraryTask, setLibraryTask] = useState<LibraryBackupType | "restore" | null>(null);
  const [chapterDirty, setChapterDirty] = useState(false);
  const [chapterMode, setChapterMode] = useState<ChapterMode>("read");
  const [mode, setMode] = useState<Mode>("library");
  const [selectedChapter, setSelectedChapter] = useState<ChapterTarget | null>(null);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryState>({
    loading: true,
    path: null,
    error: null
  });
  const currentMode = modes[mode];

  useEffect(() => {
    let isMounted = true;
    const api = getApi();

    if (!api) {
      setLibrary({
        loading: false,
        path: null,
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      return;
    }

    void api.library
      .getCurrent()
      .then((response) => {
        if (!isMounted) {
          return;
        }

        if (response.ok) {
          setLibrary({ loading: false, path: response.data.path, error: null });
        } else {
          setLibrary({ loading: false, path: null, error: response.error.message });
        }
      })
      .catch((error) => {
        if (isMounted) {
          setLibrary({ loading: false, path: null, error: String(error) });
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  async function chooseLibraryFolder(): Promise<void> {
    const api = getApi();
    const previousPath = library.path;

    if (!api) {
      setLibrary({
        loading: false,
        path: previousPath,
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      return;
    }

    setLibrary((current) => ({ ...current, loading: true, error: null }));

    try {
      const response = await api.library.chooseFolder();
      if (response.ok) {
        setLibrary({ loading: false, path: response.data.path ?? previousPath, error: null });
      } else {
        setLibrary({ loading: false, path: previousPath, error: response.error.message });
      }
    } catch (error) {
      setLibrary({ loading: false, path: previousPath, error: String(error) });
    }
  }

  async function createBackup(type: LibraryBackupType): Promise<void> {
    const api = getApi();

    if (!api || !library.path) {
      return;
    }

    setLibraryTask(type);
    try {
      const response = await api.library.createBackup(type);
      window.alert(response.ok ? `Backup created:\n${response.data.path}` : response.error.message);
    } catch (error) {
      window.alert(`Could not back up the Library.\n${String(error)}`);
    } finally {
      setLibraryTask(null);
    }
  }

  async function restoreFullBackup(): Promise<void> {
    const api = getApi();

    if (
      !api ||
      !library.path ||
      !window.confirm("Restore a full backup into a new empty folder and switch to that Library?")
    ) {
      return;
    }

    setLibraryTask("restore");
    try {
      const response = await api.library.restoreFullBackup();
      if (response.ok && response.data.path) {
        setLibrary({ loading: false, path: response.data.path, error: null });
        window.alert(`Library restored:\n${response.data.path}`);
      } else if (!response.ok) {
        window.alert(response.error.message);
      }
    } catch (error) {
      window.alert(`Could not restore the Library.\n${String(error)}`);
    } finally {
      setLibraryTask(null);
    }
  }

  function openMode(nextMode: Mode): void {
    if (!confirmLeaveChapter()) {
      return;
    }

    setMode(nextMode);
    setChapterDirty(false);
    setChapterMode("read");
    setSelectedChapter(null);
    setSelectedSeriesId(null);
  }

  function openSeries(seriesId: string): void {
    if (!confirmLeaveChapter()) {
      return;
    }

    setChapterDirty(false);
    setChapterMode("read");
    setSelectedChapter(null);
    setSelectedSeriesId(seriesId);
  }

  function openChapter(target: ChapterTarget, nextMode: ChapterMode, keepLibraryContext = false): void {
    if (!confirmLeaveChapter()) {
      return;
    }

    if (keepLibraryContext) {
      setMode("library");
      setSelectedSeriesId(target.seriesId);
    }

    setChapterDirty(false);
    setChapterMode(nextMode);
    setSelectedChapter(target);
  }

  function closeChapter(seriesId?: string): void {
    if (!confirmLeaveChapter()) {
      return;
    }

    setChapterDirty(false);
    setChapterMode("read");
    setSelectedChapter(null);
    if (seriesId) {
      setMode("library");
      setSelectedSeriesId(seriesId);
    }
  }

  function confirmLeaveChapter(): boolean {
    return !selectedChapter || !chapterDirty || window.confirm("Chapter has unsaved changes. Leave anyway?");
  }

  function renderWorkspaceContent() {
    if (selectedChapter) {
      if (chapterMode === "edit") {
        return (
          <NovelEditor
            onBack={closeChapter}
            onDirtyChange={setChapterDirty}
            onRead={() => openChapter(selectedChapter, "read")}
            target={selectedChapter}
          />
        );
      }

      return (
        <NovelReader
          onBack={closeChapter}
          onBackToSeries={() => closeChapter(selectedChapter.seriesId)}
          onEdit={(target) => openChapter(target ?? selectedChapter, "edit")}
          onOpenChapter={(target) => openChapter(target, "read")}
          target={selectedChapter}
        />
      );
    }

    if (mode === "library") {
      if (selectedSeriesId) {
        return (
          <SeriesDetail
            onBack={() => {
              setChapterDirty(false);
              setSelectedChapter(null);
              setSelectedSeriesId(null);
            }}
            onEditChapter={(target) => openChapter(target, "edit")}
            onReadChapter={(target) => openChapter(target, "read")}
            seriesId={selectedSeriesId}
          />
        );
      }

      return (
        <Library
          library={library}
          onOpenChapter={(target) => openChapter(target, "read")}
          onOpenSeries={openSeries}
          onOpenSettings={() => openMode("settings")}
        />
      );
    }

    if (mode === "search") {
      return (
        <Search
          library={library}
          onOpenChapter={(target) => openChapter(target, "read", true)}
          onOpenSettings={() => openMode("settings")}
        />
      );
    }

    if (mode === "settings") {
      return (
        <section className="empty-state">
          <h2>Library folder</h2>
          <p>{library.path ? "Current Library folder." : library.error ?? "No Library folder selected."}</p>
          {library.path ? <p className="library-path">{library.path}</p> : null}
          {library.error && library.path ? <p>{library.error}</p> : null}
          <button className="primary-action" onClick={chooseLibraryFolder} type="button">
            {library.path ? "Change Library folder" : "Choose Library folder"}
          </button>
          {library.path ? (
            <button
              className="primary-action"
              disabled={libraryTask !== null}
              onClick={() => void createBackup("metadata")}
              type="button"
            >
              {libraryTask === "metadata" ? "Backing up..." : "Back up metadata"}
            </button>
          ) : null}
          {library.path ? (
            <button
              className="primary-action"
              disabled={libraryTask !== null}
              onClick={() => void createBackup("content")}
              type="button"
            >
              {libraryTask === "content" ? "Backing up..." : "Back up content"}
            </button>
          ) : null}
          {library.path ? (
            <button
              className="primary-action"
              disabled={libraryTask !== null}
              onClick={() => void createBackup("full")}
              type="button"
            >
              {libraryTask === "full" ? "Backing up..." : "Back up full Library"}
            </button>
          ) : null}
          {library.path ? (
            <button
              className="primary-action"
              disabled={libraryTask !== null}
              onClick={() => void restoreFullBackup()}
              type="button"
            >
              {libraryTask === "restore" ? "Restoring..." : "Restore full backup"}
            </button>
          ) : null}
        </section>
      );
    }

    if (mode === "manager") {
      return <Manager library={library} onOpenSettings={() => openMode("settings")} />;
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
          <button className="primary-action" onClick={() => openMode("settings")} type="button">
            Open Settings
          </button>
        </section>
      );
    }

    return null;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <strong>NovelWeb</strong>
          <span>Local library</span>
        </div>

        <nav className="nav-list">
          {Object.entries(modes).map(([modeId, item]) => (
            <button
              aria-current={mode === modeId ? "page" : undefined}
              className={mode === modeId ? "nav-item nav-item-active" : "nav-item"}
              key={modeId}
              onClick={() => openMode(modeId as Mode)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="workspace">
        {!selectedChapter ? (
          <header className="workspace-header">
            <span>{currentMode.eyebrow}</span>
            <h1>{currentMode.title}</h1>
          </header>
        ) : null}

        {renderWorkspaceContent()}
      </main>
    </div>
  );
}
