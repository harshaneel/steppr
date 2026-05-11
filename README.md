# Steppr

> A workflow orchestration engine built on three node types — small, statically verifiable, polyglot.

Steppr is a workflow orchestrator for the case where **design-time correctness matters more than runtime flexibility**. It defines exactly three node types — Filter, Enhancer, Action — and constrains workflows to acyclic, non-merging trees. In return, it gives you guarantees that general-purpose orchestrators (Airflow, Temporal, Step Functions) leave to runtime: every workflow terminates, deadlocks cannot occur, and data-flow errors are caught before execution.

---

## Why three node types?

Most workflow orchestrators define between 5 and 20 node or state types (Step Functions has 8; BPMN 2.0 has 50+). Each type adds semantics the validator must understand and the engine must implement. Steppr asks: how few do you actually need?


| Type         | What it does                                        | Side effects | Branching      |
| ------------ | --------------------------------------------------- | ------------ | -------------- |
| **Filter**   | Conditional branching evaluated against the payload | No           | Yes (OR-split) |
| **Enhancer** | Pure data transformation (`D ⊆ D'`)                 | No           | No             |
| **Action**   | External effects (API call, DB write, notification) | Yes          | No             |


Filter is the only node that branches; Enhancer and Action are linear. Workflows compose these into trees. That's the whole language.

## What you get

- **Termination is guaranteed** — workflows are finite acyclic graphs. The longest root-to-leaf path bounds execution.
- **Deadlock-freedom is structural** — no node ever waits on multiple predecessors, so coordination deadlocks cannot arise.
- **Data-flow is statically verifiable** — declare each node's `reads` and `produces` and the validator catches missing-field bugs before any execution begins.
- **Polyglot via HTTP** — workers are HTTP servers in any language. Worker SDKs are provided for Python (~160 lines, zero deps), Go, and TypeScript; any HTTP-capable language can implement one from scratch.
- **Workflows are environment-agnostic** — definitions reference nodes by ID; worker URLs are runtime configuration.

## What you give up

Two pattern families are out of scope by design:

- **Synchronization** — joins, fan-out-then-aggregate, barrier coordination. Steppr requires every node to have at most one incoming edge.
- **Iteration** — workflow-level loops, recursion. Steppr workflows are acyclic.

