/**
 * Condition evaluator. Mirrors the Go reference implementation in
 * internal/model/eval.go.
 *
 * Top-level Condition.exprs are combined with implicit OR.
 * Operators: eq neq gt gte lt lte len and or not exists
 * Loose-typed equality coerces numeric strings to numbers ("3" == 3 ⇒ true).
 */

import type {
  Condition,
  OpExpr,
  Operand,
  Payload,
} from "./types.js";

export function evaluate(c: Condition | undefined, payload: Payload): boolean {
  if (!c || !c.exprs || c.exprs.length === 0) return true;
  for (const expr of c.exprs) {
    if (truthy(evalOp(expr, payload))) return true;
  }
  return false;
}

function evalOperand(o: Operand, payload: Payload): unknown {
  switch (o.kind) {
    case "literal":
      return o.value;
    case "path":
      return resolvePath(payload, o.path);
    case "op":
      return evalOp(o.op, payload);
  }
}

function resolvePath(payload: Payload, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function evalOp(op: OpExpr, payload: Payload): unknown {
  switch (op.op) {
    case "eq":
      return binCmp(op, payload, looseEqual);
    case "neq":
      return binCmp(op, payload, (a, b) => !looseEqual(a, b));
    case "gt":
      return numCmp(op, payload, (a, b) => a > b);
    case "gte":
      return numCmp(op, payload, (a, b) => a >= b);
    case "lt":
      return numCmp(op, payload, (a, b) => a < b);
    case "lte":
      return numCmp(op, payload, (a, b) => a <= b);
    case "len":
      return evalLen(op, payload);
    case "and":
      return evalAndOr(op, payload, true);
    case "or":
      return evalAndOr(op, payload, false);
    case "not":
      return evalNot(op, payload);
    case "exists":
      return evalExists(op, payload);
    default:
      throw new Error(`unknown operator "${op.op}"`);
  }
}

function binCmp(
  op: OpExpr,
  payload: Payload,
  fn: (a: unknown, b: unknown) => boolean,
): boolean {
  if (op.operands.length !== 2) {
    throw new Error(`${op.op} requires 2 operands, got ${op.operands.length}`);
  }
  return fn(evalOperand(op.operands[0]!, payload), evalOperand(op.operands[1]!, payload));
}

function numCmp(
  op: OpExpr,
  payload: Payload,
  fn: (a: number, b: number) => boolean,
): boolean {
  if (op.operands.length !== 2) {
    throw new Error(`${op.op} requires 2 operands, got ${op.operands.length}`);
  }
  const a = evalOperand(op.operands[0]!, payload);
  const b = evalOperand(op.operands[1]!, payload);
  const af = toNumber(a);
  const bf = toNumber(b);
  if (af === undefined) {
    throw new Error(`${op.op}: left operand ${stringify(a)} is not numeric`);
  }
  if (bf === undefined) {
    throw new Error(`${op.op}: right operand ${stringify(b)} is not numeric`);
  }
  return fn(af, bf);
}

function evalLen(op: OpExpr, payload: Payload): number {
  if (op.operands.length !== 1) {
    throw new Error(`len requires 1 operand, got ${op.operands.length}`);
  }
  const v = evalOperand(op.operands[0]!, payload);
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.length;
  if (v === null || v === undefined) return 0;
  if (typeof v === "object") return Object.keys(v as object).length;
  throw new Error(`len: unsupported type ${typeof v}`);
}

function evalAndOr(op: OpExpr, payload: Payload, isAnd: boolean): boolean {
  if (op.operands.length === 0) return isAnd; // empty AND = true; empty OR = false
  for (const o of op.operands) {
    const t = truthy(evalOperand(o, payload));
    if (isAnd && !t) return false;
    if (!isAnd && t) return true;
  }
  return isAnd;
}

function evalNot(op: OpExpr, payload: Payload): boolean {
  if (op.operands.length !== 1) {
    throw new Error(`not requires 1 operand, got ${op.operands.length}`);
  }
  return !truthy(evalOperand(op.operands[0]!, payload));
}

function evalExists(op: OpExpr, payload: Payload): boolean {
  if (op.operands.length !== 1) {
    throw new Error(`exists requires 1 operand, got ${op.operands.length}`);
  }
  const o = op.operands[0]!;
  if (o.kind !== "path") {
    throw new Error("exists: operand must be a path");
  }
  const v = resolvePath(payload, o.path);
  return v !== undefined && v !== null;
}

// --- helpers --------------------------------------------------------------

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  const af = toNumber(a);
  const bf = toNumber(b);
  if (af !== undefined && bf !== undefined) return af === bf;
  return stringify(a) === stringify(b);
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== "") return n;
  }
  return undefined;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
