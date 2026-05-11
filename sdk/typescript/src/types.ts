/**
 * Core workflow domain types — shared between orchestrator, validator, and worker.
 *
 * Mirrors the Go reference implementation in internal/model/workflow.go and
 * internal/model/message.go. Keep field names in sync; tests pin equivalence.
 */

export type NodeType = "filter" | "enhancer" | "action";

export type Payload = Record<string, unknown>;

/** Optional schema declaring a node's inputs and outputs for data-flow analysis. */
export interface FieldSchema {
  reads?: string[];
  produces?: string[];
}

/** A Filter branch: a condition guard plus a successor node. */
export interface Branch {
  /** Display label, also used as activation marker in execution traces. */
  label?: string;
  /** YAML-AST condition. Empty/undefined ⇒ unconditional branch. */
  condition?: Condition;
  /** Successor node ID. */
  next_node: string;
}

/** A workflow node. Type discriminates the role; only `filter` carries `branches`. */
export interface Node {
  id: string;
  type: NodeType;
  /** Optional fallback worker URL. Normally resolved via the registry. */
  worker?: string;
  /** Filter only. */
  branches?: Branch[];
  /** Enhancer / Action: linear successor; omit for terminal nodes. */
  next_node?: string;
  /** Optional schema for data-flow validation. */
  schema?: FieldSchema;
}

/** A complete workflow definition. */
export interface WorkflowDef {
  id: string;
  version?: string;
  /** Start node ID. */
  start: string;
  nodes: Node[];
}

// --- Condition AST ---------------------------------------------------------

/**
 * The condition language is a YAML-native AST. A Condition is a list of
 * top-level expressions combined with implicit OR.
 */
export interface Condition {
  exprs: OpExpr[];
}

/** Operator name set; runtime checks for validity. */
export type Operator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "len"
  | "and"
  | "or"
  | "not"
  | "exists";

/** A single operator with its operands. */
export interface OpExpr {
  op: Operator | string;
  operands: Operand[];
}

export type OperandKind = "path" | "literal" | "op";

/** A path reference (plain YAML scalar) like `nested.count`. */
export interface PathOperand {
  kind: "path";
  path: string;
}

/** A literal value (quoted string, number, boolean, null). */
export interface LiteralOperand {
  kind: "literal";
  value: string | number | boolean | null;
}

/** A nested operator expression. */
export interface OpOperand {
  kind: "op";
  op: OpExpr;
}

export type Operand = PathOperand | LiteralOperand | OpOperand;

// --- Wire protocol --------------------------------------------------------

export interface MessageMetadata {
  workflow_version: string;
  timestamp: string;
  parent_nodes: string[];
}

export interface WorkflowMessage {
  execution_id: string;
  workflow_id: string;
  node_id: string;
  node_type: NodeType;
  metadata: MessageMetadata;
  payload: Payload;
}

export interface ErrorInfo {
  code: string;
  message: string;
}

export interface NodeResponse {
  execution_id: string;
  node_id: string;
  status: "success" | "failure";
  output: Payload;
  error?: ErrorInfo;
}

// --- Execution traces -----------------------------------------------------

export type ExecutionStatus = "running" | "completed" | "failed";

export interface NodeExecution {
  node_id: string;
  node_type: NodeType;
  status: ExecutionStatus;
  input: Payload;
  output?: Payload;
  error?: ErrorInfo;
  started_at: string;
  ended_at?: string;
}

export interface Trace {
  nodes: NodeExecution[];
  status: ExecutionStatus;
}

export interface ExecutionResult {
  execution_id: string;
  workflow_id: string;
  status: ExecutionStatus;
  traces: Trace[];
}
