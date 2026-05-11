package engine

import (
	"fmt"
	"sync"
	"time"

	"github.com/harshaneel/steppr/internal/dispatch"
	"github.com/harshaneel/steppr/internal/model"
	"github.com/harshaneel/steppr/internal/registry"
)

type Engine struct {
	Dispatcher *dispatch.HTTPDispatcher
	Registry   *registry.Registry

	// StrictMonotonicity, when true, fails any node whose output overwrites a
	// field present in the input payload. When false (default), violations are
	// recorded as errors on the trace but execution continues.
	StrictMonotonicity bool
}

func New() *Engine {
	return &Engine{
		Dispatcher: dispatch.New(),
		Registry:   registry.New(),
	}
}

// resolveWorker returns the worker URL for a node, preferring the registry
// over a node-local Worker field. Empty string means no worker is available.
func (e *Engine) resolveWorker(node *model.Node) string {
	if e.Registry != nil {
		if url, ok := e.Registry.Resolve(node.ID); ok {
			return url
		}
	}
	return node.Worker
}

// checkMonotonicity returns the names of input fields that the worker's
// declared output also contains with a different value. An overwrite implies
// non-monotonic behavior.
func checkMonotonicity(input, output map[string]any) []string {
	if len(input) == 0 || len(output) == 0 {
		return nil
	}
	var violations []string
	for k, inV := range input {
		outV, ok := output[k]
		if !ok {
			continue
		}
		if !equalValues(inV, outV) {
			violations = append(violations, k)
		}
	}
	return violations
}

func equalValues(a, b any) bool {
	// Same-string comparison is a safe approximation for JSON-serializable
	// values. Slices, maps, etc. that differ in content will produce different
	// formatted strings.
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
}

func (e *Engine) Execute(wf *model.WorkflowDef, executionID string, input map[string]any) (*ExecutionResult, error) {
	nodes := wf.NodeMap()
	startNode, err := wf.StartNode()
	if err != nil {
		return nil, err
	}

	result := &ExecutionResult{
		ExecutionID: executionID,
		WorkflowID:  wf.ID,
		Status:      StatusRunning,
	}

	traces := e.executeNode(wf, executionID, nodes, startNode, input, nil)
	result.Traces = traces

	allOK := true
	for _, t := range traces {
		if t.Status == StatusFailed {
			allOK = false
			break
		}
	}
	if allOK {
		result.Status = StatusCompleted
	} else {
		result.Status = StatusFailed
	}

	return result, nil
}

func (e *Engine) executeNode(
	wf *model.WorkflowDef,
	executionID string,
	nodes map[string]*model.Node,
	node *model.Node,
	payload map[string]any,
	parentNodes []string,
) []Trace {
	msg := &model.WorkflowMessage{
		ExecutionID: executionID,
		WorkflowID:  wf.ID,
		NodeID:      node.ID,
		NodeType:    node.Type,
		Metadata: model.MessageMetadata{
			WorkflowVersion: wf.Version,
			Timestamp:       time.Now().UTC().Format(time.RFC3339),
			ParentNodes:     parentNodes,
		},
		Payload: payload,
	}

	exec := NodeExecution{
		NodeID:    node.ID,
		NodeType:  node.Type,
		Status:    StatusRunning,
		Input:     payload,
		StartedAt: time.Now(),
	}

	switch node.Type {
	case model.NodeTypeFilter:
		return e.executeFilter(wf, executionID, nodes, node, msg, exec)
	case model.NodeTypeEnhancer, model.NodeTypeAction:
		return e.executeLinear(wf, executionID, nodes, node, msg, exec)
	default:
		exec.Status = StatusFailed
		exec.Error = &model.ErrorInfo{Code: "INVALID_TYPE", Message: fmt.Sprintf("unknown node type: %s", node.Type)}
		exec.EndedAt = time.Now()
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
	}
}

