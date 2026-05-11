import json
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

from steppr.types import WorkflowMessage, NodeResponse, FilterResponse


class StepprWorker:
    """Minimal worker SDK for Steppr workflows.

    Register handlers for node IDs using the @worker.handler decorator,
    then call worker.run() to start the HTTP server.

    Filter handlers should return a FilterResponse.
    Enhancer/Action handlers should return a NodeResponse.
    """

    def __init__(self, port: int = 8080):
        self.port = port
        self._handlers: dict[str, callable] = {}

    def handler(self, node_id: str):
        """Decorator to register a handler for a node ID."""
        def decorator(fn):
            self._handlers[node_id] = fn
            return fn
        return decorator

    def run(self):
        """Start the worker HTTP server."""
        worker = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                # Discovery endpoint: tells the orchestrator which node IDs
                # this worker can handle. Used to build the registry.
                if self.path == "/handlers":
                    self._respond(200, {"node_ids": sorted(worker._handlers.keys())})
                    return
                self.send_error(404, "Not found")

            def do_POST(self):
                if self.path != "/execute":
                    self.send_error(404, "Not found")
                    return

                length = int(self.headers.get("Content-Length", 0))
                if length <= 0:
                    self._respond(400, {"error": "missing or empty request body"})
                    return
                try:
                    body = json.loads(self.rfile.read(length))
                except json.JSONDecodeError:
                    self._respond(400, {"error": "invalid JSON in request body"})
                    return

                msg = WorkflowMessage(
                    execution_id=body["execution_id"],
                    workflow_id=body["workflow_id"],
                    node_id=body["node_id"],
                    node_type=body.get("node_type", ""),
                    metadata=body.get("metadata", {}),
                    payload=body.get("payload", {}),
                )

                fn = worker._handlers.get(msg.node_id)
                if fn is None:
                    self._respond(400, {"error": f"no handler for node {msg.node_id}"})
                    return

                try:
                    result = fn(msg)
                    if isinstance(result, (NodeResponse, FilterResponse)):
                        self._respond(200, result.to_dict())
                    elif isinstance(result, dict):
                        self._respond(200, result)
                    else:
                        self._respond(500, {"error": "handler must return NodeResponse, FilterResponse, or dict"})
                except Exception as exc:
                    # Log full traceback locally for debugging, but only return
                    # a short error message to the caller; do not leak file
                    # paths or stack frames over the wire.
                    traceback.print_exc()
                    self._respond(500, {
                        "execution_id": msg.execution_id,
                        "node_id": msg.node_id,
                        "status": "failure",
                        "error": {"code": "HANDLER_ERROR", "message": str(exc) or "handler raised"},
                    })

            def _respond(self, status: int, body: dict):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args):
                pass  # Suppress default request logging.

        server = HTTPServer(("0.0.0.0", self.port), Handler)
        print(f"steppr worker listening on :{self.port} ({len(worker._handlers)} handler(s))")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nshutting down")
            server.shutdown()
