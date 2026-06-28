export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <strong>NovelWeb</strong>
          <span>Local library</span>
        </div>

        <nav className="nav-list">
          <button className="nav-item nav-item-active" type="button">
            Library
          </button>
          <button className="nav-item" type="button">
            Manager
          </button>
        </nav>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <span>Library</span>
          <h1>Your novels</h1>
        </header>

        <section className="empty-state">
          <h2>No library selected</h2>
          <p>Storage setup comes next.</p>
        </section>
      </main>
    </div>
  );
}
