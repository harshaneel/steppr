package model

import (
	"strings"
	"testing"
)

func TestDataFlowValidation(t *testing.T) {
	tests := []struct {
		name          string
		wf            *WorkflowDef
		initialFields []string
		wantErrors    int
		wantContains  string
	}{
		{
			name: "linear chain valid",
			wf: &WorkflowDef{
				ID:    "ok",
				Start: "a",
				Nodes: []Node{
					{ID: "a", Type: NodeTypeEnhancer, Worker: "x", Schema: &FieldSchema{Reads: []string{"in"}, Produces: []string{"x"}}, NextNode: "b"},
					{ID: "b", Type: NodeTypeAction, Worker: "y", Schema: &FieldSchema{Reads: []string{"x"}, Produces: []string{"y"}}},
				},
			},
			initialFields: []string{"in"},
			wantErrors:    0,
		},
		{
			name: "missing field detected",
			wf: &WorkflowDef{
				ID:    "broken",
				Start: "a",
				Nodes: []Node{
					{ID: "a", Type: NodeTypeEnhancer, Worker: "x", Schema: &FieldSchema{Reads: []string{"in"}, Produces: []string{"validated"}}, NextNode: "b"},
					{ID: "b", Type: NodeTypeAction, Worker: "y", Schema: &FieldSchema{Reads: []string{"email_address"}}},
				},
			},
			initialFields: []string{"in"},
			wantErrors:    1,
			wantContains:  `reads field "email_address"`,
		},
		{
			name: "schema-less node skipped",
			wf: &WorkflowDef{
				ID:    "ok",
				Start: "a",
				Nodes: []Node{
					{ID: "a", Type: NodeTypeEnhancer, Worker: "x", NextNode: "b"}, // no schema
					{ID: "b", Type: NodeTypeAction, Worker: "y", Schema: &FieldSchema{Reads: []string{"in"}}},
				},
			},
			initialFields: []string{"in"},
			wantErrors:    0,
		},
		{
			name: "branches share ancestors",
			wf: &WorkflowDef{
				ID:    "filter",
				Start: "f",
				Nodes: []Node{
					{ID: "f", Type: NodeTypeFilter, Branches: []Branch{
						{Label: "a", NextNode: "left"},
						{Label: "b", NextNode: "right"},
					}, Schema: &FieldSchema{Reads: []string{"tier"}}},
					{ID: "left", Type: NodeTypeAction, Worker: "x", Schema: &FieldSchema{Reads: []string{"tier"}}},
					{ID: "right", Type: NodeTypeAction, Worker: "y", Schema: &FieldSchema{Reads: []string{"tier"}}},
				},
			},
			initialFields: []string{"tier"},
			wantErrors:    0,
		},
		{
			name: "branch can't see sibling's outputs",
			wf: &WorkflowDef{
				ID:    "filter",
				Start: "f",
				Nodes: []Node{
					{ID: "f", Type: NodeTypeFilter, Branches: []Branch{
						{Label: "a", NextNode: "left"},
						{Label: "b", NextNode: "right"},
					}},
					{ID: "left", Type: NodeTypeEnhancer, Worker: "x", Schema: &FieldSchema{Produces: []string{"left_field"}}},
					// right tries to read left's output — should fail
					{ID: "right", Type: NodeTypeAction, Worker: "y", Schema: &FieldSchema{Reads: []string{"left_field"}}},
				},
			},
			initialFields: []string{},
			wantErrors:    1,
			wantContains:  `node "right" reads field "left_field"`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			errs := ValidateDataFlow(tt.wf, tt.initialFields)
			if len(errs) != tt.wantErrors {
				t.Errorf("got %d errors, want %d: %v", len(errs), tt.wantErrors, errs)
			}
			if tt.wantContains != "" && len(errs) > 0 {
				combined := ""
				for _, e := range errs {
					combined += e.Error() + "\n"
				}
				if !strings.Contains(combined, tt.wantContains) {
					t.Errorf("expected error containing %q, got:\n%s", tt.wantContains, combined)
				}
			}
		})
	}
}
