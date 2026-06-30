import { useEffect, useState } from "react";
import Library from "./pages/Library";
import SeriesDetail from "./pages/SeriesDetail";

type Mode = "library" | "manager" | "settings";
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
  const [mode, setMode] = useState<Mode>("library");
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
    setMode(nextMode);
    setSelectedSeriesId(null);
  }

  function renderWorkspaceContent() {
    if (mode === "library") {
      if (selectedSeriesId) {
        return <SeriesDetail onBack={() => setSelectedSeriesId(null)} seriesId={selectedSeriesId} />;
      }

      return (
        <Library
          library={library}
          onOpenSeries={setSelectedSeriesId}
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

    if (mode === "manager") {
      return (
        <section className="empty-state">
          <h2>Nothing to manage yet</h2>
          <p>Series, categories, volumes, and chapters come after storage.</p>
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
