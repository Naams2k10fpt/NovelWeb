import { useState } from "react";

type Mode = "library" | "manager";

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
  const currentMode = modes[mode];

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
          <h2>{currentMode.emptyTitle}</h2>
          <p>{currentMode.emptyText}</p>
        </section>
      </main>
    </div>
  );
}
