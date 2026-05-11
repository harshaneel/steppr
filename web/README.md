# Steppr Simulator

A static, browser-based workflow simulator for [Steppr](../README.md). Edit a workflow YAML, edit JS handler stubs, click run — everything executes client-side using the same engine and validator as the Go reference orchestrator.

Deployed automatically to GitHub Pages from `main` via [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml). No backend.

## Local development

```bash
# Build the SDK first (the simulator depends on it via file:).
cd ../sdk/typescript && npm install && npm run build

# Then run the simulator.
cd ../../web && npm install && npm run dev
```

`npm run build` produces a static bundle under `dist/`. Preview with `npm run preview`.

## What runs in the browser

The simulator imports `@steppr/sdk` (browser-safe core) and uses:

- `parse(yaml)` — YAML → workflow AST
- `validate(wf, { initialFields })` — structural + data-flow checks
- `Engine` + `InMemoryResolver` — execution against user-supplied JS handlers

Handlers are evaluated in a sandboxed `new Function(...)` scope. Each handler receives the `WorkflowMessage` and returns `{ status, output }`. The engine merges `output` into the running payload.

## Configuration

The Vite base path defaults to `/steppr/` (suitable for `https://<user>.github.io/steppr/`). Override at build time:

```bash
VITE_BASE=/ npm run build
```
