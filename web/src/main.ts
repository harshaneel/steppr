/**
 * Steppr browser simulator — visual mode.
 *
 * The user interacts with a clickable graph and form-based node editor.
 * Each Enhancer/Action node carries a stubOutput JSON blob that the
 * simulator merges into the payload at run time, so users can explore
 * data flow without writing handler code.
 */

import {
  Engine,
  InMemoryResolver,
  ValidationError,
  validate,
} from "@steppr/sdk";
import type {
  ExecutionResult,
  NodeResponse,
  Trace,
  WorkflowMessage,
} from "@steppr/sdk";

import { DEFAULT_EXAMPLE_ID, EXAMPLES, type Example } from "./example.js";
import { renderGraph } from "./graph.js";
import { openNodeEditor } from "./node-editor.js";
import { REGISTERED_HANDLERS, type RegisteredHandler } from "./registry.js";
import { WorkflowStore, type EditableNode, type EditableWorkflow } from "./workflow-store.js";

// --- DOM ----------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const graphEl = document.getElementById("graph-svg") as unknown as SVGSVGElement;
const payloadEl = $<HTMLTextAreaElement>("payload-input");
const summaryEl = $<HTMLDivElement>("result-summary");
const traceEl = $<HTMLDivElement>("trace-output");
const exampleSelect = $<HTMLSelectElement>("example-select");
const exampleDescEl = $<HTMLParagraphElement>("example-description");
const runBtn = $<HTMLButtonElement>("run-btn");
const validateBtn = $<HTMLButtonElement>("validate-btn");
const resetBtn = $<HTMLButtonElement>("reset-btn");
const addNodeBtn = $<HTMLButtonElement>("add-node-btn");
const yamlBtn = $<HTMLButtonElement>("yaml-btn");

// --- State --------------------------------------------------------------

const STORAGE_KEY = "steppr-simulator-v4";
type Persisted = {
  workflow: EditableWorkflow;
  payload: string;
  exampleId: string;
};

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

let store: WorkflowStore;

function persist(): void {
  const data: Persisted = {
    workflow: store.get(),
    payload: payloadEl.value,
    exampleId: exampleSelect.value,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* quota errors ignored */
  }
}

function loadExample(ex: Example): void {
  store.replaceAll(structuredClone(ex.workflow));
  payloadEl.value = ex.payload;
  exampleDescEl.textContent = ex.description;
  persist();
  clearOutput();
}

// --- Init ---------------------------------------------------------------

function init(): void {
  for (const ex of EXAMPLES) {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.title;
    exampleSelect.appendChild(opt);
  }

  const persisted = loadPersisted();
  if (persisted) {
    store = new WorkflowStore(persisted.workflow);
    payloadEl.value = persisted.payload;
    exampleSelect.value = persisted.exampleId;
    const ex = EXAMPLES.find((e) => e.id === persisted.exampleId);
    exampleDescEl.textContent = ex?.description ?? "";
  } else {
    const def = EXAMPLES.find((e) => e.id === DEFAULT_EXAMPLE_ID) ?? EXAMPLES[0]!;
    store = new WorkflowStore(structuredClone(def.workflow));
    payloadEl.value = def.payload;
    exampleSelect.value = def.id;
    exampleDescEl.textContent = def.description;
  }

  store.subscribe(() => {
    refreshGraph();
    persist();
  });
  refreshGraph();

  exampleSelect.addEventListener("change", () => {
    const ex = EXAMPLES.find((e) => e.id === exampleSelect.value);
    if (ex && confirm(`Load "${ex.title}"? Replaces current workflow.`)) {
      loadExample(ex);
    } else {
      const prev = loadPersisted()?.exampleId;
      if (prev) exampleSelect.value = prev;
    }
  });

  payloadEl.addEventListener("input", persist);

  runBtn.addEventListener("click", () => void runWorkflow());
  validateBtn.addEventListener("click", () => void validateOnly());
  resetBtn.addEventListener("click", () => {
    if (confirm("Reset to the example currently selected?")) {
      const ex = EXAMPLES.find((e) => e.id === exampleSelect.value) ?? EXAMPLES[0]!;
      loadExample(ex);
    }
  });

  addNodeBtn.addEventListener("click", () => openAddNodePicker());

  yamlBtn.addEventListener("click", () => openYamlModal());
}

