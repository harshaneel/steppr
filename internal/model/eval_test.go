package model

import (
	"testing"

	"gopkg.in/yaml.v3"
)

func parseCondition(t *testing.T, src string) *Condition {
	t.Helper()
	var c Condition
	if err := yaml.Unmarshal([]byte(src), &c); err != nil {
		t.Fatalf("parse: %v", err)
	}
	return &c
}

func TestConditionEvaluate(t *testing.T) {
	payload := map[string]any{
		"count": int64(3),
		"tier":  "premium",
		"items": []any{1, 2, 3},
		"nested": map[string]any{
			"otherCounter": int64(4),
		},
		"flag": true,
	}

	tests := []struct {
		name string
		yaml string
		want bool
	}{
		// --- Path vs literal ---
		{
			name: "eq path-literal-string-match",
			yaml: "- eq:\n    - tier\n    - \"premium\"\n",
			want: true,
		},
		{
			name: "eq path-literal-string-mismatch",
			yaml: "- eq:\n    - tier\n    - \"standard\"\n",
			want: false,
		},
		{
			name: "eq path-path",
			yaml: "- eq:\n    - count\n    - nested.otherCounter\n",
			want: false, // 3 != 4
		},
		{
			name: "eq numeric-coerce",
			yaml: "- eq:\n    - count\n    - 3\n",
			want: true,
		},
		{
			name: "eq numeric-string-coerce",
			yaml: "- eq:\n    - count\n    - \"3\"\n",
			want: true, // loose equality coerces "3" to 3
		},

		// --- Comparators ---
		{name: "gt-true", yaml: "- gt:\n    - count\n    - 2\n", want: true},
		{name: "gt-false", yaml: "- gt:\n    - count\n    - 5\n", want: false},
		{name: "lte-true", yaml: "- lte:\n    - count\n    - 3\n", want: true},
		{name: "neq-true", yaml: "- neq:\n    - tier\n    - \"standard\"\n", want: true},

		// --- Nested operators ---
		{
			name: "len-nested-eq",
			yaml: "- eq:\n    - len:\n        - items\n    - 3\n",
			want: true,
		},
		{
			name: "len-nested-gt",
			yaml: "- gt:\n    - len:\n        - items\n    - 1\n",
			want: true,
		},

		// --- Boolean composition ---
		{
			name: "and-both-true",
			yaml: "- and:\n    - eq: [tier, \"premium\"]\n    - gt: [count, 0]\n",
			want: true,
		},
		{
			name: "and-one-false",
			yaml: "- and:\n    - eq: [tier, \"premium\"]\n    - gt: [count, 100]\n",
			want: false,
		},
		{
			name: "or-one-true",
			yaml: "- or:\n    - eq: [tier, \"standard\"]\n    - gt: [count, 0]\n",
			want: true,
		},
		{
			name: "not-flips",
			yaml: "- not:\n    - eq: [tier, \"standard\"]\n",
			want: true,
		},

		// --- Top-level OR (multiple expressions in condition list) ---
		{
			name: "top-level-or-first-true",
			yaml: "- eq: [tier, \"premium\"]\n- eq: [tier, \"standard\"]\n",
			want: true,
		},
		{
			name: "top-level-or-second-true",
			yaml: "- eq: [tier, \"gold\"]\n- eq: [tier, \"premium\"]\n",
			want: true,
		},
		{
			name: "top-level-or-all-false",
			yaml: "- eq: [tier, \"gold\"]\n- eq: [tier, \"silver\"]\n",
			want: false,
		},

		// --- Existence ---
		{name: "exists-present", yaml: "- exists:\n    - tier\n", want: true},
		{name: "exists-missing", yaml: "- exists:\n    - missing.field\n", want: false},

		// --- Empty condition ---
		{name: "empty-true", yaml: "[]\n", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := parseCondition(t, tt.yaml)
			got, err := c.Evaluate(payload)
			if err != nil {
				t.Fatalf("eval: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %v, want %v\nyaml:\n%s\npretty: %s", got, tt.want, tt.yaml, c.Pretty())
			}
		})
	}
}

func TestConditionPretty(t *testing.T) {
	c := parseCondition(t, "- eq:\n    - count\n    - 3\n- gt:\n    - count\n    - 0\n")
	got := c.Pretty()
	want := `(eq(count, 3) or gt(count, 0))`
	if got != want {
		t.Errorf("pretty: got %q, want %q", got, want)
	}
}

func TestPathStyleDistinction(t *testing.T) {
	// Plain `count` is a path; quoted "count" is a literal string.
	payload := map[string]any{"count": int64(5)}

	pathCond := parseCondition(t, "- eq:\n    - count\n    - 5\n")
	v, err := pathCond.Evaluate(payload)
	if err != nil || !v {
		t.Errorf("path eq: got %v err=%v", v, err)
	}

	literalCond := parseCondition(t, "- eq:\n    - \"count\"\n    - 5\n")
	v, err = literalCond.Evaluate(payload)
	if err != nil || v {
		t.Errorf("literal eq: got %v err=%v (want false: \"count\" string vs int 5)", v, err)
	}
}
