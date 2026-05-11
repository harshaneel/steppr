package model

import (
	"fmt"
	"strconv"
	"strings"
)

// Evaluate returns true iff the condition holds against the given payload.
// Top-level Exprs are combined with logical OR (per the design spec).
// An empty condition evaluates to true (unconditional branch).
func (c *Condition) Evaluate(payload map[string]any) (bool, error) {
	if c.IsEmpty() {
		return true, nil
	}
	for _, expr := range c.Exprs {
		v, err := evalOp(&expr, payload)
		if err != nil {
			return false, err
		}
		if truthy(v) {
			return true, nil
		}
	}
	return false, nil
}

// evalOperand resolves an operand to a concrete value.
func evalOperand(o *Operand, payload map[string]any) (any, error) {
	switch o.Kind {
	case OperandLiteral:
		return o.Literal, nil
	case OperandPath:
		return resolvePath(payload, o.Path)
	case OperandOp:
		return evalOp(o.Op, payload)
	}
	return nil, fmt.Errorf("unknown operand kind")
}

// resolvePath walks dot-separated keys into the payload. Missing paths
// resolve to nil rather than error — callers can use exists() to check.
func resolvePath(payload map[string]any, path string) (any, error) {
	if path == "" {
		return nil, nil
	}
	parts := strings.Split(path, ".")
	var cur any = payload
	for _, p := range parts {
		switch v := cur.(type) {
		case map[string]any:
			cur = v[p]
		case map[any]any:
			cur = v[p]
		default:
			return nil, nil
		}
	}
	return cur, nil
}

// evalOp dispatches an operator and returns its result.
// Boolean operators return bool; len returns int64; comparators return bool.
func evalOp(op *OpExpr, payload map[string]any) (any, error) {
	switch op.Op {
	case "eq":
		return binCmp(op, payload, func(a, b any) bool { return looseEqual(a, b) })
	case "neq":
		return binCmp(op, payload, func(a, b any) bool { return !looseEqual(a, b) })
	case "gt":
		return numCmp(op, payload, func(a, b float64) bool { return a > b })
	case "gte":
		return numCmp(op, payload, func(a, b float64) bool { return a >= b })
	case "lt":
		return numCmp(op, payload, func(a, b float64) bool { return a < b })
	case "lte":
		return numCmp(op, payload, func(a, b float64) bool { return a <= b })
	case "len":
		return evalLen(op, payload)
	case "and":
		return evalAndOr(op, payload, true)
	case "or":
		return evalAndOr(op, payload, false)
	case "not":
		return evalNot(op, payload)
	case "exists":
		return evalExists(op, payload)
	}
	return nil, fmt.Errorf("unknown operator %q", op.Op)
}

func binCmp(op *OpExpr, payload map[string]any, fn func(a, b any) bool) (any, error) {
	if len(op.Operands) != 2 {
		return false, fmt.Errorf("%s requires 2 operands, got %d", op.Op, len(op.Operands))
	}
	a, err := evalOperand(&op.Operands[0], payload)
	if err != nil {
		return false, err
	}
	b, err := evalOperand(&op.Operands[1], payload)
	if err != nil {
		return false, err
	}
	return fn(a, b), nil
}

func numCmp(op *OpExpr, payload map[string]any, fn func(a, b float64) bool) (any, error) {
	if len(op.Operands) != 2 {
		return false, fmt.Errorf("%s requires 2 operands, got %d", op.Op, len(op.Operands))
	}
	a, err := evalOperand(&op.Operands[0], payload)
	if err != nil {
		return false, err
	}
	b, err := evalOperand(&op.Operands[1], payload)
	if err != nil {
		return false, err
	}
	af, ok := toFloat(a)
	if !ok {
		return false, fmt.Errorf("%s: left operand %v is not numeric", op.Op, a)
	}
	bf, ok := toFloat(b)
	if !ok {
		return false, fmt.Errorf("%s: right operand %v is not numeric", op.Op, b)
	}
	return fn(af, bf), nil
}

func evalLen(op *OpExpr, payload map[string]any) (any, error) {
	if len(op.Operands) != 1 {
		return int64(0), fmt.Errorf("len requires 1 operand, got %d", len(op.Operands))
	}
	v, err := evalOperand(&op.Operands[0], payload)
	if err != nil {
		return int64(0), err
	}
	switch x := v.(type) {
	case string:
		return int64(len(x)), nil
	case []any:
		return int64(len(x)), nil
	case map[string]any:
		return int64(len(x)), nil
	case nil:
		return int64(0), nil
	}
	return int64(0), fmt.Errorf("len: unsupported type %T", v)
}

func evalAndOr(op *OpExpr, payload map[string]any, isAnd bool) (any, error) {
	if len(op.Operands) == 0 {
		return isAnd, nil // empty AND is true; empty OR is false
	}
	for _, o := range op.Operands {
		v, err := evalOperand(&o, payload)
		if err != nil {
			return false, err
		}
		t := truthy(v)
		if isAnd && !t {
			return false, nil
		}
		if !isAnd && t {
			return true, nil
		}
	}
	return isAnd, nil
}

func evalNot(op *OpExpr, payload map[string]any) (any, error) {
	if len(op.Operands) != 1 {
		return false, fmt.Errorf("not requires 1 operand, got %d", len(op.Operands))
	}
	v, err := evalOperand(&op.Operands[0], payload)
	if err != nil {
		return false, err
	}
	return !truthy(v), nil
}

func evalExists(op *OpExpr, payload map[string]any) (any, error) {
	if len(op.Operands) != 1 {
		return false, fmt.Errorf("exists requires 1 operand, got %d", len(op.Operands))
	}
	o := op.Operands[0]
	if o.Kind != OperandPath {
		return false, fmt.Errorf("exists: operand must be a path, got %v", o.Kind)
	}
	v, _ := resolvePath(payload, o.Path)
	return v != nil, nil
}

// --- helpers --------------------------------------------------------------

// truthy applies JS-style truthiness for boolean coercion.
//   - bool: as-is
//   - numeric: non-zero is true
//   - string: non-empty is true
//   - slice/map: non-empty is true
//   - nil: false
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case int:
		return x != 0
	case int64:
		return x != 0
	case float64:
		return x != 0
	case string:
		return x != ""
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true // unknown types default to truthy
}

// looseEqual compares two values with type coercion. Numbers compare
// numerically across int/float/string-numeric. Strings compare exactly.
// Bools compare exactly. nil equals nil.
func looseEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	// Try numeric comparison if both can be coerced.
	if af, aok := toFloat(a); aok {
		if bf, bok := toFloat(b); bok {
			return af == bf
		}
	}
	// Fall back to string comparison.
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
}

// toFloat coerces a value to float64. Strings are parsed; nil is not numeric.
func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case float64:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case string:
		f, err := strconv.ParseFloat(x, 64)
		if err == nil {
			return f, true
		}
	}
	return 0, false
}
