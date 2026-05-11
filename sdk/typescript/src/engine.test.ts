import { describe, expect, it } from "vitest";
import { Engine, InMemoryResolver } from "./engine.js";
import { parse } from "./parser.js";
import type { NodeResponse, WorkflowMessage } from "./types.js";

const ORDER_WORKFLOW = `
id: order-processing
version: "1.0"
start: validate_order

nodes:
  - id: validate_order
    type: enhancer
    next_node: enrich_customer

  - id: enrich_customer
    type: enhancer
    next_node: route_by_tier

  - id: route_by_tier
    type: filter
    branches:
      - label: premium
        condition:
          - eq: [tier, "premium"]
        next_node: apply_discount
      - label: standard
        condition:
          - eq: [tier, "standard"]
        next_node: process_payment

  - id: apply_discount
    type: enhancer
    next_node: process_payment_premium

  - id: process_payment_premium
    type: action

  - id: process_payment
    type: action
`;

function ok(msg: WorkflowMessage, output: Record<string, unknown> = {}): NodeResponse {
  return {
    execution_id: msg.execution_id,
    node_id: msg.node_id,
    status: "success",
    output,
  };
}

describe("engine end-to-end", () => {
  it("runs the premium branch", async () => {
    const wf = parse(ORDER_WORKFLOW);
    const r = new InMemoryResolver();
    r.register("validate_order", (m) => ok(m, { ...m.payload, validated: true }));
    r.register("enrich_customer", (m) => ok(m, { ...m.payload, customer_tier: m.payload.tier }));
    r.register("apply_discount", (m) => ok(m, { ...m.payload, discount: 22.5 }));
    r.register("process_payment_premium", (m) => ok(m, { ...m.payload, payment_status: "charged" }));
    r.register("process_payment", (m) => ok(m, { ...m.payload, payment_status: "charged" }));

    const eng = new Engine(r);
    const result = await eng.execute(wf, "exec-test", {
      order_id: "ORD-42",
      tier: "premium",
      amount: 150,
    });

    expect(result.status).toBe("completed");
    expect(result.traces).toHaveLength(1);
    const trace = result.traces[0]!;
    const ids = trace.nodes.map((n) => n.node_id);
    expect(ids).toEqual([
      "validate_order",
      "enrich_customer",
      "route_by_tier",
      "apply_discount",
      "process_payment_premium",
    ]);
  });

  it("runs the standard branch", async () => {
    const wf = parse(ORDER_WORKFLOW);
    const r = new InMemoryResolver();
    r.register("validate_order", (m) => ok(m, m.payload));
    r.register("enrich_customer", (m) => ok(m, m.payload));
    r.register("apply_discount", (m) => ok(m, m.payload));
    r.register("process_payment_premium", (m) => ok(m, m.payload));
    r.register("process_payment", (m) => ok(m, m.payload));

    const eng = new Engine(r);
    const result = await eng.execute(wf, "exec-test", {
      order_id: "ORD-99",
      tier: "standard",
      amount: 50,
    });

    expect(result.status).toBe("completed");
    const ids = result.traces[0]!.nodes.map((n) => n.node_id);
    expect(ids).toEqual([
      "validate_order",
      "enrich_customer",
      "route_by_tier",
      "process_payment",
    ]);
  });

  it("fails fast when no resolver matches", async () => {
    const wf = parse(ORDER_WORKFLOW);
    const r = new InMemoryResolver(); // no handlers registered
    const eng = new Engine(r);
    const result = await eng.execute(wf, "exec-test", {
      order_id: "ORD-1",
      tier: "premium",
      amount: 10,
    });
    expect(result.status).toBe("failed");
    const failedTrace = result.traces[0]!;
    expect(failedTrace.nodes[0]!.error?.code).toBe("NO_WORKER");
  });

  it("propagates handler failures", async () => {
    const wf = parse(ORDER_WORKFLOW);
    const r = new InMemoryResolver();
    r.register("validate_order", () => {
      throw new Error("synthetic boom");
    });
    const eng = new Engine(r);
    const result = await eng.execute(wf, "exec-test", { tier: "premium" });
    expect(result.status).toBe("failed");
    expect(result.traces[0]!.nodes[0]!.error?.code).toBe("DISPATCH_ERROR");
  });
});
