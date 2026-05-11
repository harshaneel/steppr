package model

import "fmt"

type NodeType string

const (
	NodeTypeFilter   NodeType = "filter"
	NodeTypeEnhancer NodeType = "enhancer"
	NodeTypeAction   NodeType = "action"
)

func (t NodeType) Valid() bool {
	switch t {
	case NodeTypeFilter, NodeTypeEnhancer, NodeTypeAction:
		return true
	}
	return false
}

// Branch is one outgoing edge from a Filter node, guarded by a structured
// condition expression evaluated against the data payload.
type Branch struct {
	Label     string     `yaml:"label,omitempty" json:"label,omitempty"`
	Condition *Condition `yaml:"condition,omitempty" json:"-"`
	NextNode  string     `yaml:"next_node" json:"next_node"`
}

// FieldSchema declares the fields a node reads from and writes to the payload.
// Used for static data-flow validation. Both lists are optional; an absent
// schema disables data-flow checking for that node.
type FieldSchema struct {
	Reads    []string `yaml:"reads,omitempty" json:"reads,omitempty"`
	Produces []string `yaml:"produces,omitempty" json:"produces,omitempty"`
}

type Node struct {
	ID       string       `yaml:"id" json:"id"`
	Type     NodeType     `yaml:"type" json:"type"`
	Worker   string       `yaml:"worker,omitempty" json:"worker,omitempty"`
	Branches []Branch     `yaml:"branches,omitempty" json:"branches,omitempty"`
	NextNode string       `yaml:"next_node,omitempty" json:"next_node,omitempty"`
	Schema   *FieldSchema `yaml:"schema,omitempty" json:"schema,omitempty"`
}

func (n *Node) Successors() []string {
	if n.Type == NodeTypeFilter {
		out := make([]string, 0, len(n.Branches))
		for _, b := range n.Branches {
			out = append(out, b.NextNode)
		}
		return out
	}
	if n.NextNode != "" {
		return []string{n.NextNode}
	}
	return nil
}

type WorkflowDef struct {
	ID      string `yaml:"id" json:"id"`
	Version string `yaml:"version" json:"version"`
	Start   string `yaml:"start" json:"start"`
	Nodes   []Node `yaml:"nodes" json:"nodes"`
}

func (w *WorkflowDef) NodeMap() map[string]*Node {
	m := make(map[string]*Node, len(w.Nodes))
	for i := range w.Nodes {
		m[w.Nodes[i].ID] = &w.Nodes[i]
	}
	return m
}

func (w *WorkflowDef) StartNode() (*Node, error) {
	m := w.NodeMap()
	n, ok := m[w.Start]
	if !ok {
		return nil, fmt.Errorf("start node %q not found", w.Start)
	}
	return n, nil
}
