/** Pre-built example workflows. */

import type { EditableWorkflow } from "./workflow-store.js";

export interface Example {
  id: string;
  title: string;
  description: string;
  workflow: EditableWorkflow;
  payload: string;
}

const orderProcessing: Example = {
  id: "order-processing",
  title: "Order processing",
  description:
    "Validate, enrich, route by tier, and process payment. Premium orders get a 15% discount.",
  workflow: {
    id: "order-processing",
    start: "validate_order",
    nodes: [
      {
        id: "validate_order",
        type: "enhancer",
        next_node: "enrich_customer",
        reads: ["order_id", "amount"],
        produces: ["validated"],
        stubOutput: '{ "validated": true }',
      },
      {
        id: "enrich_customer",
        type: "enhancer",
        next_node: "route_by_tier",
        reads: ["tier"],
        produces: ["customer_tier", "loyalty_points"],
        stubOutput: '{ "customer_tier": "premium", "loyalty_points": 1200 }',
      },
      {
        id: "route_by_tier",
        type: "filter",
        reads: [],
        produces: [],
        branches: [
          {
            label: "premium",
            next_node: "apply_discount",
            rows: [{ op: "eq", path: "tier", value: "premium", valueKind: "string" }],
          },
          {
            label: "standard",
            next_node: "process_payment",
            rows: [{ op: "eq", path: "tier", value: "standard", valueKind: "string" }],
          },
        ],
      },
      {
        id: "apply_discount",
        type: "enhancer",
        next_node: "process_payment_premium",
        reads: ["amount"],
        produces: ["discount", "final_amount"],
        stubOutput: '{ "discount": 22.50, "final_amount": 127.50 }',
      },
      {
        id: "process_payment_premium",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "payment_status": "charged" }',
      },
      {
        id: "process_payment",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "payment_status": "charged" }',
      },
    ],
  },
  payload: `{
  "order_id": "ORD-42",
  "tier": "premium",
  "amount": 150.00
}
`,
};

const supportTriage: Example = {
  id: "support-triage",
  title: "Support ticket triage",
  description:
    "Route a ticket by priority. High → page on-call. Medium → assign to queue. Low → auto-respond.",
  workflow: {
    id: "support-triage",
    start: "classify",
    nodes: [
      {
        id: "classify",
        type: "enhancer",
        next_node: "route",
        reads: [],
        produces: [],
        stubOutput: '{ "triaged": true }',
      },
      {
        id: "route",
        type: "filter",
        reads: [],
        produces: [],
        branches: [
          {
            label: "high",
            next_node: "page_oncall",
            rows: [{ op: "eq", path: "priority", value: "high", valueKind: "string" }],
          },
          {
            label: "medium",
            next_node: "assign_queue",
            rows: [{ op: "eq", path: "priority", value: "medium", valueKind: "string" }],
          },
          {
            label: "low",
            next_node: "auto_respond",
            rows: [{ op: "eq", path: "priority", value: "low", valueKind: "string" }],
          },
        ],
      },
      {
        id: "page_oncall",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "paged": true, "recipient": "oncall@example.com" }',
      },
      {
        id: "assign_queue",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "queued": true, "queue": "support-l1" }',
      },
      {
        id: "auto_respond",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "auto_replied": true }',
      },
    ],
  },
  payload: `{
  "ticket_id": "T-1234",
  "priority": "high",
  "subject": "production outage"
}
`,
};

const fanout: Example = {
  id: "notification-fanout",
  title: "Notification fan-out (multi-channel)",
  description:
    "A Filter where multiple branches activate. Sends email, SMS, and Slack based on consent flags.",
  workflow: {
    id: "notification-fanout",
    start: "route_channels",
    nodes: [
      {
        id: "route_channels",
        type: "filter",
        reads: [],
        produces: [],
        branches: [
          {
            label: "email",
            next_node: "send_email",
            rows: [{ op: "eq", path: "email_consent", value: "true", valueKind: "boolean" }],
          },
          {
            label: "sms",
            next_node: "send_sms",
            rows: [{ op: "eq", path: "sms_consent", value: "true", valueKind: "boolean" }],
          },
          {
            label: "slack",
            next_node: "send_slack",
            rows: [{ op: "eq", path: "slack_consent", value: "true", valueKind: "boolean" }],
          },
        ],
      },
      {
        id: "send_email",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "email_sent": true }',
      },
      {
        id: "send_sms",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "sms_sent": true }',
      },
      {
        id: "send_slack",
        type: "action",
        reads: [],
        produces: [],
        stubOutput: '{ "slack_sent": true }',
      },
    ],
  },
  payload: `{
  "user_id": "U-99",
  "email_consent": true,
  "sms_consent": true,
  "slack_consent": false
}
`,
};

export const EXAMPLES: Example[] = [orderProcessing, supportTriage, fanout];
export const DEFAULT_EXAMPLE_ID = "order-processing";
