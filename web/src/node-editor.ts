/**
 * Modal node editor.
 *
 * Layout principle: each form row is full-width with a stacked label so fields
 * don't get squeezed at narrow widths. Condition rows use a vertical micro-form
 * inside a card rather than a tight horizontal grid.
 */

import { findHandler, handlersByType, type RegisteredHandler } from "./registry.js";
import type { ConditionRow, EditableNode, SimpleBranch } from "./workflow-store.js";

const OPS: ConditionRow["op"][] = ["eq", "neq", "gt", "gte", "lt", "lte"];
const OP_LABELS: Record<ConditionRow["op"], string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "greater than or equal",
  lt: "less than",
  lte: "less than or equal",
};

export interface NodeEditorOptions {
  isNew?: boolean;
  allNodeIds: string[];
  isStart?: boolean;
  onSave(updated: EditableNode, oldId?: string): void;
  onDelete?(): void;
  onMakeStart?(): void;
  onCancel(): void;
}

export function openNodeEditor(node: EditableNode, opts: NodeEditorOptions): void {
  const draft: EditableNode = structuredClone(node);

  const overlay = el("div", "modal-overlay");
  const modal = el("div", "modal");
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) {
      opts.onCancel();
      close();
    }
  });

  const render = (): void => {
    modal.innerHTML = "";

    const header = el("div", "modal-header");
    const titleText = opts.isNew ? "New node" : `Edit ${draft.type} node`;
    header.innerHTML = `<h3>${titleText}</h3>`;
    modal.appendChild(header);

    const body = el("div", "modal-body");
    modal.appendChild(body);

    // --- Type picker (top, biggest visual element) ---
    const section1 = el("div", "form-section");
    section1.appendChild(formField("Type", typePicker(draft, render)));

    // Registered handler picker (only meaningful for enhancer/action — filters
    // are pure routing, no worker behind them). Picking a handler fills in
    // id, stubOutput, reads, produces so users can see the registry concept.
    if (draft.type !== "filter") {
      section1.appendChild(
        formField(
          "Registered handler",
          handlerPicker(draft, render),
          "Pre-canned handlers a worker would have advertised at /handlers.",
        ),
      );
    }

    section1.appendChild(
      formField(
        "Node ID",
        inputText(draft.id, (v) => (draft.id = v.trim().replace(/\s+/g, "_")), "lower_snake_case"),
        registryBadge(draft),
      ),
    );
    body.appendChild(section1);

    // --- Flow control ---
    const section2 = el("div", "form-section");
    if (draft.type !== "filter") {
      const candidates = opts.allNodeIds.filter((id) => id !== draft.id);
      section2.appendChild(
        formField(
          "Then go to",
          selectInput(
            draft.next_node ?? "",
            ["", ...candidates],
            (v) => {
              draft.next_node = v || undefined;
            },
            "(end of workflow)",
          ),
        ),
      );
    } else {
      const branchesWrap = el("div", "branches");
      const branches = draft.branches ?? [];
      branches.forEach((b, idx) => {
        branchesWrap.appendChild(
          renderBranchEditor(b, idx, opts.allNodeIds, draft.id, () => {
            draft.branches = (draft.branches ?? []).filter((_, i) => i !== idx);
            render();
          }),
        );
      });

      const addBtn = el("button", "btn btn-secondary btn-block");
      addBtn.type = "button";
      addBtn.textContent = "+ Add branch";
      addBtn.addEventListener("click", () => {
        draft.branches = [
          ...(draft.branches ?? []),
          {
            label: "branch_" + ((draft.branches?.length ?? 0) + 1),
            next_node: "",
            rows: [],
          },
        ];
        render();
      });
      branchesWrap.appendChild(addBtn);
      section2.appendChild(formField("Branches", branchesWrap));
    }
    body.appendChild(section2);

    // --- What this handler returns (Enhancer/Action only) ---
    if (draft.type !== "filter") {
      body.appendChild(renderReturnsSection(draft, render));
    }

    // --- Actions row ---
    const actions = el("div", "modal-actions");
    if (opts.onDelete && !opts.isNew) {
      const del = el("button", "btn btn-danger");
      del.type = "button";
      del.textContent = "Delete node";
      del.addEventListener("click", () => {
        if (confirm(`Delete node "${node.id}"?`)) {
          opts.onDelete!();
          close();
        }
      });
      actions.appendChild(del);
    }
    if (opts.onMakeStart && !opts.isNew && !opts.isStart) {
      const startBtn = el("button", "btn");
      startBtn.type = "button";
      startBtn.textContent = "▶ Make this the start";
      startBtn.addEventListener("click", () => {
        opts.onMakeStart!();
        close();
      });
      actions.appendChild(startBtn);
    } else if (opts.isStart) {
      const tag = el("span", "start-tag");
      tag.textContent = "▶ start of workflow";
      actions.appendChild(tag);
    }
    const spacer = el("div", "spacer");
    actions.appendChild(spacer);

    const cancel = el("button", "btn");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      opts.onCancel();
      close();
    });
    actions.appendChild(cancel);

    const save = el("button", "btn btn-primary");
    save.type = "button";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      if (!draft.id) {
        alert("Node ID is required.");
        return;
      }
      opts.onSave(draft, opts.isNew ? undefined : node.id);
      close();
    });
    actions.appendChild(save);

    modal.appendChild(actions);
  };

  render();
}

