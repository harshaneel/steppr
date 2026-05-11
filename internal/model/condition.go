package model

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// Operand kinds: a condition tree is built from operands that are either
// path references into the payload, literal values, or nested operations.
type OperandKind int

const (
	OperandPath    OperandKind = iota // bare identifier — resolved against payload
	OperandLiteral                    // quoted string, number, boolean — used as-is
	OperandOp                         // nested operation
)

// Operand is one argument to an operator. Exactly one of Path/Literal/Op is set.
type Operand struct {
	Kind    OperandKind
	Path    string  // dot-separated payload path, e.g. "nested.count"
	Literal any     // string, int64, float64, bool, nil
	Op      *OpExpr // nested operation
}

// OpExpr is a single operator with its operands, e.g. eq(count, "3").
type OpExpr struct {
	Op       string    // "eq", "neq", "gt", "gte", "lt", "lte", "len",
	                    // "and", "or", "not", "exists"
	Operands []Operand
}

// Condition is the top-level condition tree on a Filter branch.
// Per the design: a top-level list of OpExprs is implicit OR.
// A single OpExpr is just that condition.
type Condition struct {
	Exprs []OpExpr // implicit OR if len > 1
}

// IsEmpty reports whether the condition is unconditional (always true).
func (c *Condition) IsEmpty() bool {
	return c == nil || len(c.Exprs) == 0
}

// Pretty returns a human-readable form for error messages.
func (c *Condition) Pretty() string {
	if c.IsEmpty() {
		return "true"
	}
	parts := make([]string, 0, len(c.Exprs))
	for _, e := range c.Exprs {
		parts = append(parts, prettyOp(&e))
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return "(" + strings.Join(parts, " or ") + ")"
}

func prettyOp(op *OpExpr) string {
	if op == nil {
		return "<nil>"
	}
	args := make([]string, 0, len(op.Operands))
	for _, o := range op.Operands {
		args = append(args, prettyOperand(&o))
	}
	return fmt.Sprintf("%s(%s)", op.Op, strings.Join(args, ", "))
}

func prettyOperand(o *Operand) string {
	switch o.Kind {
	case OperandPath:
		return o.Path
	case OperandLiteral:
		switch v := o.Literal.(type) {
		case string:
			return fmt.Sprintf("%q", v)
		default:
			return fmt.Sprintf("%v", v)
		}
	case OperandOp:
		return prettyOp(o.Op)
	}
	return "<?>"
}

// --- YAML unmarshaling ----------------------------------------------------
//
// YAML form:
//   condition:
//     - eq: [count, "3"]              # single op, args inline
//     - eq:                            # single op, args block
//         - count
//         - "3"
//     - eq:                            # nested op
//         - len: [someList]
//         - "5"
//     - and:
//         - eq: [a, "x"]
//         - eq: [b, "y"]
//
// Scalar style determines path vs literal:
//   - Plain (unquoted) string scalars  → OperandPath
//   - Single/double-quoted strings     → OperandLiteral (string)
//   - Numeric scalars (no quotes)      → OperandLiteral (int64/float64)
//   - Boolean scalars                  → OperandLiteral (bool)

// UnmarshalYAML implements custom parsing for Condition.
func (c *Condition) UnmarshalYAML(node *yaml.Node) error {
	if node == nil {
		c.Exprs = nil
		return nil
	}
	if node.Kind != yaml.SequenceNode {
		return fmt.Errorf("condition must be a YAML list, got %s", kindName(node.Kind))
	}
	c.Exprs = make([]OpExpr, 0, len(node.Content))
	for i, item := range node.Content {
		expr, err := parseOpExpr(item)
		if err != nil {
			return fmt.Errorf("condition[%d]: %w", i, err)
		}
		c.Exprs = append(c.Exprs, *expr)
	}
	return nil
}

func parseOpExpr(node *yaml.Node) (*OpExpr, error) {
	if node.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("expected operator mapping, got %s", kindName(node.Kind))
	}
	if len(node.Content) != 2 {
		return nil, fmt.Errorf("operator must have exactly one key (got %d entries)", len(node.Content)/2)
	}
	keyNode := node.Content[0]
	valNode := node.Content[1]
	if keyNode.Kind != yaml.ScalarNode {
		return nil, fmt.Errorf("operator name must be a scalar")
	}
	op := &OpExpr{Op: keyNode.Value}
	operands, err := parseOperandList(valNode)
	if err != nil {
		return nil, fmt.Errorf("op %q: %w", op.Op, err)
	}
	op.Operands = operands
	return op, nil
}

// parseOperandList accepts a YAML sequence node where each item is an operand
// (path, literal, or nested op). It also accepts a single scalar/mapping in
// place of a one-item sequence for tolerance.
func parseOperandList(node *yaml.Node) ([]Operand, error) {
	if node.Kind == yaml.SequenceNode {
		out := make([]Operand, 0, len(node.Content))
		for i, item := range node.Content {
			operand, err := parseOperand(item)
			if err != nil {
				return nil, fmt.Errorf("operand[%d]: %w", i, err)
			}
			out = append(out, *operand)
		}
		return out, nil
	}
	// single operand allowed for unary ops (e.g. not, len, exists).
	one, err := parseOperand(node)
	if err != nil {
		return nil, err
	}
	return []Operand{*one}, nil
}

func parseOperand(node *yaml.Node) (*Operand, error) {
	switch node.Kind {
	case yaml.ScalarNode:
		return parseScalarOperand(node)
	case yaml.MappingNode:
		// nested operator
		expr, err := parseOpExpr(node)
		if err != nil {
			return nil, err
		}
		return &Operand{Kind: OperandOp, Op: expr}, nil
	default:
		return nil, fmt.Errorf("unsupported operand kind: %s", kindName(node.Kind))
	}
}

func parseScalarOperand(node *yaml.Node) (*Operand, error) {
	// YAML scalar style determines path vs literal.
	// Plain  (unquoted) string → path
	// Quoted string → literal string
	// Tagged numeric/bool → literal of that type
	switch node.Style {
	case yaml.SingleQuotedStyle, yaml.DoubleQuotedStyle:
		return &Operand{Kind: OperandLiteral, Literal: node.Value}, nil
	}

	// Plain scalar: defer to YAML's resolved tag.
	switch node.Tag {
	case "!!int":
		var v int64
		if err := node.Decode(&v); err != nil {
			return nil, fmt.Errorf("invalid integer literal: %w", err)
		}
		return &Operand{Kind: OperandLiteral, Literal: v}, nil
	case "!!float":
		var v float64
		if err := node.Decode(&v); err != nil {
			return nil, fmt.Errorf("invalid float literal: %w", err)
		}
		return &Operand{Kind: OperandLiteral, Literal: v}, nil
	case "!!bool":
		var v bool
		if err := node.Decode(&v); err != nil {
			return nil, fmt.Errorf("invalid bool literal: %w", err)
		}
		return &Operand{Kind: OperandLiteral, Literal: v}, nil
	case "!!null":
		return &Operand{Kind: OperandLiteral, Literal: nil}, nil
	}

	// Plain string → path reference into payload.
	if node.Value == "" {
		return nil, fmt.Errorf("empty path operand")
	}
	return &Operand{Kind: OperandPath, Path: node.Value}, nil
}

func kindName(k yaml.Kind) string {
	switch k {
	case yaml.DocumentNode:
		return "document"
	case yaml.SequenceNode:
		return "sequence"
	case yaml.MappingNode:
		return "mapping"
	case yaml.ScalarNode:
		return "scalar"
	case yaml.AliasNode:
		return "alias"
	}
	return fmt.Sprintf("unknown(%d)", k)
}
