"""Example Python worker for the order-processing workflow.

Demonstrates Enhancer and Action node types. Filter nodes are evaluated
in-process by the orchestrator and never reach a worker — see workflow.yaml
for the structured condition syntax.

Handlers in this file:
  - Enhancer: validate_order, enrich_customer, apply_discount
  - Action:   process_payment, process_payment_premium

Run:
  python main.py

Then in another terminal:
  steppr run ../../workflow.yaml --input '{"order_id": "ORD-42", "tier": "premium", "amount": 150.00}'
"""

import sys
import os

# Add SDK to path for development.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "sdk", "python"))

from steppr import StepprWorker, NodeResponse

worker = StepprWorker(port=9001)


# --- Enhancer: validate order data ---
@worker.handler("validate_order")
def validate_order(msg):
    payload = msg.payload
    errors = []
    if not payload.get("order_id"):
        errors.append("missing order_id")
    if not payload.get("amount"):
        errors.append("missing amount")

    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success" if not errors else "failure",
        output={**payload, "validated": len(errors) == 0, "validation_errors": errors},
    )


# --- Enhancer: enrich with customer data ---
@worker.handler("enrich_customer")
def enrich_customer(msg):
    payload = msg.payload
    tier = payload.get("tier", "standard")
    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success",
        output={**payload, "customer_tier": tier, "loyalty_points": 1200 if tier == "premium" else 100},
    )


# --- Enhancer: apply premium discount ---
@worker.handler("apply_discount")
def apply_discount(msg):
    payload = msg.payload
    amount = payload.get("amount", 0)
    discount = round(amount * 0.15, 2)
    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success",
        output={**payload, "discount": discount, "final_amount": round(amount - discount, 2)},
    )


# --- Action: process payment (standard) ---
@worker.handler("process_payment")
def process_payment(msg):
    payload = msg.payload
    amount = payload.get("amount", 0)
    print(f"  [ACTION] Processing standard payment: ${amount:.2f} for order {payload.get('order_id')}")
    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success",
        output={**payload, "payment_status": "charged", "payment_amount": amount},
    )


# --- Action: process premium payment ---
@worker.handler("process_payment_premium")
def process_payment_premium(msg):
    payload = msg.payload
    final = payload.get("final_amount", payload.get("amount", 0))
    print(f"  [ACTION] Processing premium payment: ${final:.2f} for order {payload.get('order_id')} (discount: ${payload.get('discount', 0):.2f})")
    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success",
        output={**payload, "payment_status": "charged", "payment_amount": final},
    )


if __name__ == "__main__":
    worker.run()
