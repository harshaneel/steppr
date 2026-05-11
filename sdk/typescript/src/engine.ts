/**
 * Execution engine. Walks a workflow tree and dispatches each node to a
 * caller-supplied HandlerResolver. Filter nodes are evaluated in-process.
 *
 * Two resolver strategies ship with the SDK:
 *   - InMemoryResolver: handlers are JS functions. Use in browser simulators.
 *   - HttpResolver:     handlers are remote workers. Use in Node deployments.
 */

import { evaluate } from "./condition.js";
import type {
  ExecutionResult,
  Node,
  NodeExecution,
  NodeResponse,
  Payload,
  Trace,
  WorkflowDef,
  WorkflowMessage,
} from "./types.js";

/** Resolves a node ID to an executor capable of running the node. */
export interface HandlerResolver {
  /**
   * Returns true iff the resolver can serve the given node ID.
   * Used at startup to verify workflow coverage.
   */
  has(nodeId: string): boolean;

  /** Execute a single Enhancer or Action node and return its response. */
  execute(msg: WorkflowMessage): Promise<NodeResponse>;
}

export interface EngineOptions {
  /** When true, fail any node whose output overwrites an input field. */
  strictMonotonicity?: boolean;
}

export class Engine {
  constructor(
    private readonly resolver: HandlerResolver,
    private readonly opts: EngineOptions = {},
  ) {}

  async execute(
    wf: WorkflowDef,
    executionId: string,
    input: Payload,
  ): Promise<ExecutionResult> {
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
    const start = nodes.get(wf.start);
    if (!start) {
      throw new Error(`start node "${wf.start}" not found`);
    }

    const traces = await this.executeNode(wf, executionId, nodes, start, input, []);

    const allOK = traces.every((t) => t.status === "completed");
    return {
      execution_id: executionId,
      workflow_id: wf.id,
      status: allOK ? "completed" : "failed",
      traces,
    };
  }

  private async executeNode(
    wf: WorkflowDef,
    executionId: string,
    nodes: Map<string, Node>,
    node: Node,
    payload: Payload,
    parents: string[],
  ): Promise<Trace[]> {
    const exec: NodeExecution = {
      node_id: node.id,
      node_type: node.type,
      status: "running",
      input: { ...payload },
      started_at: new Date().toISOString(),
    };

    const msg: WorkflowMessage = {
      execution_id: executionId,
      workflow_id: wf.id,
      node_id: node.id,
      node_type: node.type,
      metadata: {
        workflow_version: wf.version ?? "",
        timestamp: new Date().toISOString(),
        parent_nodes: [...parents],
      },
      payload,
    };

    if (node.type === "filter") {
      return this.executeFilter(wf, executionId, nodes, node, msg, exec);
    }
    return this.executeLinear(wf, executionId, nodes, node, msg, exec);
  }

  private async executeLinear(
    wf: WorkflowDef,
    executionId: string,
    nodes: Map<string, Node>,
    node: Node,
    msg: WorkflowMessage,
    exec: NodeExecution,
  ): Promise<Trace[]> {
    if (!this.resolver.has(node.id)) {
      exec.status = "failed";
      exec.error = {
        code: "NO_WORKER",
        message: `no worker registered for node "${node.id}"`,
      };
      exec.ended_at = new Date().toISOString();
      return [{ nodes: [exec], status: "failed" }];
    }

    let resp: NodeResponse;
    try {
      resp = await this.resolver.execute(msg);
    } catch (err) {
      exec.status = "failed";
      exec.error = {
        code: "DISPATCH_ERROR",
        message: err instanceof Error ? err.message : String(err),
      };
      exec.ended_at = new Date().toISOString();
      return [{ nodes: [exec], status: "failed" }];
    }

    exec.ended_at = new Date().toISOString();

    if (resp.status === "failure") {
      exec.status = "failed";
      exec.output = resp.output;
      exec.error = resp.error;
      return [{ nodes: [exec], status: "failed" }];
    }

    exec.status = "completed";
    exec.output = resp.output;

    // Monotonicity check.
    const violations = checkMonotonicity(msg.payload, resp.output);
    if (violations.length > 0 && this.opts.strictMonotonicity) {
      exec.status = "failed";
      exec.error = {
        code: "MONOTONICITY_VIOLATION",
        message: `${node.type} node "${node.id}" overwrote input field(s): ${violations.join(", ")}`,
      };
      return [{ nodes: [exec], status: "failed" }];
    }

    const merged = { ...msg.payload, ...resp.output };

    if (!node.next_node) {
      return [{ nodes: [exec], status: "completed" }];
    }
    const next = nodes.get(node.next_node);
    if (!next) {
      exec.error = {
        code: "MISSING_NODE",
        message: `next node "${node.next_node}" not found`,
      };
      return [{ nodes: [exec], status: "failed" }];
    }

    const childTraces = await this.executeNode(
      wf,
      executionId,
      nodes,
      next,
      merged,
      [...msg.metadata.parent_nodes, node.id],
    );
    return childTraces.map((t) => ({
      nodes: [exec, ...t.nodes],
      status: t.status,
    }));
  }

