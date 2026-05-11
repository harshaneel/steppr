/**
 * YAML workflow parser.
 *
 * The condition language relies on the YAML scalar style (plain vs quoted) to
 * distinguish path references from literal values:
 *   - plain  (unquoted) string scalar  → path operand
 *   - quoted string scalar             → literal string
 *   - tagged numeric / bool / null     → literal of that type
 *
 * `js-yaml` collapses styles to plain strings, so we use the more advanced
 * `yaml` package which exposes node types (Scalar with type and quote markers).
 */

import { parseDocument, isMap, isSeq, isScalar, type Scalar } from "yaml";
import type {
  Branch,
  Condition,
  FieldSchema,
  Node,
  OpExpr,
  Operand,
  WorkflowDef,
} from "./types.js";

export class ParseError extends Error {
  constructor(message: string, public path?: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** Parse a YAML workflow string into a WorkflowDef. */
export function parse(yaml: string): WorkflowDef {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    throw new ParseError(`YAML syntax: ${doc.errors[0]?.message ?? "unknown"}`);
  }
  const root = doc.contents;
  if (!isMap(root)) {
    throw new ParseError("workflow must be a YAML mapping at the top level");
  }

  const id = scalarString(root.get("id", true) as Scalar | undefined, "id");
  const version = optionalString(root.get("version", true) as Scalar | undefined);
  const start = scalarString(root.get("start", true) as Scalar | undefined, "start");

  const nodesNode = root.get("nodes", true);
  if (!isSeq(nodesNode)) {
    throw new ParseError("`nodes` must be a YAML list");
  }

  const nodes: Node[] = [];
  for (let i = 0; i < nodesNode.items.length; i++) {
    nodes.push(parseNode(nodesNode.items[i], `nodes[${i}]`));
  }

  if (!id) throw new ParseError("workflow missing required field: id");
  if (!start) throw new ParseError("workflow missing required field: start");
  if (nodes.length === 0) throw new ParseError("workflow has no nodes");

  return { id, version, start, nodes };
}

function parseNode(raw: unknown, path: string): Node {
  if (!isMap(raw)) {
    throw new ParseError(`expected a node mapping`, path);
  }
  const id = scalarString(raw.get("id", true) as Scalar | undefined, `${path}.id`);
  const typeStr = scalarString(raw.get("type", true) as Scalar | undefined, `${path}.type`);
  if (!["filter", "enhancer", "action"].includes(typeStr)) {
    throw new ParseError(`invalid node type "${typeStr}"`, `${path}.type`);
  }
  const worker = optionalString(raw.get("worker", true) as Scalar | undefined);
  const next_node = optionalString(raw.get("next_node", true) as Scalar | undefined);

  const node: Node = {
    id,
    type: typeStr as Node["type"],
  };
  if (worker !== undefined) node.worker = worker;
  if (next_node !== undefined) node.next_node = next_node;

  const branchesNode = raw.get("branches", true);
  if (branchesNode !== undefined && branchesNode !== null) {
    if (!isSeq(branchesNode)) {
      throw new ParseError("`branches` must be a list", `${path}.branches`);
    }
    node.branches = branchesNode.items.map((item, i) =>
      parseBranch(item, `${path}.branches[${i}]`),
    );
  }

  const schemaNode = raw.get("schema", true);
  if (schemaNode !== undefined && schemaNode !== null) {
    node.schema = parseSchema(schemaNode, `${path}.schema`);
  }

  return node;
}

function parseBranch(raw: unknown, path: string): Branch {
  if (!isMap(raw)) {
    throw new ParseError("expected a branch mapping", path);
  }
  const label = optionalString(raw.get("label", true) as Scalar | undefined);
  const next_node = scalarString(
    raw.get("next_node", true) as Scalar | undefined,
    `${path}.next_node`,
  );
  const branch: Branch = { next_node };
  if (label !== undefined) branch.label = label;

  const conditionNode = raw.get("condition", true);
  if (conditionNode !== undefined && conditionNode !== null) {
    branch.condition = parseCondition(conditionNode, `${path}.condition`);
  }
  return branch;
}

function parseSchema(raw: unknown, path: string): FieldSchema {
  if (!isMap(raw)) {
    throw new ParseError("schema must be a mapping", path);
  }
  const out: FieldSchema = {};
  const reads = raw.get("reads", true);
  if (isSeq(reads)) {
    out.reads = reads.items.map((it, i) =>
      scalarString(it as Scalar, `${path}.reads[${i}]`),
    );
  }
  const produces = raw.get("produces", true);
  if (isSeq(produces)) {
    out.produces = produces.items.map((it, i) =>
      scalarString(it as Scalar, `${path}.produces[${i}]`),
    );
  }
  return out;
}

/**
 * Parse a `condition:` block. Top-level form is a list of operator
 * expressions, combined with implicit OR.
 */
export function parseCondition(raw: unknown, path: string): Condition {
  if (!isSeq(raw)) {
    throw new ParseError("condition must be a list", path);
  }
  const exprs: OpExpr[] = [];
  for (let i = 0; i < raw.items.length; i++) {
    exprs.push(parseOpExpr(raw.items[i], `${path}[${i}]`));
  }
  return { exprs };
}

function parseOpExpr(raw: unknown, path: string): OpExpr {
  if (!isMap(raw)) {
    throw new ParseError("expected operator mapping", path);
  }
  if (raw.items.length !== 1) {
    throw new ParseError(
      `operator must have exactly one key (got ${raw.items.length})`,
      path,
    );
  }
  const pair = raw.items[0]!;
  const opName = scalarString(pair.key as Scalar, `${path}.<op>`);
  const operands = parseOperandList(pair.value, `${path}.${opName}`);
  return { op: opName, operands };
}

function parseOperandList(raw: unknown, path: string): Operand[] {
  if (isSeq(raw)) {
    return raw.items.map((it, i) => parseOperand(it, `${path}[${i}]`));
  }
  // Single operand (scalar or map) accepted for unary ops.
  return [parseOperand(raw, path)];
}

function parseOperand(raw: unknown, path: string): Operand {
  if (isScalar(raw)) {
    return scalarOperand(raw, path);
  }
  if (isMap(raw)) {
    return { kind: "op", op: parseOpExpr(raw, path) };
  }
  throw new ParseError(`unsupported operand kind`, path);
}

/**
 * Distinguish path operands from literals using the YAML scalar style.
 * - `plainImplicit` set on a Scalar node means it was unquoted.
 * - `single`/`double` quote → string literal
 * - resolved tag drives literal type for non-string scalars.
 */
function scalarOperand(node: Scalar, path: string): Operand {
  const value = node.value;
  // Quoted strings → literal string.
  // The 'yaml' library exposes `type` as one of "PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE", "BLOCK_FOLDED", etc.
  const t = (node as Scalar & { type?: string }).type;
  if (t === "QUOTE_SINGLE" || t === "QUOTE_DOUBLE") {
    return { kind: "literal", value: String(value) };
  }
  // Non-string types (number, boolean, null) → literal of that type.
  if (typeof value === "number") return { kind: "literal", value };
  if (typeof value === "boolean") return { kind: "literal", value };
  if (value === null) return { kind: "literal", value: null };
  // Plain string → path reference.
  if (typeof value === "string") {
    if (value === "") {
      throw new ParseError("empty path operand", path);
    }
    return { kind: "path", path: value };
  }
  throw new ParseError(`unsupported scalar type ${typeof value}`, path);
}

// --- helpers ---------------------------------------------------------------

function scalarString(node: Scalar | undefined, path: string): string {
  if (node === undefined || node === null) {
    throw new ParseError("missing required field", path);
  }
  if (!isScalar(node)) {
    throw new ParseError("expected a scalar", path);
  }
  const v = node.value;
  if (typeof v !== "string") {
    return String(v);
  }
  return v;
}

function optionalString(node: Scalar | undefined): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (!isScalar(node)) return undefined;
  const v = node.value;
  if (v === null || v === undefined) return undefined;
  return String(v);
}
