// Package steppr provides a minimal Go worker SDK for Steppr workflows.
//
// The wire protocol matches the Python and TypeScript SDKs:
//   GET  /handlers  -> {"node_ids": [...]}
//   POST /execute   -> NodeResponse | FilterResponse JSON
//
// Workers register handlers per node ID using Worker.Handler and start
// the HTTP server with Worker.Run.
package steppr

// WorkflowMessage is the input the orchestrator sends to a worker for a
// single node invocation. The wire format mirrors internal/model.WorkflowMessage
// in the orchestrator; field tags fix the JSON keys.
type WorkflowMessage struct {
	ExecutionID string          `json:"execution_id"`
	WorkflowID  string          `json:"workflow_id"`
	NodeID      string          `json:"node_id"`
	NodeType    string          `json:"node_type"`
	Metadata    MessageMetadata `json:"metadata"`
	Payload     map[string]any  `json:"payload"`
}

// MessageMetadata captures execution-context fields the orchestrator
// supplies (and may extend over time).
type MessageMetadata struct {
	WorkflowVersion string   `json:"workflow_version"`
	Timestamp       string   `json:"timestamp"`
	ParentNodes     []string `json:"parent_nodes"`
}

// NodeResponse is the reply Enhancer and Action handlers return.
// Status is "success" or "failure". Output is merged into the payload
// flowing to downstream nodes.
type NodeResponse struct {
	ExecutionID string         `json:"execution_id"`
	NodeID      string         `json:"node_id"`
	Status      string         `json:"status"`
	Output      map[string]any `json:"output"`
	Error       *ErrorInfo     `json:"error,omitempty"`
}

// FilterResponse is reserved for Filter handlers when a worker chooses to
// implement filter logic itself rather than letting the orchestrator
// evaluate declarative conditions in-process.
type FilterResponse struct {
	ExecutionID string         `json:"execution_id"`
	NodeID      string         `json:"node_id"`
	Status      string         `json:"status"`
	Branches    []BranchResult `json:"branches"`
	Error       *ErrorInfo     `json:"error,omitempty"`
}

// BranchResult is one activated branch from a Filter handler.
type BranchResult struct {
	Condition string         `json:"condition"`
	Output    map[string]any `json:"output"`
	NextNode  string         `json:"next_node"`
}

// ErrorInfo is the structured error a worker can return on failure.
type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