function openCustomEditor(type: "enhancer" | "filter" | "action"): void {
  const newId = uniqueId(type);
  const newNode: EditableNode = {
    id: newId,
    type,
    reads: [],
    produces: [],
    stubOutput: type === "filter" ? undefined : "{}",
    branches: type === "filter" ? [] : undefined,
  };
  openNodeEditor(newNode, {
    isNew: true,
    allNodeIds: store.get().nodes.map((n) => n.id),
    onSave: (updated) => {
      store.upsertNode(updated);
      const wf = store.get();
      if (wf.nodes.length === 1) {
        store.setStart(updated.id);
      } else {
        autoWireNewNode(updated.id);
      }
    },
    onCancel: () => {},
  });
}

function openAddNodePicker(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modal = document.createElement("div");
  modal.className = "modal modal-registry";
  overlay.appendChild(modal);

  const close = () => overlay.remove();

  const header = document.createElement("div");
  header.className = "modal-header";
  header.innerHTML = `<h3>Add node</h3>`;
  modal.appendChild(header);

  const body = document.createElement("div");
  body.className = "modal-body";

  // --- Custom group (top) ---
  const customHeading = document.createElement("h4");
  customHeading.className = "registry-group";
  customHeading.textContent = "Define your own";
  body.appendChild(customHeading);

  const customList = document.createElement("div");
  customList.className = "registry-list";
  customList.appendChild(
    renderCustomRow(
      "filter",
      "Branch on a condition. No worker, pure routing.",
      () => {
        close();
        openCustomEditor("filter");
      },
    ),
  );
  customList.appendChild(
    renderCustomRow(
      "enhancer",
      "Transform the payload (custom handler — you'll define the response).",
      () => {
        close();
        openCustomEditor("enhancer");
      },
    ),
  );
  customList.appendChild(
    renderCustomRow(
      "action",
      "Perform a side effect (custom handler — you'll define the response).",
      () => {
        close();
        openCustomEditor("action");
      },
    ),
  );
  body.appendChild(customList);

  // --- Registry groups ---
  const registryHint = document.createElement("p");
  registryHint.className = "section-hint registry-hint";
  registryHint.textContent =
    "From the worker registry — these are handlers workers have advertised at /handlers. Picking one drops a fully-configured node into your workflow.";
  body.appendChild(registryHint);

  for (const groupType of ["enhancer", "action"] as const) {
    const group = REGISTERED_HANDLERS.filter((h) => h.type === groupType);
    if (group.length === 0) continue;
    const heading = document.createElement("h4");
    heading.className = "registry-group";
    heading.innerHTML = `<span class="dot dot-${groupType}"></span> ${groupType} <span class="registry-group-count">(${group.length})</span>`;
    body.appendChild(heading);

    const list = document.createElement("div");
    list.className = "registry-list";
    for (const h of group) {
      list.appendChild(renderRegistryRow(h, () => {
        addHandlerToWorkflow(h);
        close();
      }));
    }
    body.appendChild(list);
  }

  modal.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  actions.appendChild(spacer);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);
  actions.appendChild(closeBtn);
  modal.appendChild(actions);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  document.body.appendChild(overlay);
}

function renderCustomRow(
  type: "filter" | "enhancer" | "action",
  description: string,
  onPick: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "registry-row registry-row-custom";
  row.innerHTML = `
    <div class="registry-row-main">
      <span class="dot dot-${type}"></span>
      <code class="registry-id">Custom ${type}</code>
    </div>
    <div class="registry-row-desc">${description}</div>
  `;
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-secondary btn-small";
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", onPick);
  row.appendChild(addBtn);
  return row;
}

