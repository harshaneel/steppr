/**
 * Workflow validator. Mirrors Go internal/model/validation.go and
 * internal/model/dataflow.go.
 *
 * Six checks:
 *   1. Unique node IDs
 *   2. Start node exists
 *   3. Per-node type correctness (filter has branches; enhancer/action don't)
 *   4. Referential integrity (all next_node references resolve)
 *   5. Acyclicity (DFS three-color cycle detection)
 *   6. Reachability from start
 *
 * Plus optional data-flow analysis when initialFields is provided.
 */

import type { Node, WorkflowDef } from "./types.js";

export class ValidationError extends Error {
  constructor(public errors: string[]) {
    super(
      `validation failed with ${errors.length} error(s):\n  - ${errors.join(
        "\n  - ",
      )}`,
    );
    this.name = "ValidationError";
  }
}

export interface ValidateOptions {
  /** Initial schema fields (enables data-flow validation when provided). */
  initialFields?: string[];
}

/** Validate the workflow. Throws ValidationError on failure. */
export function validate(wf: WorkflowDef, opts: ValidateOptions = {}): void {
  const errs: string[] = [];
  const nodes = new Map<string, Node>();

  // 1. unique IDs
  for (const n of wf.nodes) {
    if (nodes.has(n.id)) {
      errs.push(`duplicate node id: "${n.id}"`);
    }
    nodes.set(n.id, n);
  }

  // 2. start node exists
  if (!nodes.has(wf.start)) {
    errs.push(`start node "${wf.start}" not found in nodes`);
  }

  // 3. per-node type correctness
  for (const n of wf.nodes) {
    if (!["filter", "enhancer", "action"].includes(n.type)) {
      errs.push(
        `node "${n.id}" has invalid type "${n.type}" (must be filter, enhancer, or action)`,
      );
      continue;
    }
    if (n.type === "filter") {
      if (!n.branches || n.branches.length === 0) {
        errs.push(`filter node "${n.id}" must have at least one branch`);
      }
      if (n.next_node) {
        errs.push(
          `filter node "${n.id}" should use branches, not next_node`,
        );
      }
      for (let i = 0; i < (n.branches ?? []).length; i++) {
        const b = n.branches![i]!;
        if (!b.next_node) {
          errs.push(`filter node "${n.id}" branch ${i} missing next_node`);
        }
      }
    } else {
      if (n.branches && n.branches.length > 0) {
        errs.push(
          `${n.type} node "${n.id}" must not have branches (only filter nodes branch)`,
        );
      }
    }
    // worker URL is environment config, resolved at runtime via the registry.
  }

  // 4. referential integrity
  for (const n of wf.nodes) {
    for (const succ of successors(n)) {
      if (!nodes.has(succ)) {
        errs.push(`node "${n.id}" references undefined node "${succ}"`);
      }
    }
  }

  // 5. acyclicity (three-color DFS)
  const color = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray, 2=black
  const dfs = (id: string): boolean => {
    color.set(id, 1);
    const n = nodes.get(id);
    if (!n) return false;
    for (const succ of successors(n)) {
      const c = color.get(succ) ?? 0;
      if (c === 1) {
        errs.push(`cycle detected involving node "${id}" → "${succ}"`);
        return true;
      }
      if (c === 0 && dfs(succ)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const n of wf.nodes) {
    if ((color.get(n.id) ?? 0) === 0) dfs(n.id);
  }

  // 6. reachability from start
  if (nodes.has(wf.start)) {
    const reachable = new Set<string>();
    const walk = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const n = nodes.get(id);
      if (!n) return;
      for (const s of successors(n)) walk(s);
    };
    walk(wf.start);
    for (const n of wf.nodes) {
      if (!reachable.has(n.id)) {
        errs.push(`node "${n.id}" is unreachable from start node "${wf.start}"`);
      }
    }
  }

  // 7. non-merging (in-degree ≤ 1)
  const inDegree = new Map<string, number>();
  for (const n of wf.nodes) {
    for (const s of successors(n)) {
      inDegree.set(s, (inDegree.get(s) ?? 0) + 1);
    }
  }
  for (const [id, d] of inDegree) {
    if (d > 1) {
      errs.push(
        `node "${id}" has in-degree ${d} (must be ≤ 1; workflow must be non-merging)`,
      );
    }
  }

  // 8. data-flow (only if structure is sound and initialFields provided)
  if (errs.length === 0 && opts.initialFields !== undefined) {
    const dfErrs = checkDataFlow(wf, opts.initialFields);
    errs.push(...dfErrs);
  }

  if (errs.length > 0) {
    throw new ValidationError(errs);
  }
}

/** Returns all successor node IDs reachable from `n`. */
export function successors(n: Node): string[] {
  if (n.type === "filter") {
    return (n.branches ?? []).map((b) => b.next_node);
  }
  return n.next_node ? [n.next_node] : [];
}

// --- data-flow analysis --------------------------------------------------

function checkDataFlow(wf: WorkflowDef, initialFields: string[]): string[] {
  const errs: string[] = [];
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const start = nodes.get(wf.start);
  if (!start) return errs;

  const initialAvailable = new Set(initialFields);

  const visit = (node: Node, available: Set<string>): void => {
    if (node.schema?.reads) {
      for (const field of node.schema.reads) {
        if (!available.has(field)) {
          const ancestors = [...available].sort();
          errs.push(
            `node "${node.id}" reads field "${field}" but no ancestor produces it (reachable ancestors: [${ancestors.join(
              ", ",
            )}])`,
          );
        }
      }
    }

    let descendantSet = available;
    if (node.schema?.produces?.length) {
      descendantSet = new Set(available);
      for (const f of node.schema.produces) descendantSet.add(f);
    }

    for (const succId of successors(node)) {
      const succ = nodes.get(succId);
      if (succ) visit(succ, descendantSet);
    }
  };

  visit(start, initialAvailable);
  return errs;
}
