/**
 * Fake worker registry for the in-browser demo.
 *
 * In a real Steppr deployment, workers register their handlers at the
 * orchestrator's /handlers endpoint and the WorkerRegistry tracks them.
 * Workflows then reference handler IDs and the orchestrator dispatches
 * messages over HTTP to whichever worker advertised that handler.
 *
 * This module pretends a few workers have already registered — purely
 * to surface the architectural concept in the simulator UI. Picking a
 * registered handler fills in id/stub/reads/produces; picking "Custom"
 * lets you invent one inline.
 */

export interface RegisteredHandler {
  id: string;
  type: "enhancer" | "action";
  worker: string;
  description: string;
  stubOutput: string;
  reads: string[];
  produces: string[];
}

export const REGISTERED_HANDLERS: RegisteredHandler[] = [
  {
    id: "validate_order",
    type: "enhancer",
    worker: "orders-svc",
    description: "Verify order_id and amount are well-formed.",
    stubOutput: '{ "validated": true }',
    reads: ["order_id", "amount"],
    produces: ["validated"],
  },
  {
    id: "enrich_customer",
    type: "enhancer",
    worker: "customer-svc",
    description: "Look up customer tier and loyalty points by tier.",
    stubOutput: '{ "customer_tier": "premium", "loyalty_points": 1200 }',
    reads: ["tier"],
    produces: ["customer_tier", "loyalty_points"],
  },
  {
    id: "apply_discount",
    type: "enhancer",
    worker: "pricing-svc",
    description: "Compute a discount and final amount.",
    stubOutput: '{ "discount": 22.50, "final_amount": 127.50 }',
    reads: ["amount"],
    produces: ["discount", "final_amount"],
  },
  {
    id: "compute_tax",
    type: "enhancer",
    worker: "pricing-svc",
    description: "Add jurisdictional sales tax to the order.",
    stubOutput: '{ "tax": 9.75, "tax_rate": 0.0775 }',
    reads: ["amount"],
    produces: ["tax", "tax_rate"],
  },
  {
    id: "classify",
    type: "enhancer",
    worker: "triage-svc",
    description: "Run an LLM classifier and assign a priority.",
    stubOutput: '{ "triaged": true, "priority": "high" }',
    reads: [],
    produces: ["priority"],
  },
  {
    id: "process_payment",
    type: "action",
    worker: "payments-svc",
    description: "Charge the configured payment method.",
    stubOutput: '{ "payment_status": "charged" }',
    reads: [],
    produces: [],
  },
  {
    id: "charge_card",
    type: "action",
    worker: "payments-svc",
    description: "Charge a credit card via Stripe.",
    stubOutput: '{ "charge_id": "ch_abc123", "status": "succeeded" }',
    reads: [],
    produces: [],
  },
  {
    id: "page_oncall",
    type: "action",
    worker: "alerts-svc",
    description: "Page the current on-call engineer via PagerDuty.",
    stubOutput: '{ "paged": true, "recipient": "oncall@example.com" }',
    reads: [],
    produces: [],
  },
  {
    id: "assign_queue",
    type: "action",
    worker: "support-svc",
    description: "Drop the ticket into a support queue.",
    stubOutput: '{ "queued": true, "queue": "support-l1" }',
    reads: [],
    produces: [],
  },
  {
    id: "auto_respond",
    type: "action",
    worker: "support-svc",
    description: "Send a templated auto-response.",
    stubOutput: '{ "auto_replied": true }',
    reads: [],
    produces: [],
  },
  {
    id: "send_email",
    type: "action",
    worker: "notify-svc",
    description: "Send a transactional email.",
    stubOutput: '{ "email_sent": true }',
    reads: [],
    produces: [],
  },
  {
    id: "send_sms",
    type: "action",
    worker: "notify-svc",
    description: "Send an SMS via Twilio.",
    stubOutput: '{ "sms_sent": true }',
    reads: [],
    produces: [],
  },
  {
    id: "send_slack",
    type: "action",
    worker: "notify-svc",
    description: "Post to the configured Slack channel.",
    stubOutput: '{ "slack_sent": true }',
    reads: [],
    produces: [],
  },
  {
    id: "send_webhook",
    type: "action",
    worker: "notify-svc",
    description: "Fire a generic outbound webhook.",
    stubOutput: '{ "webhook_status": 200 }',
    reads: [],
    produces: [],
  },
];

export function findHandler(id: string): RegisteredHandler | undefined {
  return REGISTERED_HANDLERS.find((h) => h.id === id);
}

export function handlersByType(t: "enhancer" | "action"): RegisteredHandler[] {
  return REGISTERED_HANDLERS.filter((h) => h.type === t);
}