function renderRegistryRow(h: RegisteredHandler, onAdd: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "registry-row";
  row.innerHTML = `
    <div class="registry-row-main">
      <code class="registry-id">${h.id}</code>
      <span class="registry-worker">${h.worker}</span>
    </div>
    <div class="registry-row-desc">${h.description}</div>
  `;
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-secondary btn-small";
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", onAdd);
  row.appendChild(addBtn);
  return row;
}

function addHandlerToWorkflow(h: RegisteredHandler): void {
  const wf = store.get();
  if (wf.nodes.some((n) => n.id === h.id)) {
    alert(`A node with id "${h.id}" already exists in this workflow.`);
    return;
  }
  const node: EditableNode = {
    id: h.id,
    type: h.type,
    reads: [...h.reads],
    produces: [...h.produces],
    stubOutput: h.stubOutput,
  };
  store.upsertNode(node);
  if (store.get().nodes.length === 1) {
    store.setStart(node.id);
  } else {
    autoWireNewNode(node.id);
  }
}

function openYamlModal(): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modal = document.createElement("div");
  modal.className = "modal modal-yaml";
  overlay.appendChild(modal);

  const header = document.createElement("div");
  header.className = "modal-header";
  header.innerHTML = `<h3>Generated YAML</h3>`;
  modal.appendChild(header);

  const body = document.createElement("div");
  body.className = "modal-body";
  const hint = document.createElement("p");
  hint.className = "section-hint";
  hint.textContent =
    "Read-only preview. This is what your workflow looks like in the canonical YAML format used by the Steppr CLI and SDK.";
  body.appendChild(hint);
  const pre = document.createElement("pre");
  pre.className = "yaml-pre";
  pre.textContent = store.toYAML();
  body.appendChild(pre);
  modal.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  actions.appendChild(spacer);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn btn-secondary";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(pre.textContent ?? "").then(() => {
      copy.textContent = "Copied ✓";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
  });
  actions.appendChild(copy);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = "Close";
  close.addEventListener("click", () => overlay.remove());
  actions.appendChild(close);
  modal.appendChild(actions);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

