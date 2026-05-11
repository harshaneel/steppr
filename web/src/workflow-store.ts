/**
 * Editable workflow store. Holds the workflow model as plain JS objects,
 * serializes to YAML on demand for the SDK, and notifies subscribers on
 * change so the graph and editors stay in sync.
 */

import type { Branch, Condition, Node, OpExpr, Operand, WorkflowDef } from "@steppr/sdk";

export type ConditionRow = {
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  path: string;
  value: string; // displayed as text; coerced to number/bool/string at serialization
  valueKind: "string" | "number" | "boolean" | "path";
};

export interface SimpleBranch {
  label: string;
  next_node: string;
  rows: ConditionRow[]; // implicit AND inside a branch (matches structured UI)
}

export interface EditableNode {
  id: string;
  type: "filter" | "enhancer" | "action";
  next_node?: string;
  branches?: SimpleBranch[];
  reads: string[];
  produces: string[];
  /** Pre-canned JSON output produced when this node runs (Enhancer/Action only).
   *  Default: empty echo. Lets users explore data flow without writing JS. */
  stubOutput?: string;
}

export interface EditableWorkflow {
  id: string;
  start: string;
  nodes: EditableNode[];
}

type Listener = () => void;

export class WorkflowStore {
  private wf: EditableWorkflow;
  private listeners: Set<Listener> = new Set();

  constructor(initial: EditableWorkflow) {
    this.wf = initial;
  }

  get(): EditableWorkflow {
    return this.wf;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  replaceAll(wf: EditableWorkflow): void {
    this.wf = wf;
    this.emit();
  }

  setName(id: string): void {
    this.wf.id = id;
    this.emit();
  }

  setStart(id: string): void {
    this.wf.start = id;
    this.emit();
  }

  upsertNode(node: EditableNode, oldId?: string): void {
    if (oldId && oldId !== node.id) {
      // Rewrite references to the old id.
      for (const n of this.wf.nodes) {
        if (n.next_node === oldId) n.next_node = node.id;
        for (const b of n.branches ?? []) {
          if (b.next_node === oldId) b.next_node = node.id;
        }
      }
      if (this.wf.start === oldId) this.wf.start = node.id;
      const idx = this.wf.nodes.findIndex((n) => n.id === oldId);
      if (idx >= 0) this.wf.nodes[idx] = node;
      else this.wf.nodes.push(node);
    } else {
      const idx = this.wf.nodes.findIndex((n) => n.id === node.id);
      if (idx >= 0) this.wf.nodes[idx] = node;
      else this.wf.nodes.push(node);
    }
    this.emit();
  }

  /**
   * Wire source → target. For non-filter sources, sets next_node (replacing
   * any existing edge). For filter sources, appends a new branch (with no
   * conditions, so it always activates — user can refine in the editor).
   * No-ops if it would create a self-loop or cycle.
   */
  connect(sourceId: string, targetId: string): { ok: boolean; reason?: string } {
    if (sourceId === targetId) return { ok: false, reason: "cannot wire a node to itself" };
    const source = this.wf.nodes.find((n) => n.id === sourceId);
    const target = this.wf.nodes.find((n) => n.id === targetId);
    if (!source || !target) return { ok: false, reason: "node not found" };
    if (this.wouldCreateCycle(sourceId, targetId)) {
      return { ok: false, reason: "that wire would create a cycle" };
    }
    if (source.type === "filter") {
      source.branches = source.branches ?? [];
      source.branches.push({
        label: `branch_${source.branches.length + 1}`,
        next_node: targetId,
        rows: [],
      });
    } else {
      source.next_node = targetId;
    }
    this.emit();
    return { ok: true };
  }

  /** Remove an edge. For non-filter, clears next_node. For filter, removes the matching branch. */
  disconnect(sourceId: string, targetId: string, branchLabel?: string): void {
    const source = this.wf.nodes.find((n) => n.id === sourceId);
    if (!source) return;
    if (source.type === "filter" && source.branches) {
      const idx = branchLabel
        ? source.branches.findIndex((b) => b.next_node === targetId && b.label === branchLabel)
        : source.branches.findIndex((b) => b.next_node === targetId);
      if (idx >= 0) source.branches.splice(idx, 1);
    } else if (source.next_node === targetId) {
      source.next_node = undefined;
    }
    this.emit();
  }

  private wouldCreateCycle(sourceId: string, targetId: string): boolean {
    // Walking forward from target, do we reach source?
    const byId = new Map(this.wf.nodes.map((n) => [n.id, n]));
    const stack = [targetId];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === sourceId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const n = byId.get(cur);
      if (!n) continue;
      if (n.type === "filter") {
        for (const b of n.branches ?? []) {
          if (b.next_node) stack.push(b.next_node);
        }
      } else if (n.next_node) {
        stack.push(n.next_node);
      }
    }
    return false;
  }

