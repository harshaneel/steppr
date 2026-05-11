# @steppr/sdk

TypeScript SDK for [Steppr](../../README.md) — workflow orchestration engine with three node types.

The package has two entry points:

- **`@steppr/sdk`** — browser-safe core. Types, YAML parser, condition evaluator, validator, in-process execution engine, HTTP-based and in-memory handler resolvers.
- **`@steppr/sdk/worker`** — Node-only HTTP worker server. Mirrors the Python SDK API.

## Usage — Node worker

```ts
import { StepprWorker } from "@steppr/sdk/worker";

const worker = new StepprWorker({ port: 9001 });

worker.handler("validate_order", (msg) => ({
  execution_id: msg.execution_id,
  node_id: msg.node_id,
  status: "success",
  output: { ...msg.payload, validated: true },
}));

await worker.run();
```

The worker exposes:

- `GET /handlers` returning `{ node_ids: [...] }` for orchestrator discovery
- `POST /execute` taking a `WorkflowMessage` and returning a `NodeResponse`

## Usage — in-browser simulator

The core package runs in any modern browser. Use `InMemoryResolver` to provide handler functions directly without HTTP:

```ts
import { parse, validate, Engine, InMemoryResolver } from "@steppr/sdk";

const wf = parse(yamlString);
validate(wf, { initialFields: ["order_id", "tier", "amount"] });

const resolver = new InMemoryResolver();
resolver.register("validate_order", (msg) => ({
  execution_id: msg.execution_id,
  node_id: msg.node_id,
  status: "success",
  output: { ...msg.payload, validated: true },
}));
// ... register the rest ...

const engine = new Engine(resolver);
const result = await engine.execute(wf, "exec-1", { order_id: "ORD-42", tier: "premium", amount: 150 });
```

## Usage — in-browser HTTP orchestrator

For driving real HTTP workers from a frontend (CORS permitting):

```ts
import { parse, validate, Engine, HttpResolver } from "@steppr/sdk";

const wf = parse(yamlString);
validate(wf);

const resolver = await HttpResolver.discover([
  "http://localhost:9001",
  "http://localhost:9002",
]);

const engine = new Engine(resolver);
const result = await engine.execute(wf, "exec-1", { ... });
```

## API

### `parse(yaml: string): WorkflowDef`
Parses a YAML workflow definition. Distinguishes plain (path) vs quoted (literal) scalars in conditions per the spec.

### `validate(wf: WorkflowDef, opts?: { initialFields?: string[] }): void`
Throws `ValidationError` with a list of issues if any structural or data-flow check fails. Pass `initialFields` to enable data-flow validation.

### `evaluate(condition: Condition, payload: Payload): boolean`
Evaluates a condition AST against a payload. Loose-typed equality.

### `class Engine(resolver: HandlerResolver, opts?: EngineOptions)`
- `execute(wf, executionId, input): Promise<ExecutionResult>` — runs the workflow.

### `class InMemoryResolver`
- `register(nodeId, fn)` — register a handler.
- Implements `HandlerResolver`.

### `class HttpResolver`
- `static discover(urls, timeoutMs?)` — query each worker's `/handlers` endpoint and build the registry.
- Implements `HandlerResolver` with round-robin selection.

### `class StepprWorker (from @steppr/sdk/worker)`
- `new StepprWorker({ port?, host? })`
- `handler(nodeId, fn): this` — register a handler.
- `run(): Promise<() => Promise<void>>` — start the HTTP server; resolves to a stop function.

## Build

```bash
npm install
npm run build       # compiles to dist/
npm test            # 32 tests covering parser, conditions, validator, engine
```

## License

MIT.