function uniqueId(prefix: string): string {
  const ids = new Set(store.get().nodes.map((n) => n.id));
  let i = ids.size + 1;
  while (ids.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

/**
 * Connect a freshly-added node to the existing workflow so it shows up
 * in the graph immediately. Strategy: find the first non-Filter terminal
 * along the path from start (a node with no next_node). Set its next_node
 * to the new node id. If no suitable target exists (e.g., the existing
 * workflow ends in a Filter with all branches wired), leave the new node
 * disconnected — the graph renders orphans separately so it stays visible.
 */
function autoWireNewNode(newId: string): void {
  const wf = store.get();
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();

  const findTerminal = (id: string): EditableNode | undefined => {
    if (visited.has(id) || id === newId) return undefined;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return undefined;
    if (node.type === "filter") {
      for (const b of node.branches ?? []) {
        if (b.next_node) {
          const t = findTerminal(b.next_node);
          if (t) return t;
        }
      }
      return undefined;
    }
    if (node.next_node) return findTerminal(node.next_node);
    return node;
  };

  const terminal = findTerminal(wf.start);
  if (terminal) {
    const updated: EditableNode = { ...terminal, next_node: newId };
    store.upsertNode(updated);
  }
}

// --- Rendering ----------------------------------------------------------

let wiringSourceId: string | undefined;
let lastStatuses: Record<string, "ok" | "fail" | "active"> = {};

function setWiring(id: string | undefined): void {
  wiringSourceId = id;
  refreshGraph(lastStatuses);
  updateWiringBanner();
}

function updateWiringBanner(): void {
  let banner = document.getElementById("wiring-banner");
  if (!wiringSourceId) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "wiring-banner";
    banner.className = "wiring-banner";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-link";
    cancel.textContent = "Cancel (Esc)";
    cancel.addEventListener("click", () => setWiring(undefined));
    banner.appendChild(document.createElement("span")).className = "wiring-text";
    banner.appendChild(cancel);
    const canvasPane = document.querySelector(".canvas-pane");
    canvasPane?.insertBefore(banner, canvasPane.querySelector(".canvas"));
  }
  const text = banner.querySelector(".wiring-text") as HTMLElement;
  text.textContent = `Wiring from "${wiringSourceId}". Click any other node to connect.`;
}

function refreshGraph(statuses: Record<string, "ok" | "fail" | "active"> = {}): void {
  lastStatuses = statuses;
  const wf = store.toWorkflowDef();
  renderGraph(wf, graphEl, {
    statuses,
    wiringSourceId,
    onSelect: (id) => {
      const node = store.get().nodes.find((n) => n.id === id);
      if (!node) return;
      openNodeEditor(node, {
        allNodeIds: store.get().nodes.map((n) => n.id),
        isStart: store.get().start === id,
        onSave: (updated, oldId) => store.upsertNode(updated, oldId),
        onDelete: () => store.deleteNode(id),
        onMakeStart: () => store.setStart(id),
        onCancel: () => {},
      });
    },
    onWireStart: (sourceId) => setWiring(sourceId),
    onWireCancel: () => setWiring(undefined),
    onWireComplete: (sourceId, targetId) => {
      const result = store.connect(sourceId, targetId);
      if (!result.ok) alert(`Couldn't connect: ${result.reason}`);
      setWiring(undefined);
    },
    onEdgeDelete: (fromId, toId, branchLabel) => {
      store.disconnect(fromId, toId, branchLabel);
    },
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && wiringSourceId) setWiring(undefined);
});

// --- Run ----------------------------------------------------------------

function parseStubOutput(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function makeStubResponder(output: Record<string, unknown>) {
  return (msg: WorkflowMessage): NodeResponse => ({
    execution_id: msg.execution_id,
    node_id: msg.node_id,
    status: "success",
    output,
  });
}

async function runWorkflow(): Promise<void> {
  clearOutput();
  const wf = store.toWorkflowDef();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadEl.value || "{}") as Record<string, unknown>;
  } catch (err) {
    return showError("Initial input is not valid JSON", err);
  }

  try {
    validate(wf, { initialFields: Object.keys(payload) });
  } catch (err) {
    if (err instanceof ValidationError) return showValidationErrors(err);
    return showError("Validation error", err);
  }

  const editableNodes = new Map(store.get().nodes.map((n) => [n.id, n]));
  const resolver = new InMemoryResolver();
  for (const n of wf.nodes) {
    if (n.type === "filter") continue;
    const editable = editableNodes.get(n.id);
    const output = parseStubOutput(editable?.stubOutput);
    resolver.register(n.id, async (msg) => makeStubResponder(output)(msg));
  }

  const eng = new Engine(resolver);
  let result: ExecutionResult;
  try {
    result = await eng.execute(wf, `exec-${Date.now()}`, payload);
  } catch (err) {
    return showError("Execution error", err);
  }

  showResult(result);
}

async function validateOnly(): Promise<void> {
  clearOutput();
  const wf = store.toWorkflowDef();
  let initialFields: string[] = [];
  try {
    const p = JSON.parse(payloadEl.value || "{}") as Record<string, unknown>;
    initialFields = Object.keys(p);
  } catch {
    /* leave empty */
  }
  try {
    validate(wf, initialFields.length > 0 ? { initialFields } : {});
  } catch (err) {
    if (err instanceof ValidationError) return showValidationErrors(err);
    return showError("Validation error", err);
  }
  const counts = countTypes(wf);
  summaryEl.innerHTML = `<span class="ok">✓ valid</span> — ${wf.nodes.length} nodes (${counts.filter} filter, ${counts.enhancer} enhancer, ${counts.action} action)`;
  if (initialFields.length > 0) {
    traceEl.innerHTML = `<p class="hint">Data-flow check passed (initial fields: ${initialFields.join(", ")}).</p>`;
  }
}

