package model

type WorkflowMessage struct {
	ExecutionID string            `json:"execution_id"`
	WorkflowID  string            `json:"workflow_id"`
	NodeID      string            `json:"node_id"`
	NodeType    NodeType          `json:"node_type"`
	Metadata    MessageMetadata   `json:"metadata"`
	Payload     map[string]any    `json:"payload"`
}

type MessageMetadata struct {
	WorkflowVersion string   `json:"workflow_version"`
	Timestamp       string   `json:"timestamp"`
	ParentNodes     []string `json:"parent_nodes"`
}

type NodeResponse struct {
	ExecutionID string         `json:"execution_id"`
	NodeID      string         `json:"node_id"`
	Status      string         `json:"status"`
	Output      map[string]any `json:"output"`
	Error       *ErrorInfo     `json:"error,omitempty"`
}

type FilterResponse struct {
	ExecutionID string         `json:"execution_id"`
	NodeID      string         `json:"node_id"`
	Status      string         `json:"status"`
	Branches    []BranchResult `json:"branches"`
	Error       *ErrorInfo     `json:"error,omitempty"`
}

type BranchResult struct {
	Condition string         `json:"condition"`
	Output    map[string]any `json:"output"`
	NextNode  string         `json:"next_node"`
}

type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
