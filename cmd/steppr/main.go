package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/harshaneel/steppr/internal/engine"
	"github.com/harshaneel/steppr/internal/model"
	"github.com/harshaneel/steppr/internal/parser"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "validate":
		cmdValidate()
	case "run":
		cmdRun()
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`steppr — minimal workflow orchestrator

Usage:
  steppr validate <workflow.yaml>         Validate a workflow definition
  steppr run <workflow.yaml> [--input '{"key":"value"}']  Execute a workflow
  steppr help                             Show this help

Node Types:
  filter     Conditional branching (OR-split)
  enhancer   Pure data transformation (D ⊆ D')
  action     Side-effect operations (D ⊆ D' × SideEffect)`)
}

func cmdValidate() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: steppr validate <workflow.yaml> [--input-fields field1,field2,...]")
		os.Exit(1)
	}

	wf, err := parser.ParseFile(os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse error: %v\n", err)
		os.Exit(1)
	}

	// Optional --input-fields flag: enables data-flow validation.
	var inputFields []string
	for i := 3; i < len(os.Args); i++ {
		if os.Args[i] == "--input-fields" && i+1 < len(os.Args) {
			for _, f := range strings.Split(os.Args[i+1], ",") {
				if s := strings.TrimSpace(f); s != "" {
					inputFields = append(inputFields, s)
				}
			}
			i++
		}
	}

	if err := model.ValidateWithSchema(wf, inputFields); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}

	fmt.Printf("workflow %q is valid (%d nodes: ", wf.ID, len(wf.Nodes))
	counts := map[model.NodeType]int{}
	for _, n := range wf.Nodes {
		counts[n.Type]++
	}
	fmt.Printf("%d filter, %d enhancer, %d action)\n",
		counts[model.NodeTypeFilter],
		counts[model.NodeTypeEnhancer],
		counts[model.NodeTypeAction],
	)
	if inputFields != nil {
		fmt.Printf("data-flow check passed (initial fields: %s)\n", strings.Join(inputFields, ", "))
	}
}

func cmdRun() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: steppr run <workflow.yaml> [--input '{...}'] [--workers url1,url2,...]")
		os.Exit(1)
	}

	wf, err := parser.ParseFile(os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "parse error: %v\n", err)
		os.Exit(1)
	}

	if err := model.Validate(wf); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}

	// Parse flags: --input and --workers.
	input := map[string]any{}
	var workerURLs []string
	for i := 3; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--input":
			if i+1 < len(os.Args) {
				if err := json.Unmarshal([]byte(os.Args[i+1]), &input); err != nil {
					fmt.Fprintf(os.Stderr, "invalid input JSON: %v\n", err)
					os.Exit(1)
				}
				i++
			}
		case "--workers":
			if i+1 < len(os.Args) {
				for _, u := range strings.Split(os.Args[i+1], ",") {
					if s := strings.TrimSpace(u); s != "" {
						workerURLs = append(workerURLs, s)
					}
				}
				i++
			}
		}
	}

	executionID := fmt.Sprintf("exec-%d", time.Now().UnixMilli())
	fmt.Printf("executing workflow %q (id: %s)\n\n", wf.ID, executionID)

	eng := engine.New()

	// Discover handlers from the configured workers and populate the registry.
	if len(workerURLs) > 0 {
		results := eng.Registry.Discover(workerURLs, 5*time.Second)
		for _, r := range results {
			if r.Error != nil {
				fmt.Fprintf(os.Stderr, "worker %s discovery failed: %v\n", r.WorkerURL, r.Error)
				continue
			}
			fmt.Printf("registered worker %s for %d node(s): %v\n", r.WorkerURL, len(r.NodeIDs), r.NodeIDs)
		}

		// Verify every Enhancer/Action node in the workflow has a registered worker.
		var missing []string
		for _, n := range wf.Nodes {
			if n.Type == model.NodeTypeFilter {
				continue // Filter nodes are evaluated in-process.
			}
			if !eng.Registry.Has(n.ID) {
				missing = append(missing, n.ID)
			}
		}
		if len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "no worker registered for node(s): %v\n", missing)
			os.Exit(1)
		}
		fmt.Println()
	}

	result, err := eng.Execute(wf, executionID, input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "execution error: %v\n", err)
		os.Exit(1)
	}

	// Print execution summary.
	for i, trace := range result.Traces {
		fmt.Printf("trace %d [%s]:\n", i+1, trace.Status)
		for _, n := range trace.Nodes {
			status := "OK"
			if n.Status == engine.StatusFailed {
				status = "FAIL"
			}
			fmt.Printf("  %-20s %-10s [%s] %s\n", n.NodeID, n.NodeType, status, n.EndedAt.Sub(n.StartedAt).Round(time.Millisecond))
			if n.Error != nil {
				fmt.Printf("    error: %s — %s\n", n.Error.Code, n.Error.Message)
			}
		}
		fmt.Println()
	}

	fmt.Printf("result: %s (%d trace(s))\n", result.Status, len(result.Traces))

	// Also print full JSON result to stderr for programmatic use.
	if os.Getenv("STEPPR_JSON") == "1" {
		out, _ := json.MarshalIndent(result, "", "  ")
		fmt.Fprintln(os.Stderr, string(out))
	}

	if result.Status == engine.StatusFailed {
		os.Exit(1)
	}
}
