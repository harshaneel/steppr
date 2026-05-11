package parser

import (
	"fmt"
	"os"

	"github.com/harshaneel/steppr/internal/model"
	"gopkg.in/yaml.v3"
)

func ParseFile(path string) (*model.WorkflowDef, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading workflow file: %w", err)
	}
	return Parse(data)
}

func Parse(data []byte) (*model.WorkflowDef, error) {
	var wf model.WorkflowDef
	if err := yaml.Unmarshal(data, &wf); err != nil {
		return nil, fmt.Errorf("parsing workflow YAML: %w", err)
	}
	if wf.ID == "" {
		return nil, fmt.Errorf("workflow missing required field: id")
	}
	if wf.Start == "" {
		return nil, fmt.Errorf("workflow missing required field: start")
	}
	if len(wf.Nodes) == 0 {
		return nil, fmt.Errorf("workflow has no nodes")
	}
	return &wf, nil
}
