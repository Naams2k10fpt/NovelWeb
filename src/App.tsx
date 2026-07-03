import { useEffect, useState } from "react";
import ImportWizard from "./pages/ImportWizard";
import Library from "./pages/Library";
import Manager from "./pages/Manager";
import NovelEditor, { type ChapterTarget } from "./pages/NovelEditor";
import NovelReader from "./pages/NovelReader";
import Search from "./pages/Search";
import SeriesDetail from "./pages/SeriesDetail";

type Mode = "library" | "search" | "manager" | "import" | "settings";
type ChapterMode = "edit" | "read";
type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

type RendererApi = {
  library: {
    getCurrent: () => Promise<ApiResponse<{ path: string | null }>>;
    chooseFolder: () => Promise<ApiResponse<{ path: string | null }>>;
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
  import: {
    label: "Import",
    eyebrow: "Import",
    title: "Import content"
  },
  settings: {
    label: "Settings",
    eyebrow: "Settings",
    title: "App settings"
  }
};

export default function App() {
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

  function openChapter(target: ChapterTarget, nextMode: ChapterMode): void {
    if (!confirmLeaveChapter()) {
      return;
    }

    setChapterDirty(false);
    setChapterMode(nextMode);
    setSelectedChapter(target);
  }

  function closeChapter(): void {
    if (!confirmLeaveChapter()) {
      return;
    }

    setChapterDirty(false);
    setChapterMode("read");
    setSelectedChapter(null);
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
          onEdit={() => openChapter(selectedChapter, "edit")}
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
          onOpenChapter={(target) => openChapter(target, "read")}
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
        </section>
      );
    }

    if (mode === "manager") {
      return <Manager library={library} onOpenSettings={() => openMode("settings")} />;
    }

    if (mode === "import") {
      return <ImportWizard library={library} onOpenSettings={() => openMode("settings")} />;
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
        <header className="workspace-header">
          <span>{currentMode.eyebrow}</span>
          <h1>{currentMode.title}</h1>
        </header>

        {renderWorkspaceContent()}
      </main>
    </div>
  );
}
