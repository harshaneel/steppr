package engine

import (
	"testing"

	"github.com/harshaneel/steppr/internal/model"
	"gopkg.in/yaml.v3"
)

// parseCond builds a Condition from inline YAML for benchmarks/tests.
func parseCond(tb testing.TB, src string) *model.Condition {
	tb.Helper()
	var c model.Condition
	if err := yaml.Unmarshal([]byte(src), &c); err != nil {
		tb.Fatalf("parse condition: %v", err)
	}
	return &c
}
