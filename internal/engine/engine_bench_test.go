package engine

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/harshaneel/steppr/internal/model"
)

// BenchmarkLinearNodeDispatch measures the per-node overhead of dispatching
// a single Enhancer node to a local HTTP worker. This is the dominant cost
// in workflow execution.
func BenchmarkLinearNodeDispatch(b *testing.B) {
	// In-process httptest worker that echoes payload + a new field.
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg model.WorkflowMessage
		if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp := model.NodeResponse{
			ExecutionID: msg.ExecutionID,
			NodeID:      msg.NodeID,
			Status:      "success",
			Output:      map[string]any{"echoed": msg.NodeID},
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer worker.Close()

	wf := &model.WorkflowDef{
		ID:    "bench-linear",
		Start: "n1",
		Nodes: []model.Node{
			{ID: "n1", Type: model.NodeTypeEnhancer, Worker: worker.URL},
		},
	}

	eng := New()
	input := map[string]any{"x": 1}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := eng.Execute(wf, "exec-bench", input)
		if err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkFilterEvaluation measures the cost of in-process Filter
// condition evaluation (no worker call).
func BenchmarkFilterEvaluation(b *testing.B) {
	// 5-branch filter with non-trivial conditions.
	wf := &model.WorkflowDef{
		ID:    "bench-filter",
		Start: "f",
		Nodes: []model.Node{
			{ID: "f", Type: model.NodeTypeFilter, Branches: []model.Branch{
				{Label: "premium", NextNode: "leaf-a", Condition: parseCond(b, `- eq: [tier, "premium"]`)},
				{Label: "standard", NextNode: "leaf-b", Condition: parseCond(b, `- eq: [tier, "standard"]`)},
			}},
			{ID: "leaf-a", Type: model.NodeTypeEnhancer, Worker: "http://unused"},
			{ID: "leaf-b", Type: model.NodeTypeEnhancer, Worker: "http://unused"},
		},
	}

	// Stub worker that the leaves dispatch to (also httptest).
	leaf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg model.WorkflowMessage
		_ = json.NewDecoder(r.Body).Decode(&msg)
		_ = json.NewEncoder(w).Encode(model.NodeResponse{
			ExecutionID: msg.ExecutionID,
			NodeID:      msg.NodeID,
			Status:      "success",
			Output:      map[string]any{},
		})
	}))
	defer leaf.Close()
	wf.Nodes[1].Worker = leaf.URL
	wf.Nodes[2].Worker = leaf.URL

	eng := New()
	input := map[string]any{"tier": "premium"}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := eng.Execute(wf, "exec-bench", input)
		if err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkLinearChain10 measures end-to-end latency for a 10-node chain
// of Enhancers, all dispatching to the same in-process worker. The result
// shows how per-node HTTP overhead compounds over a sequential workflow.
func BenchmarkLinearChain10(b *testing.B) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg model.WorkflowMessage
		_ = json.NewDecoder(r.Body).Decode(&msg)
		_ = json.NewEncoder(w).Encode(model.NodeResponse{
			ExecutionID: msg.ExecutionID,
			NodeID:      msg.NodeID,
			Status:      "success",
			Output:      map[string]any{msg.NodeID + "_done": true},
		})
	}))
	defer worker.Close()

	const N = 10
	nodes := make([]model.Node, N)
	for i := 0; i < N; i++ {
		nodes[i] = model.Node{
			ID:     "n" + itoa(i),
			Type:   model.NodeTypeEnhancer,
			Worker: worker.URL,
		}
		if i < N-1 {
			nodes[i].NextNode = "n" + itoa(i+1)
		}
	}
	wf := &model.WorkflowDef{ID: "chain10", Start: "n0", Nodes: nodes}

	eng := New()
	input := map[string]any{"x": 1}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := eng.Execute(wf, "exec-bench", input)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func itoa(i int) string {
	if i < 10 {
		return string(rune('0' + i))
	}
	return string(rune('0'+i/10)) + string(rune('0'+i%10))
}

// BenchmarkValidation measures static validation cost on a small workflow.
func BenchmarkValidation(b *testing.B) {
	wf := &model.WorkflowDef{
		ID:    "bench",
		Start: "n1",
		Nodes: []model.Node{
			{ID: "n1", Type: model.NodeTypeEnhancer, Worker: "x", NextNode: "n2"},
			{ID: "n2", Type: model.NodeTypeEnhancer, Worker: "x", NextNode: "n3"},
			{ID: "n3", Type: model.NodeTypeAction, Worker: "x"},
		},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := model.Validate(wf); err != nil {
			b.Fatal(err)
		}
	}
}
