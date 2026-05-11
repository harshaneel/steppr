// Example Go worker for the order-processing workflow.
//
// Demonstrates Enhancer and Action node types. Filter nodes are evaluated
// in-process by the orchestrator and never reach a worker — see
// workflow.yaml for the structured condition syntax.
//
// Handlers in this file:
//   - Enhancer: validate_order, enrich_customer, apply_discount
//   - Action:   process_payment, process_payment_premium
//
// Run:
//   go run .
//
// Then in another terminal, from repo root:
//   go run ./cmd/steppr run examples/order-processing/workflow.yaml \
//       --workers http://localhost:9001 \
//       --input '{"order_id":"ORD-42","tier":"premium","amount":150.00}'
package main

import (
	"fmt"
	"log"

	steppr "github.com/harshaneel/steppr/sdk/go"
)

func main() {
	worker := steppr.New(9001)

	// --- Enhancer: validate order data ---
	worker.HandlerNode("validate_order", func(msg *steppr.WorkflowMessage) (map[string]any, error) {
		errors := []string{}
		if _, ok := msg.Payload["order_id"]; !ok {
			errors = append(errors, "missing order_id")
		}
		if _, ok := msg.Payload["amount"]; !ok {
			errors = append(errors, "missing amount")
		}
		out := mergeMap(msg.Payload, map[string]any{
			"validated":         len(errors) == 0,
			"validation_errors": errors,
		})
		return out, nil
	})

	// --- Enhancer: enrich with customer data ---
	worker.HandlerNode("enrich_customer", func(msg *steppr.WorkflowMessage) (map[string]any, error) {
		tier, _ := msg.Payload["tier"].(string)
		if tier == "" {
			tier = "standard"
		}
		points := 100
		if tier == "premium" {
			points = 1200
		}
		return mergeMap(msg.Payload, map[string]any{
			"customer_tier":  tier,
			"loyalty_points": points,
		}), nil
	})

	// --- Enhancer: apply premium discount ---
	worker.HandlerNode("apply_discount", func(msg *steppr.WorkflowMessage) (map[string]any, error) {
		amount := numberOrZero(msg.Payload["amount"])
		discount := round2(amount * 0.15)
		return mergeMap(msg.Payload, map[string]any{
			"discount":     discount,
			"final_amount": round2(amount - discount),
		}), nil
	})

	// --- Action: process payment (standard) ---
	worker.HandlerNode("process_payment", func(msg *steppr.WorkflowMessage) (map[string]any, error) {
		amount := numberOrZero(msg.Payload["amount"])
		fmt.Printf("  [ACTION] Processing standard payment: $%.2f for order %v\n",
			amount, msg.Payload["order_id"])
		return mergeMap(msg.Payload, map[string]any{
			"payment_status": "charged",
			"payment_amount": amount,
		}), nil
	})

	// --- Action: process premium payment ---
	worker.HandlerNode("process_payment_premium", func(msg *steppr.WorkflowMessage) (map[string]any, error) {
		final := numberOrZero(msg.Payload["final_amount"])
		if final == 0 {
			final = numberOrZero(msg.Payload["amount"])
		}
		fmt.Printf("  [ACTION] Processing premium payment: $%.2f for order %v (discount: $%.2f)\n",
			final, msg.Payload["order_id"], numberOrZero(msg.Payload["discount"]))
		return mergeMap(msg.Payload, map[string]any{
			"payment_status": "charged",
			"payment_amount": final,
		}), nil
	})

	if err := worker.Run(); err != nil {
		log.Fatalf("worker exited: %v", err)
	}
}

// mergeMap returns a new map with the entries of base shallow-merged with
// the entries of overlay (overlay wins on conflict). Mirrors Python's
// `{**base, **overlay}` for handler outputs.
func mergeMap(base, overlay map[string]any) map[string]any {
	out := make(map[string]any, len(base)+len(overlay))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range overlay {
		out[k] = v
	}
	return out
}

// numberOrZero coerces a JSON-decoded value to float64. JSON numbers
// arrive as float64 already; integer-typed payload values are also handled.
func numberOrZero(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	default:
		return 0
	}
}

func round2(f float64) float64 {
	// Round to 2 decimals to match the Python worker's behavior.
	return float64(int64(f*100+0.5)) / 100
}
