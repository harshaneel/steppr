/**
 * Node-only StepprWorker. Wraps a handler registry behind an HTTP server
 * exposing GET /handlers (discovery) and POST /execute (invocation).
 *
 * Mirrors the Python SDK API. Browser code should import from "@steppr/sdk"
 * (the core package) and use InMemoryResolver instead.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { NodeResponse, WorkflowMessage } from "./types.js";

export type Handler = (msg: WorkflowMessage) =>
  | NodeResponse
  | Promise<NodeResponse>;

export interface StepprWorkerOptions {
  /** Port to listen on. Default 8080. */
  port?: number;
  /** Address to bind. Default 0.0.0.0. */
  host?: string;
}

export class StepprWorker {
  private readonly handlers = new Map<string, Handler>();
  private readonly opts: Required<StepprWorkerOptions>;

  constructor(opts: StepprWorkerOptions = {}) {
    this.opts = {
      port: opts.port ?? 8080,
      host: opts.host ?? "0.0.0.0",
    };
  }

  /** Register a handler for a node ID. */
  handler(nodeId: string, fn: Handler): this {
    this.handlers.set(nodeId, fn);
    return this;
  }

  /** Start the HTTP server. Resolves to a stop function. */
  async run(): Promise<() => Promise<void>> {
    const server = createServer((req, res) => this.dispatch(req, res));
    await new Promise<void>((resolve) => {
      server.listen(this.opts.port, this.opts.host, resolve);
    });
    // eslint-disable-next-line no-console
    console.log(
      `steppr worker listening on :${this.opts.port} (${this.handlers.size} handler(s))`,
    );
    return () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/handlers") {
      respond(res, 200, {
        node_ids: [...this.handlers.keys()].sort(),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/execute") {
      let body: WorkflowMessage;
      try {
        body = await readJson<WorkflowMessage>(req);
      } catch (err) {
        respond(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const fn = this.handlers.get(body.node_id);
      if (!fn) {
        respond(res, 400, { error: `no handler for node ${body.node_id}` });
        return;
      }
      try {
        const result = await fn(body);
        respond(res, 200, result);
      } catch (err) {
        respond(res, 500, {
          execution_id: body.execution_id,
          node_id: body.node_id,
          status: "failure",
          error: {
            code: "HANDLER_ERROR",
            message: err instanceof Error ? err.stack ?? err.message : String(err),
          },
        });
      }
      return;
    }
    respond(res, 404, { error: "not found" });
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(Buffer.byteLength(data)));
  res.end(data);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}
