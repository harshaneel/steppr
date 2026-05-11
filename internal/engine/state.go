package engine

import (
	"time"

	"github.com/harshaneel/steppr/internal/model"
)

type ExecutionStatus string

const (
	StatusRunning   ExecutionStatus = "running"
	StatusCompleted ExecutionStatus = "completed"
	StatusFailed    ExecutionStatus = "failed"
)

type NodeExecution struct {
	NodeID    string          `json:"node_id"`
	NodeType  model.NodeType  `json:"node_type"`
	Status    ExecutionStatus `json:"status"`
	Input     map[string]any  `json:"input"`
	Output    map[string]any  `json:"output,omitempty"`
	Error     *model.ErrorInfo `json:"error,omitempty"`
	StartedAt time.Time       `json:"started_at"`
	EndedAt   time.Time       `json:"ended_at,omitempty"`
}

type Trace struct {
	Nodes  []NodeExecution `json:"nodes"`
	Status ExecutionStatus `json:"status"`
}

type ExecutionResult struct {
	ExecutionID string          `json:"execution_id"`
	WorkflowID  string          `json:"workflow_id"`
	Status      ExecutionStatus `json:"status"`
	Traces      []Trace         `json:"traces"`
}