If your workflows need either, Steppr is the wrong tool — use Temporal, Airflow, or a Petri-net-based system. Mapped against the [Workflow Patterns Catalog](http://www.workflowpatterns.com/), Steppr covers about 72% of the 43 control-flow patterns. The 28% it can't express decomposes cleanly into the two limitations above.

## Quick start

```bash
# Build the orchestrator binary.
go build ./cmd/steppr

# Start the example Python worker (in one terminal).
python3 examples/order-processing/workers/python/main.py
# steppr worker listening on :9001 (5 handler(s))

# Validate the workflow (in another terminal).
./steppr validate examples/order-processing/workflow.yaml --input-fields order_id,tier,amount
# workflow "order-processing" is valid (6 nodes: 1 filter, 3 enhancer, 2 action)
# data-flow check passed (initial fields: order_id, tier, amount)

# Run it.
./steppr run examples/order-processing/workflow.yaml \
  --workers http://localhost:9001 \
  --input '{"order_id":"ORD-42","tier":"premium","amount":150.00}'
```

Output:

```
executing workflow "order-processing" (id: exec-1777704680308)

registered worker http://localhost:9001 for 5 node(s):
  [apply_discount enrich_customer process_payment process_payment_premium validate_order]

trace 1 [completed]:
  validate_order       enhancer   [OK] 1ms
  enrich_customer      enhancer   [OK] 1ms
  route_by_tier        filter     [OK] 0s
  apply_discount       enhancer   [OK] 1ms
  process_payment_premium action     [OK] 1ms

result: completed (1 trace(s))
```

## Workflow definition

Workflows are plain YAML. They contain no worker URLs — the orchestrator resolves workers at runtime via a registry.

```yaml
id: order-processing
version: "1.0"
start: validate_order

nodes:
  - id: validate_order
    type: enhancer
    schema:
      reads: [order_id, amount]
      produces: [validated]
    next_node: enrich_customer

  - id: enrich_customer
    type: enhancer
    schema:
      reads: [tier]
      produces: [customer_tier, loyalty_points]
    next_node: route_by_tier

  - id: route_by_tier
    type: filter
    branches:
      - label: premium
        condition:
          - eq: [tier, "premium"]
        next_node: apply_discount
      - label: standard
        condition:
          - eq: [tier, "standard"]
        next_node: process_payment

  - id: process_payment
    type: action
    schema:
      reads: [order_id, amount]
      produces: [payment_status]
```

### Node fields


| Field             | Required    | Description                                                             |
| ----------------- | ----------- | ----------------------------------------------------------------------- |
| `id`              | yes         | Unique node identifier; matches a registered worker handler             |
| `type`            | yes         | `filter`, `enhancer`, or `action`                                       |
| `next_node`       | conditional | Next node ID for `enhancer` / `action`; omit for terminal nodes         |
| `branches`        | conditional | Branch list for `filter`; each branch has a `condition` and `next_node` |
| `schema.reads`    | optional    | Field names this node reads (enables data-flow validation)              |
| `schema.produces` | optional    | Field names this node adds to the payload                               |


### Filter conditions

Filter conditions are structured YAML expressions evaluated by the orchestrator. The condition language supports:


| Operator                 | Meaning                             | Example                                   |
| ------------------------ | ----------------------------------- | ----------------------------------------- |
| `eq`, `neq`              | Equality / inequality (loose-typed) | `eq: [count, 3]`                          |
| `gt`, `gte`, `lt`, `lte` | Numeric comparison                  | `gt: [amount, 100]`                       |
| `len`                    | Length of string / list / map       | `gt: [{ len: [items] }, 0]`               |
| `and`, `or`, `not`       | Boolean combinators                 | `and: [{ eq: [a, "x"] }, { gt: [b, 0] }]` |
| `exists`                 | Path is present in payload          | `exists: [customer.email]`                |


Path vs literal: plain identifiers (`tier`, `nested.count`) resolve into the payload; quoted strings (`"premium"`) and numeric literals are values. Top-level branch conditions form an implicit OR.

A branch with no `condition` is unconditional (matches the default-branch role).

## Workers

A worker is an HTTP server that exposes two endpoints:

- `GET /handlers` — returns the node IDs the worker can serve, used at registration time.
- `POST /execute` — runs a single Enhancer or Action node invocation.

Filter nodes never reach a worker; the orchestrator evaluates them in-process.

### Python SDK

Zero external dependencies. Standard-library `http.server` only.

```python
from steppr import StepprWorker, NodeResponse

worker = StepprWorker(port=9001)

@worker.handler("validate_order")
def validate_order(msg):
    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success",
        output={**msg.payload, "validated": True},
    )

@worker.handler("process_payment")
def process_payment(msg):
    # ... call external payment service ...
    return NodeResponse(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        status="success",
        output={**msg.payload, "payment_status": "charged"},
    )

worker.run()
```

### Implementing a worker in another language

The protocol is plain HTTP+JSON. To implement a worker in any language:

`**GET /handlers**` returns:

```json
{ "node_ids": ["validate_order", "process_payment"] }
```

`**POST /execute**` receives:

```json
{
  "execution_id": "exec-123",
  "workflow_id": "order-processing",
  "node_id": "validate_order",
  "node_type": "enhancer",
  "metadata": { "workflow_version": "1.0", "timestamp": "2026-01-01T00:00:00Z", "parent_nodes": [] },
  "payload": { "order_id": "ORD-42", "amount": 150.0 }
}
```

and returns:

```json
{
  "execution_id": "exec-123",
  "node_id": "validate_order",
  "status": "success",
  "output": { "validated": true }
}
```

The orchestrator merges `output` into the running payload (Enhancer/Action are monotonic).

## Validation

`steppr validate` enforces five structural checks plus an optional data-flow check:

- **Acyclicity** — no cycles in the graph
- **Non-merging** — every node has in-degree ≤ 1
- **Type correctness** — Filter nodes have branches; Enhancer/Action nodes don't
- **Referential integrity** — all `next_node` references resolve
- **Reachability** — every node is reachable from the start node
- **Data-flow** (with `--input-fields`) — every node's `reads` are produced by an ancestor or the initial input

Failures are reported with a precise pointer to the offending node:

```
$ steppr validate broken.yaml --input-fields order_id
validation failed with 1 error(s):
  - node "send_email" reads field "email_address" but no ancestor produces it
    (reachable ancestors: [order_id, validated])
```

## Architecture

```
                ┌────────────────────────────────────────┐
                │     Steppr Orchestrator (Go binary)    │
                │  ┌────────┐ ┌────────┐ ┌─────────────┐ │
                │  │ Parser │ │  Exec  │ │  Worker     │ │
                │  │ + Val. │ │ Engine │ │  Registry   │ │
                │  └────────┘ └────────┘ └─────────────┘ │
                └────────┬────────────────────┬──────────┘
                         │ HTTP/JSON          │ /handlers
                ┌────────┴────────┐  ┌────────┴────────┐
                │  Worker (any    │  │  Worker (any    │
                │  language)      │  │  language)      │
                │  /execute       │  │  /execute       │
                │  /handlers      │  │  /handlers      │
                └─────────────────┘  └─────────────────┘
```

At startup, the orchestrator queries each `--workers` URL's `/handlers` endpoint to learn which node IDs each worker serves. The registry maps node IDs to worker URLs; if multiple workers register the same handler, dispatch is round-robin. Filter nodes evaluate in-process and never hit the network.

## Project structure

```
steppr/
  cmd/steppr/             CLI entrypoint (validate, run)
  internal/
    model/                Workflow / condition AST, validators, evaluators
    parser/               YAML workflow parser
    engine/               Execution engine (Filter eval + dispatch)
    dispatch/             HTTP worker dispatch
    registry/             Worker registry (handler discovery, round-robin)
  sdk/
    python/               Python worker SDK (zero deps)
    typescript/           TypeScript SDK (browser-safe engine + Node worker)
    go/                   Go worker SDK
  examples/
    order-processing/     Example workflow with Python, TypeScript, Go workers
  web/                    Browser-based workflow simulator (uses the TS SDK)
```

## Performance

Measured on Apple M4 Pro via `go test -bench`:

- HTTP-loopback dispatch: ~46 µs per node
- 10-node sequential chain: ~463 µs total (linear scaling)
- Static validation: sub-millisecond on the workflows we tested
- Filter evaluation: in-process, sub-microsecond

HTTP round-trip dominates execution time. For latency-sensitive workflows where every node shares a language runtime, in-process orchestration is preferable.

## Contributing

Issues and pull requests welcome. Areas of interest:

- More example workflows in different domains
- Additional condition operators (regex, type checks, set membership)
- Long-running orchestrator mode (HTTP API instead of CLI)
- Additional worker SDKs (Rust, Java, .NET)

## License

[MIT](LICENSE).