function typePicker(draft: EditableNode, render: () => void): HTMLElement {
  const wrap = el("div", "type-picker");
  for (const t of ["enhancer", "filter", "action"] as const) {
    const btn = el("button", `type-btn type-${t} ${draft.type === t ? "active" : ""}`);
    btn.type = "button";
    btn.innerHTML = `<span class="dot dot-${t}"></span><span>${t}</span><span class="type-desc">${typeDescription(t)}</span>`;
    btn.addEventListener("click", () => {
      draft.type = t;
      if (t !== "filter") draft.branches = undefined;
      if (t === "filter") {
        draft.branches = draft.branches ?? [];
        draft.next_node = undefined;
      }
      render();
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function typeDescription(t: "filter" | "enhancer" | "action"): string {
  if (t === "filter") return "branches";
  if (t === "enhancer") return "transforms";
  return "side effect";
}

function handlerPicker(draft: EditableNode, render: () => void): HTMLElement {
  const sel = el("select", "input");
  const customOpt = document.createElement("option");
  customOpt.value = "";
  customOpt.textContent = "✏ Custom (define inline)";
  sel.appendChild(customOpt);

  const handlers = draft.type === "filter" ? [] : handlersByType(draft.type);
  for (const h of handlers) {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = `${h.id} — ${h.worker}`;
    sel.appendChild(opt);
  }

  // Pre-select if the current id matches a registered handler.
  if (findHandler(draft.id)) sel.value = draft.id;

  sel.addEventListener("change", () => {
    const picked = sel.value;
    if (!picked) {
      // Custom — leave fields as-is for the user to fill in.
      return;
    }
    const h = findHandler(picked);
    if (!h) return;
    applyHandler(draft, h);
    render();
  });
  return sel;
}

function applyHandler(draft: EditableNode, h: RegisteredHandler): void {
  draft.id = h.id;
  draft.type = h.type;
  draft.stubOutput = h.stubOutput;
  draft.reads = [...h.reads];
  draft.produces = [...h.produces];
}

interface KVRow {
  key: string;
  value: string;
}

function parseStubFields(stub: string | undefined): KVRow[] {
  if (!stub || !stub.trim()) return [];
  try {
    const parsed = JSON.parse(stub) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => ({
      key: k,
      value: typeof v === "string" ? v : JSON.stringify(v),
    }));
  } catch {
    return [];
  }
}

function serializeStubFields(rows: KVRow[]): string {
  const obj: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    obj[k] = coerceFieldValue(r.value);
  }
  return JSON.stringify(obj);
}

function coerceFieldValue(raw: string): unknown {
  if (raw === "") return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function renderReturnsSection(draft: EditableNode, render: () => void): HTMLElement {
  const section = el("div", "form-section");
  const handler = findHandler(draft.id);

  // Registered handler: read-only summary, the worker's response is the
  // registry's business, not the user's.
  if (handler) {
    section.appendChild(formField("Returns", returnsSummary(handler.produces)));
    return section;
  }

  // Custom handler: structured key/value editor — no JSON in the user's face.
  const hint = el("p", "section-hint");
  hint.textContent =
    "Fields this handler contributes to the payload when it runs. The simulator merges them in; in production a real worker would supply them.";
  section.appendChild(hint);
  section.appendChild(formField("Returns", renderKVEditor(draft, render)));
  return section;
}

function returnsSummary(produces: string[]): HTMLElement {
  const wrap = el("div", "returns-summary");
  if (produces.length === 0) {
    wrap.classList.add("muted");
    wrap.textContent = "no payload data — pure side effect";
    return wrap;
  }
  for (const p of produces) {
    const chip = el("span", "returns-chip");
    chip.textContent = p;
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderKVEditor(draft: EditableNode, _render: () => void): HTMLElement {
  const wrap = el("div", "kv-editor");
  const rows = parseStubFields(draft.stubOutput);
  draft.stubOutput = serializeStubFields(rows);

  const rowsHost = el("div", "kv-rows");
  const empty = el("div", "kv-empty");
  empty.textContent = "No fields. The handler runs but adds nothing to the payload.";

  const updateEmpty = () => {
    empty.style.display = rows.length === 0 ? "block" : "none";
  };

  const appendRow = (row: KVRow) => {
    const node = renderKVRow(
      row,
      () => {
        const idx = rows.indexOf(row);
        if (idx >= 0) rows.splice(idx, 1);
        node.remove();
        draft.stubOutput = serializeStubFields(rows);
        updateEmpty();
      },
      () => {
        draft.stubOutput = serializeStubFields(rows);
      },
    );
    rowsHost.appendChild(node);
  };

  for (const row of rows) appendRow(row);
  wrap.appendChild(rowsHost);
  wrap.appendChild(empty);
  updateEmpty();

  const addBtn = el("button", "btn btn-secondary btn-block btn-small");
  addBtn.type = "button";
  addBtn.textContent = "+ Add field";
  addBtn.addEventListener("click", () => {
    const newRow: KVRow = { key: "", value: "" };
    rows.push(newRow);
    appendRow(newRow);
    updateEmpty();
  });
  wrap.appendChild(addBtn);
  return wrap;
}

function renderKVRow(row: KVRow, onDelete: () => void, onChange: () => void): HTMLElement {
  const card = el("div", "kv-row");
  const keyInp = inputText(
    row.key,
    (v) => {
      row.key = v;
      onChange();
    },
    "field name",
  );
  keyInp.classList.add("kv-key");
  card.appendChild(keyInp);

  const valInp = inputText(
    row.value,
    (v) => {
      row.value = v;
      onChange();
    },
    "value",
  );
  valInp.classList.add("kv-val");
  card.appendChild(valInp);

  const del = el("button", "btn btn-link kv-remove");
  del.type = "button";
  del.title = "Remove field";
  del.textContent = "✕";
  del.addEventListener("click", onDelete);
  card.appendChild(del);
  return card;
}

function registryBadge(draft: EditableNode): HTMLElement | undefined {
  const h = findHandler(draft.id);
  if (!h) return undefined;
  const badge = el("span", "field-hint registry-badge");
  badge.innerHTML = `<span class="dot dot-${h.type}"></span>registered by <strong>${h.worker}</strong> — ${h.description}`;
  return badge;
}

function renderBranchEditor(
  b: SimpleBranch,
  idx: number,
  allIds: string[],
  selfId: string,
  onDelete: () => void,
): HTMLElement {
  const wrap = el("div", "branch-card");

  const header = el("div", "branch-header");
  const title = el("strong");
  title.textContent = `Branch ${idx + 1}`;
  header.appendChild(title);
  const removeBtn = el("button", "btn btn-link");
  removeBtn.type = "button";
  removeBtn.textContent = "✕ Remove";
  removeBtn.addEventListener("click", onDelete);
  header.appendChild(removeBtn);
  wrap.appendChild(header);

  // Top row: label + target side-by-side (each gets full width on mobile)
  wrap.appendChild(
    formField("Label", inputText(b.label, (v) => (b.label = v), "premium / standard / ...")),
  );
  wrap.appendChild(
    formField(
      "Then go to",
      selectInput(
        b.next_node,
        allIds.filter((id) => id !== selfId),
        (v) => (b.next_node = v),
        "Pick a target node",
      ),
    ),
  );

  // Conditions area
  const condWrap = el("div", "cond-list");
  b.rows.forEach((row, ri) => {
    condWrap.appendChild(
      renderConditionRow(row, () => {
        b.rows.splice(ri, 1);
        wrap.replaceWith(renderBranchEditor(b, idx, allIds, selfId, onDelete));
      }),
    );
  });

  if (b.rows.length === 0) {
    const hint = el("div", "branch-hint");
    hint.textContent = "No conditions = this branch always activates.";
    condWrap.appendChild(hint);
  } else if (b.rows.length > 1) {
    const hint = el("div", "branch-hint");
    hint.textContent = "All conditions must hold (logical AND).";
    condWrap.appendChild(hint);
  }

  const addCond = el("button", "btn btn-secondary btn-block btn-small");
  addCond.type = "button";
  addCond.textContent = "+ Add condition";
  addCond.addEventListener("click", () => {
    b.rows.push({ op: "eq", path: "", value: "", valueKind: "string" });
    wrap.replaceWith(renderBranchEditor(b, idx, allIds, selfId, onDelete));
  });
  condWrap.appendChild(addCond);

  wrap.appendChild(formField("When", condWrap));
  return wrap;
}

function renderConditionRow(row: ConditionRow, onDelete: () => void): HTMLElement {
  const card = el("div", "cond-card");

  const top = el("div", "cond-top");
  // Field path
  const pathInp = inputText(row.path, (v) => (row.path = v.trim()), "field name");
  pathInp.classList.add("cond-path");
  top.appendChild(pathInp);

  // Operator selector with full-word labels
  const opSel = el("select", "input cond-op");
  for (const o of OPS) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = OP_LABELS[o];
    opSel.appendChild(opt);
  }
  opSel.value = row.op;
  opSel.addEventListener("change", () => (row.op = opSel.value as ConditionRow["op"]));
  top.appendChild(opSel);

  card.appendChild(top);

  // Value row: value input + kind selector + remove button
  const bottom = el("div", "cond-bottom");
  const valueInp = inputText(row.value, (v) => (row.value = v), "value");
  valueInp.classList.add("cond-value");
  bottom.appendChild(valueInp);

  const kindSel = el("select", "input cond-kind");
  for (const k of ["string", "number", "boolean", "path"] as const) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k === "path" ? "another field" : k;
    kindSel.appendChild(opt);
  }
  kindSel.value = row.valueKind;
  kindSel.addEventListener("change", () => {
    row.valueKind = kindSel.value as ConditionRow["valueKind"];
  });
  bottom.appendChild(kindSel);

  const del = el("button", "btn btn-link cond-remove");
  del.type = "button";
  del.title = "Remove condition";
  del.textContent = "✕";
  del.addEventListener("click", onDelete);
  bottom.appendChild(del);

  card.appendChild(bottom);
  return card;
}

// --- helpers --------------------------------------------------------------

function inputText(
  value: string,
  onInput: (v: string) => void,
  placeholder = "",
): HTMLInputElement {
  const inp = el("input", "input");
  inp.type = "text";
  inp.value = value;
  inp.placeholder = placeholder;
  inp.addEventListener("input", () => onInput(inp.value));
  return inp;
}

function selectInput(
  value: string,
  options: string[],
  onChange: (v: string) => void,
  emptyLabel?: string,
): HTMLSelectElement {
  const sel = el("select", "input");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o === "" ? emptyLabel ?? "(none)" : o;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function formField(label: string, input: HTMLElement, hint?: string | HTMLElement): HTMLElement {
  const row = el("div", "form-field");
  const lbl = el("label", "form-label");
  lbl.textContent = label;
  row.appendChild(lbl);
  row.appendChild(input);
  if (hint) {
    if (typeof hint === "string") {
      const h = el("span", "field-hint");
      h.textContent = hint;
      row.appendChild(h);
    } else {
      row.appendChild(hint);
    }
  }
  return row;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