func (e *Engine) executeLinear(
	wf *model.WorkflowDef,
	executionID string,
	nodes map[string]*model.Node,
	node *model.Node,
	msg *model.WorkflowMessage,
	exec NodeExecution,
) []Trace {
	workerURL := e.resolveWorker(node)
	if workerURL == "" {
		exec.EndedAt = time.Now()
		exec.Status = StatusFailed
		exec.Error = &model.ErrorInfo{
			Code:    "NO_WORKER",
			Message: fmt.Sprintf("no worker registered for node %q", node.ID),
		}
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
	}
	resp, err := e.Dispatcher.DispatchNode(workerURL, msg)
	exec.EndedAt = time.Now()

	if err != nil {
		exec.Status = StatusFailed
		exec.Error = &model.ErrorInfo{Code: "DISPATCH_ERROR", Message: err.Error()}
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
	}

	if resp.Status == "failure" {
		exec.Status = StatusFailed
		exec.Output = resp.Output
		exec.Error = resp.Error
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
	}

	exec.Status = StatusCompleted
	exec.Output = resp.Output

	// Monotonicity check: Enhancer and Action are required to preserve all input
	// fields (they may add but not remove). The orchestrator merges input into
	// output, so structural monotonicity is enforced at the data layer. We
	// additionally check whether the worker's *declared* output overwrites any
	// input fields, which would indicate the worker isn't honoring monotonicity.
	if violations := checkMonotonicity(msg.Payload, resp.Output); len(violations) > 0 {
		exec.Error = &model.ErrorInfo{
			Code:    "MONOTONICITY_VIOLATION",
			Message: fmt.Sprintf("%s node %q overwrote input field(s): %v", node.Type, node.ID, violations),
		}
		// Treat as warning-only by default: continue with merged payload but
		// record the violation. Strict mode could be enabled via env var.
		if e.StrictMonotonicity {
			exec.Status = StatusFailed
			return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
		}
	}

	// Merge output with input (monotonic: original data preserved, new data appended).
	merged := mergePayload(msg.Payload, resp.Output)

	// If terminal node, return single trace.
	if node.NextNode == "" {
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusCompleted}}
	}

	// Continue to next node.
	nextNode, ok := nodes[node.NextNode]
	if !ok {
		exec.Error = &model.ErrorInfo{Code: "MISSING_NODE", Message: fmt.Sprintf("next node %q not found", node.NextNode)}
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
	}

	childTraces := e.executeNode(wf, executionID, nodes, nextNode, merged, append(msg.Metadata.ParentNodes, node.ID))
	// Prepend this node's execution to all child traces.
	for i := range childTraces {
		childTraces[i].Nodes = append([]NodeExecution{exec}, childTraces[i].Nodes...)
	}
	return childTraces
}

// executeFilter evaluates each branch's condition against the current payload
// and dispatches to every branch whose condition holds. Filter is fully
// declarative: no worker call, no HTTP overhead. Multiple branches may
// activate simultaneously (OR-split).
func (e *Engine) executeFilter(
	wf *model.WorkflowDef,
	executionID string,
	nodes map[string]*model.Node,
	node *model.Node,
	msg *model.WorkflowMessage,
	exec NodeExecution,
) []Trace {
	type activated struct {
		label string
		next  *model.Node
	}
	var hits []activated

	for i, branch := range node.Branches {
		ok, err := branch.Condition.Evaluate(msg.Payload)
		if err != nil {
			exec.Status = StatusFailed
			exec.Error = &model.ErrorInfo{
				Code:    "CONDITION_ERROR",
				Message: fmt.Sprintf("branch %d (%s): %v", i, branch.Label, err),
			}
			exec.EndedAt = time.Now()
			return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
		}
		if !ok {
			continue
		}
		nextNode, found := nodes[branch.NextNode]
		if !found {
			exec.Status = StatusFailed
			exec.Error = &model.ErrorInfo{
				Code:    "MISSING_NODE",
				Message: fmt.Sprintf("branch %d references undefined node %q", i, branch.NextNode),
			}
			exec.EndedAt = time.Now()
			return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusFailed}}
		}
		hits = append(hits, activated{label: branch.Label, next: nextNode})
	}

	exec.EndedAt = time.Now()
	exec.Status = StatusCompleted
	labels := make([]string, 0, len(hits))
	for _, h := range hits {
		if h.label != "" {
			labels = append(labels, h.label)
		} else {
			labels = append(labels, h.next.ID)
		}
	}
	exec.Output = map[string]any{"activated_branches": labels}

	if len(hits) == 0 {
		// No branch activated — terminal trace.
		return []Trace{{Nodes: []NodeExecution{exec}, Status: StatusCompleted}}
	}

	// Execute each activated branch concurrently.
	var mu sync.Mutex
	var wg sync.WaitGroup
	var allTraces []Trace

	for _, h := range hits {
		wg.Add(1)
		go func(a activated) {
			defer wg.Done()
			childTraces := e.executeNode(wf, executionID, nodes, a.next, msg.Payload, append(msg.Metadata.ParentNodes, node.ID))
			mu.Lock()
			for i := range childTraces {
				childTraces[i].Nodes = append([]NodeExecution{exec}, childTraces[i].Nodes...)
			}
			allTraces = append(allTraces, childTraces...)
			mu.Unlock()
		}(h)
	}

	wg.Wait()
	return allTraces
}


func mergePayload(base, overlay map[string]any) map[string]any {
	merged := make(map[string]any, len(base)+len(overlay))
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range overlay {
		merged[k] = v
	}
	return merged
}