  deleteNode(id: string): void {
    this.wf.nodes = this.wf.nodes.filter((n) => n.id !== id);
    // Clean up references.
    for (const n of this.wf.nodes) {
      if (n.next_node === id) n.next_node = undefined;
      if (n.branches) {
        for (const b of n.branches) {
          if (b.next_node === id) b.next_node = "";
        }
      }
    }
    if (this.wf.start === id) {
      this.wf.start = this.wf.nodes[0]?.id ?? "";
    }
    this.emit();
  }

  /** Convert the editable model into the SDK's WorkflowDef shape. */
  toWorkflowDef(): WorkflowDef {
    const nodes: Node[] = this.wf.nodes.map((n) => {
      const out: Node = { id: n.id, type: n.type };
      if (n.next_node && n.type !== "filter") out.next_node = n.next_node;
      if (n.type === "filter" && n.branches) {
        out.branches = n.branches.map((b): Branch => ({
          label: b.label || undefined,
          next_node: b.next_node,
          condition: rowsToCondition(b.rows),
        }));
      }
      if (n.reads.length > 0 || n.produces.length > 0) {
        out.schema = {};
        if (n.reads.length > 0) out.schema.reads = [...n.reads];
        if (n.produces.length > 0) out.schema.produces = [...n.produces];
      }
      return out;
    });
    return { id: this.wf.id, start: this.wf.start, nodes };
  }

  /** Generate canonical YAML for this workflow. Used for "Advanced view". */
  toYAML(): string {
    const lines: string[] = [];
    lines.push(`id: ${this.wf.id}`);
    lines.push(`start: ${this.wf.start}`);
    lines.push("");
    lines.push("nodes:");
    for (const n of this.wf.nodes) {
      lines.push(`  - id: ${n.id}`);
      lines.push(`    type: ${n.type}`);
      if (n.reads.length > 0 || n.produces.length > 0) {
        lines.push(`    schema:`);
        if (n.reads.length > 0) lines.push(`      reads: [${n.reads.join(", ")}]`);
        if (n.produces.length > 0)
          lines.push(`      produces: [${n.produces.join(", ")}]`);
      }
      if (n.type === "filter" && n.branches?.length) {
        lines.push(`    branches:`);
        for (const b of n.branches) {
          lines.push(`      - label: ${b.label || "(unlabeled)"}`);
          if (b.rows.length > 0) {
            lines.push(`        condition:`);
            const cond = rowsToYAMLLines(b.rows);
            for (const l of cond) lines.push(`          ${l}`);
          }
          lines.push(`        next_node: ${b.next_node}`);
        }
      } else if (n.next_node) {
        lines.push(`    next_node: ${n.next_node}`);
      }
    }
    return lines.join("\n");
  }
}

// --- helpers --------------------------------------------------------------

function rowsToCondition(rows: ConditionRow[]): Condition | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return { exprs: [rowToOpExpr(rows[0]!)] };
  // Multiple rows = implicit AND inside this branch (top-level Condition.exprs is OR,
  // so wrap in an `and` node).
  const andOp: OpExpr = {
    op: "and",
    operands: rows.map((r): Operand => ({ kind: "op", op: rowToOpExpr(r) })),
  };
  return { exprs: [andOp] };
}

function rowToOpExpr(r: ConditionRow): OpExpr {
  return {
    op: r.op,
    operands: [
      { kind: "path", path: r.path },
      operandFromRow(r),
    ],
  };
}

function operandFromRow(r: ConditionRow): Operand {
  if (r.valueKind === "path") return { kind: "path", path: r.value };
  if (r.valueKind === "number") {
    const n = Number(r.value);
    return { kind: "literal", value: Number.isFinite(n) ? n : r.value };
  }
  if (r.valueKind === "boolean") {
    return { kind: "literal", value: r.value === "true" };
  }
  return { kind: "literal", value: r.value };
}

function rowsToYAMLLines(rows: ConditionRow[]): string[] {
  if (rows.length === 1) {
    const r = rows[0]!;
    return [`- ${r.op}: [${r.path}, ${formatValue(r)}]`];
  }
  const out: string[] = ["- and:"];
  for (const r of rows) {
    out.push(`    - ${r.op}: [${r.path}, ${formatValue(r)}]`);
  }
  return out;
}

function formatValue(r: ConditionRow): string {
  if (r.valueKind === "path") return r.value;
  if (r.valueKind === "number") return r.value;
  if (r.valueKind === "boolean") return r.value;
  return JSON.stringify(r.value);
}
