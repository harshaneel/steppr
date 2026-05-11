package model

import (
	"fmt"
	"strings"
)

type ValidationError struct {
	Errors []string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("validation failed with %d error(s):\n  - %s", len(e.Errors), strings.Join(e.Errors, "\n  - "))
}

// Validate runs all structural checks on a workflow. To additionally check
// data-flow correctness against an initial input schema, use ValidateWithSchema.
func Validate(wf *WorkflowDef) error {
	return ValidateWithSchema(wf, nil)
}

// ValidateWithSchema runs all structural checks plus a data-flow analysis
// pass when initialFields is non-nil. The initial schema lists fields that
// are guaranteed to be present in the input payload.
func ValidateWithSchema(wf *WorkflowDef, initialFields []string) error {
	var errs []string
	nodes := wf.NodeMap()

	// 1. Check all node IDs are unique (NodeMap silently dedupes).
	seen := make(map[string]bool)
	for _, n := range wf.Nodes {
		if seen[n.ID] {
			errs = append(errs, fmt.Sprintf("duplicate node id: %q", n.ID))
		}
		seen[n.ID] = true
	}

	// 2. Check start node exists.
	if _, ok := nodes[wf.Start]; !ok {
		errs = append(errs, fmt.Sprintf("start node %q not found in nodes", wf.Start))
	}

	// 3. Check each node has a valid type and correct structure.
	for _, n := range wf.Nodes {
		if !n.Type.Valid() {
			errs = append(errs, fmt.Sprintf("node %q has invalid type %q (must be filter, enhancer, or action)", n.ID, n.Type))
			continue
		}
		switch n.Type {
		case NodeTypeFilter:
			if len(n.Branches) == 0 {
				errs = append(errs, fmt.Sprintf("filter node %q must have at least one branch", n.ID))
			}
			if n.NextNode != "" {
				errs = append(errs, fmt.Sprintf("filter node %q should use branches, not next_node", n.ID))
			}
			for i, b := range n.Branches {
				if b.NextNode == "" {
					errs = append(errs, fmt.Sprintf("filter node %q branch %d missing next_node", n.ID, i))
				}
				// A missing condition is allowed (acts as unconditional fallback).
			}
		case NodeTypeEnhancer, NodeTypeAction:
			if len(n.Branches) > 0 {
				errs = append(errs, fmt.Sprintf("%s node %q must not have branches (only filter nodes branch)", n.Type, n.ID))
			}
			// next_node is optional — empty means terminal node.
		}

		// Worker resolution happens at runtime via the orchestrator's worker
		// registry. The validator does not require a per-node worker URL,
		// since workflow definitions are environment-agnostic by design.
	}

	// 4. Referential integrity — all next_node references point to defined nodes.
	for _, n := range wf.Nodes {
		for _, succ := range n.Successors() {
			if _, ok := nodes[succ]; !ok {
				errs = append(errs, fmt.Sprintf("node %q references undefined node %q", n.ID, succ))
			}
		}
	}

	// 5. Non-merging constraint — every node has in-degree ≤ 1.
	inDegree := make(map[string]int)
	for _, n := range wf.Nodes {
		for _, succ := range n.Successors() {
			inDegree[succ]++
		}
	}
	for id, deg := range inDegree {
		if deg > 1 {
			errs = append(errs, fmt.Sprintf("node %q has in-degree %d (must be ≤ 1; workflow must be non-merging)", id, deg))
		}
	}

	// 6. Acyclicity — DFS cycle detection.
	const (
		white = 0 // unvisited
		gray  = 1 // in current path
		black = 2 // fully processed
	)
	color := make(map[string]int)
	var dfs func(id string) bool
	dfs = func(id string) bool {
		color[id] = gray
		n, ok := nodes[id]
		if !ok {
			return false
		}
		for _, succ := range n.Successors() {
			switch color[succ] {
			case gray:
				errs = append(errs, fmt.Sprintf("cycle detected involving node %q → %q", id, succ))
				return true
			case white:
				if dfs(succ) {
					return true
				}
			}
		}
		color[id] = black
		return false
	}
	for _, n := range wf.Nodes {
		if color[n.ID] == white {
			dfs(n.ID)
		}
	}

	// 7. Reachability — all nodes reachable from start.
	reachable := make(map[string]bool)
	var walk func(id string)
	walk = func(id string) {
		if reachable[id] {
			return
		}
		reachable[id] = true
		n, ok := nodes[id]
		if !ok {
			return
		}
		for _, succ := range n.Successors() {
			walk(succ)
		}
	}
	if _, ok := nodes[wf.Start]; ok {
		walk(wf.Start)
	}
	for _, n := range wf.Nodes {
		if !reachable[n.ID] {
			errs = append(errs, fmt.Sprintf("node %q is unreachable from start node %q", n.ID, wf.Start))
		}
	}

	// 8. Data-flow check (optional — only if caller provided an initial schema).
	if initialFields != nil && len(errs) == 0 {
		// Only run if structure is sound; otherwise the walk may misbehave.
		dfErrs := ValidateDataFlow(wf, initialFields)
		for _, e := range dfErrs {
			errs = append(errs, e.Error())
		}
	}

	if len(errs) > 0 {
		return &ValidationError{Errors: errs}
	}
	return nil
}
