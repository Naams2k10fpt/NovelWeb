# AGENTS.md

## Project
NovelWeb is a personal desktop app for managing, reading, editing, importing, and exporting Light Novel / Web Novel / Manga content.

## Tech stack
- Electron
- Vite
- React
- TypeScript
- electron-vite
- Main process handles filesystem access
- Renderer must use a narrow preload API only

## Source of truth
- PLAN.md is the architecture and product plan.
- PROGRESS.md is the implementation tracker.
- Before coding, read both PLAN.md and PROGRESS.md.
- Do not implement features outside PLAN.md unless explicitly approved.

## Working rules
- Implement one small task at a time.
- Prefer existing project structure before creating new abstractions.
- Avoid over-engineering.
- Keep MVP focused on LN/WN first.
- Manga features are later unless PROGRESS.md says otherwise.
- JSON + index storage comes before SQLite.
- Every metadata file must support schemaVersion.
- Use safe filesystem writes for user data.
- Never let renderer access filesystem directly.
- After finishing a task, update PROGRESS.md.

## Validation
- Run typecheck/build after meaningful code changes.
- Explain changed files briefly.
- Mention any risk or follow-up task.