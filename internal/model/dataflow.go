package model

import (
	"fmt"
	"sort"
	"strings"
)

// DataFlowError describes a single missing-field bug detected by the
// data-flow validator.
type DataFlowError struct {
	NodeID            string
	Field             string
	ReachableAncestors []string
}

func (e *DataFlowError) Error() string {
	return fmt.Sprintf("node %q reads field %q but no ancestor produces it (reachable ancestors: [%s])",
		e.NodeID, e.Field, strings.Join(e.ReachableAncestors, ", "))
}

// ValidateDataFlow walks the workflow tree from the start node and verifies
// that every node's `schema.reads` are produced by either an ancestor or the
// initial input schema. Nodes without a schema are treated as opaque: they
// neither contribute nor consume tracked fields.
//
// Because the workflow is a tree (non-merging constraint), every node has a
// unique chain of ancestors, and a single DFS pass is sufficient. Total work
// is O(|N| * avg-fields-per-node).
func ValidateDataFlow(wf *WorkflowDef, initialFields []string) []DataFlowError {
	nodes := wf.NodeMap()
	start, ok := nodes[wf.Start]
	if !ok {
		return nil
	}

	available := make(map[string]bool, len(initialFields))
	for _, f := range initialFields {
		available[f] = true
	}

	var errors []DataFlowError
	visit(wf, nodes, start, available, &errors)
	return errors
}

// visit walks the subtree rooted at node, with `available` containing the
// set of fields produced by ancestors plus the initial schema. The map is
// copied for each child so siblings don't see each other's outputs.
func visit(wf *WorkflowDef, nodes map[string]*Node, node *Node, available map[string]bool, errors *[]DataFlowError) {
	// Check node's reads against the available field set.
	if node.Schema != nil {
		for _, field := range node.Schema.Reads {
			if !available[field] {
				ancestors := keys(available)
				sort.Strings(ancestors)
				*errors = append(*errors, DataFlowError{
					NodeID:             node.ID,
					Field:              field,
					ReachableAncestors: ancestors,
				})
			}
		}
	}

	// Build the field set seen by descendants: available + this node's
	// produced fields. Schema-less nodes don't contribute.
	descendantSet := available
	if node.Schema != nil && len(node.Schema.Produces) > 0 {
		descendantSet = copySet(available)
		for _, f := range node.Schema.Produces {
			descendantSet[f] = true
		}
	}

	// Recurse into successors.
	for _, succID := range node.Successors() {
		succ, ok := nodes[succID]
		if !ok {
			continue
		}
		visit(wf, nodes, succ, descendantSet, errors)
	}
}

func copySet(in map[string]bool) map[string]bool {
	out := make(map[string]bool, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
