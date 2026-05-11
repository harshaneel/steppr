/**
 * Example TypeScript worker for the order-processing workflow.
 *
 * Mirrors the Python worker. Demonstrates Enhancer and Action handlers.
 * Filter nodes are evaluated by the orchestrator and never reach a worker.
 *
 * Run from the repo root:
 *   cd sdk/typescript && npm install && npm run build
 *   npx tsx examples/order-processing/workers/typescript/main.ts
 *
 * Then in another terminal:
 *   ./steppr run examples/order-processing/workflow.yaml \
 *     --workers http://localhost:9001 \
 *     --input '{"order_id":"ORD-42","tier":"premium","amount":150.00}'
 */

import { StepprWorker } from "@steppr/sdk/worker";
import type { WorkflowMessage, NodeResponse } from "@steppr/sdk";

const worker = new StepprWorker({ port: 9001 });

const ok = (msg: WorkflowMessage, output: Record<string, unknown>): NodeResponse => ({
  execution_id: msg.execution_id,
  node_id: msg.node_id,
  status: "success",
  output,
});

worker.handler("validate_order", (msg) => {
  const p = msg.payload as { order_id?: string; amount?: number };
  const errors: string[] = [];
  if (!p.order_id) errors.push("missing order_id");
  if (!p.amount) errors.push("missing amount");
  return {
    execution_id: msg.execution_id,
    node_id: msg.node_id,
    status: errors.length === 0 ? "success" : "failure",
    output: { ...msg.payload, validated: errors.length === 0, validation_errors: errors },
  };
});

worker.handler("enrich_customer", (msg) => {
  const tier = (msg.payload as { tier?: string }).tier ?? "standard";
  return ok(msg, {
    ...msg.payload,
    customer_tier: tier,
    loyalty_points: tier === "premium" ? 1200 : 100,
  });
});

worker.handler("apply_discount", (msg) => {
  const amount = ((msg.payload as { amount?: number }).amount ?? 0);
  const discount = Math.round(amount * 0.15 * 100) / 100;
  return ok(msg, {
    ...msg.payload,
    discount,
    final_amount: Math.round((amount - discount) * 100) / 100,
  });
});

worker.handler("process_payment", (msg) => {
  const amount = ((msg.payload as { amount?: number }).amount ?? 0);
  // eslint-disable-next-line no-console
  console.log(`  [ACTION] Standard payment: $${amount.toFixed(2)} for ${(msg.payload as { order_id?: string }).order_id}`);
  return ok(msg, { ...msg.payload, payment_status: "charged", payment_amount: amount });
});

worker.handler("process_payment_premium", (msg) => {
  const p = msg.payload as { final_amount?: number; amount?: number; order_id?: string; discount?: number };
  const final = p.final_amount ?? p.amount ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    `  [ACTION] Premium payment: $${final.toFixed(2)} for ${p.order_id} (discount $${(p.discount ?? 0).toFixed(2)})`,
  );
  return ok(msg, { ...msg.payload, payment_status: "charged", payment_amount: final });
});

await worker.run();