function countTypes(wf: { nodes: { type: string }[] }): Record<"filter" | "enhancer" | "action", number> {
  const c: Record<string, number> = { filter: 0, enhancer: 0, action: 0 };
  for (const n of wf.nodes) c[n.type] = (c[n.type] ?? 0) + 1;
  return c as Record<"filter" | "enhancer" | "action", number>;
}

// --- Output rendering ---------------------------------------------------

function clearOutput(): void {
  summaryEl.innerHTML = "";
  traceEl.innerHTML = "";
}

function showError(title: string, err: unknown): void {
  summaryEl.innerHTML = `<span class="fail">✗ ${escapeHtml(title)}</span>`;
  traceEl.innerHTML = `<pre class="error">${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`;
}

function showValidationErrors(err: ValidationError): void {
  summaryEl.innerHTML = `<span class="fail">✗ validation failed (${err.errors.length} error${err.errors.length === 1 ? "" : "s"})</span>`;
  traceEl.innerHTML = `<pre class="error">${err.errors.map((e) => `  - ${escapeHtml(e)}`).join("\n")}</pre>`;
}

function showResult(result: ExecutionResult): void {
  const cls = result.status === "completed" ? "ok" : "fail";
  const sym = result.status === "completed" ? "✓" : "✗";
  summaryEl.innerHTML = `<span class="${cls}">${sym} ${escapeHtml(result.status)}</span> — ${result.traces.length} trace${result.traces.length === 1 ? "" : "s"}`;

  const statuses: Record<string, "ok" | "fail"> = {};
  for (const t of result.traces) {
    for (const n of t.nodes) {
      statuses[n.node_id] = n.status === "completed" ? "ok" : "fail";
    }
  }
  refreshGraph(statuses);

  traceEl.innerHTML = result.traces.map((t, i) => renderTrace(t, i + 1)).join("");
}

function renderTrace(t: Trace, idx: number): string {
  const cls = t.status === "completed" ? "ok" : "fail";
  const sym = t.status === "completed" ? "✓" : "✗";
  let html = `<div class="trace"><div class="trace-header"><span class="badge-${cls}">${sym}</span> trace ${idx} <span class="muted">[${escapeHtml(t.status)}]</span></div>`;
  for (const n of t.nodes) {
    const okSym = n.status === "completed" ? "OK" : "FAIL";
    const okCls = n.status === "completed" ? "badge-ok" : "badge-fail";
    const dur = n.started_at && n.ended_at
      ? `${Math.max(0, new Date(n.ended_at).getTime() - new Date(n.started_at).getTime())}ms`
      : "—";
    html += `<details class="node-row" ${n.error ? "open" : ""}>
      <summary>
        <span class="node-id">${escapeHtml(n.node_id)}</span>
        <span class="node-type">${escapeHtml(n.node_type)}</span>
        <span class="${okCls}">[${okSym}]</span>
        <span class="muted">${dur}</span>
      </summary>
      <div class="node-body">
        ${n.error ? `<div class="node-error">⚠ ${escapeHtml(n.error.code)} — ${escapeHtml(n.error.message)}</div>` : ""}
        <div class="kv-grid">
          <div class="kv-label">input</div>
          <div class="kv-value"><pre>${escapeHtml(JSON.stringify(n.input, null, 2))}</pre></div>
          ${n.output ? `<div class="kv-label">output</div><div class="kv-value"><pre>${escapeHtml(JSON.stringify(n.output, null, 2))}</pre></div>` : ""}
        </div>
      </div>
    </details>`;
  }
  html += "</div>";
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

init();
