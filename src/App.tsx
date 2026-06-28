import { useEffect, useState } from "react";

type Mode = "library" | "manager";
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

const modes: Record<Mode, { label: string; eyebrow: string; title: string; emptyTitle: string; emptyText: string }> = {
  library: {
    label: "Library",
    eyebrow: "Library",
    title: "Your novels",
    emptyTitle: "No library selected",
    emptyText: "Storage setup comes next."
  },
  manager: {
    label: "Manager",
    eyebrow: "Manager",
    title: "Manage structure",
    emptyTitle: "Nothing to manage yet",
    emptyText: "Series, categories, volumes, and chapters come after storage."
  }
};

export default function App() {
  const [mode, setMode] = useState<Mode>("library");
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
    if (!api) {
      setLibrary({
        loading: false,
        path: null,
        error: "App API is unavailable. Restart the app or check the preload script."
      });
      return;
    }

    setLibrary((current) => ({ ...current, loading: true, error: null }));

    const response = await api.library.chooseFolder();
    if (response.ok) {
      setLibrary({ loading: false, path: response.data.path, error: null });
    } else {
      setLibrary({ loading: false, path: null, error: response.error.message });
    }
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
              onClick={() => setMode(modeId as Mode)}
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

        <section className="empty-state">
          {library.loading ? (
            <>
              <h2>Checking library</h2>
              <p>Loading the current Library folder.</p>
            </>
          ) : library.path ? (
            <>
              <h2>Library selected</h2>
              <p className="library-path">{library.path}</p>
            </>
          ) : (
            <>
              <h2>{currentMode.emptyTitle}</h2>
              <p>{library.error ?? currentMode.emptyText}</p>
              <button className="primary-action" onClick={chooseLibraryFolder} type="button">
                Choose Library folder
              </button>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