  private async executeFilter(
    wf: WorkflowDef,
    executionId: string,
    nodes: Map<string, Node>,
    node: Node,
    msg: WorkflowMessage,
    exec: NodeExecution,
  ): Promise<Trace[]> {
    const hits: { label: string; next: Node }[] = [];

    for (let i = 0; i < (node.branches ?? []).length; i++) {
      const branch = node.branches![i]!;
      let activated: boolean;
      try {
        activated = evaluate(branch.condition, msg.payload);
      } catch (err) {
        exec.status = "failed";
        exec.error = {
          code: "CONDITION_ERROR",
          message: `branch ${i} (${branch.label ?? ""}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
        exec.ended_at = new Date().toISOString();
        return [{ nodes: [exec], status: "failed" }];
      }
      if (!activated) continue;
      const next = nodes.get(branch.next_node);
      if (!next) {
        exec.status = "failed";
        exec.error = {
          code: "MISSING_NODE",
          message: `branch ${i} references undefined node "${branch.next_node}"`,
        };
        exec.ended_at = new Date().toISOString();
        return [{ nodes: [exec], status: "failed" }];
      }
      hits.push({ label: branch.label ?? next.id, next });
    }

    exec.ended_at = new Date().toISOString();
    exec.status = "completed";
    exec.output = { activated_branches: hits.map((h) => h.label) };

    if (hits.length === 0) {
      return [{ nodes: [exec], status: "completed" }];
    }

    // Execute every activated branch. Branches are independent (non-merging),
    // so we can run them in parallel via Promise.all.
    const childResults = await Promise.all(
      hits.map((h) =>
        this.executeNode(
          wf,
          executionId,
          nodes,
          h.next,
          msg.payload,
          [...msg.metadata.parent_nodes, node.id],
        ),
      ),
    );

    const allTraces: Trace[] = [];
    for (const traces of childResults) {
      for (const t of traces) {
        allTraces.push({
          nodes: [exec, ...t.nodes],
          status: t.status,
        });
      }
    }
    return allTraces;
  }
}

// --- Resolvers -------------------------------------------------------------

/** In-memory resolver: handlers are local async JS functions. */
export class InMemoryResolver implements HandlerResolver {
  private readonly handlers = new Map<
    string,
    (msg: WorkflowMessage) => Promise<NodeResponse> | NodeResponse
  >();

  register(
    nodeId: string,
    handler: (msg: WorkflowMessage) => Promise<NodeResponse> | NodeResponse,
  ): void {
    this.handlers.set(nodeId, handler);
  }

  has(nodeId: string): boolean {
    return this.handlers.has(nodeId);
  }

  async execute(msg: WorkflowMessage): Promise<NodeResponse> {
    const fn = this.handlers.get(msg.node_id);
    if (!fn) {
      throw new Error(`no handler for node "${msg.node_id}"`);
    }
    return await fn(msg);
  }
}

/**
 * HTTP resolver: dispatches each node to a remote worker.
 * Discovers handlers at construction time via GET /handlers.
 */
export class HttpResolver implements HandlerResolver {
  private readonly registry = new Map<string, string[]>();
  private readonly counter = new Map<string, number>();

  /** Construct a resolver and discover handlers from each worker URL. */
  static async discover(workerURLs: string[], timeoutMs = 5000): Promise<HttpResolver> {
    const r = new HttpResolver();
    for (const url of workerURLs) {
      const ids = await fetchHandlers(url, timeoutMs);
      r.register(url, ids);
    }
    return r;
  }

  register(workerURL: string, nodeIds: string[]): void {
    for (const id of nodeIds) {
      const list = this.registry.get(id) ?? [];
      if (!list.includes(workerURL)) list.push(workerURL);
      this.registry.set(id, list);
    }
  }

  has(nodeId: string): boolean {
    return (this.registry.get(nodeId)?.length ?? 0) > 0;
  }

  async execute(msg: WorkflowMessage): Promise<NodeResponse> {
    const urls = this.registry.get(msg.node_id) ?? [];
    if (urls.length === 0) {
      throw new Error(`no worker registered for node "${msg.node_id}"`);
    }
    const idx = (this.counter.get(msg.node_id) ?? 0) % urls.length;
    this.counter.set(msg.node_id, idx + 1);
    const url = urls[idx]!;

    const resp = await fetch(`${url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    });
    if (!resp.ok) {
      throw new Error(`worker ${url} returned ${resp.status}`);
    }
    return (await resp.json()) as NodeResponse;
  }
}

async function fetchHandlers(url: string, timeoutMs: number): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/handlers`, { signal: controller.signal });
    if (!r.ok) throw new Error(`worker ${url}/handlers returned ${r.status}`);
    const body = (await r.json()) as { node_ids?: string[] };
    return body.node_ids ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function checkMonotonicity(input: Payload, output: Payload): string[] {
  const violations: string[] = [];
  for (const k of Object.keys(input)) {
    if (k in output && JSON.stringify(input[k]) !== JSON.stringify(output[k])) {
      violations.push(k);
    }
  }
  return violations;
}
