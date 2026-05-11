package steppr

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime/debug"
	"sort"
	"sync"
)

// HandlerFunc is the signature a node handler implements. It receives the
// inbound WorkflowMessage and returns either a *NodeResponse or
// *FilterResponse. Returning a non-nil error converts to a "failure"
// NodeResponse with code HANDLER_ERROR; structured failures should be
// returned as a NodeResponse with Status="failure" and a populated Error.
type HandlerFunc func(msg *WorkflowMessage) (any, error)

// Worker is a Steppr HTTP worker. Register handlers per node ID with
// Handler, then call Run to start serving on the configured port.
type Worker struct {
	Port int

	mu       sync.RWMutex
	handlers map[string]HandlerFunc
}

// New returns a Worker that will listen on the given port when Run is
// called. The zero value of Worker is also usable; only Port matters.
func New(port int) *Worker {
	return &Worker{Port: port, handlers: map[string]HandlerFunc{}}
}

// Handler registers a handler for the given node ID. Re-registering
// overwrites the prior handler.
func (w *Worker) Handler(nodeID string, fn HandlerFunc) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.handlers == nil {
		w.handlers = map[string]HandlerFunc{}
	}
	w.handlers[nodeID] = fn
}

// HandlerNode is a convenience for the common case where the handler
// always returns a NodeResponse (Enhancer or Action). The closure
// receives the message and returns the output payload to merge.
//   w.HandlerNode("validate_order", func(msg *WorkflowMessage) (map[string]any, error) {
//       return map[string]any{"validated": true}, nil
//   })
func (w *Worker) HandlerNode(nodeID string, fn func(*WorkflowMessage) (map[string]any, error)) {
	w.Handler(nodeID, func(msg *WorkflowMessage) (any, error) {
		out, err := fn(msg)
		if err != nil {
			return nil, err
		}
		return &NodeResponse{
			ExecutionID: msg.ExecutionID,
			NodeID:      msg.NodeID,
			Status:      "success",
			Output:      out,
		}, nil
	})
}

// Run starts the HTTP server. It blocks until the server returns an error.
func (w *Worker) Run() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/handlers", w.serveHandlers)
	mux.HandleFunc("/execute", w.serveExecute)

	addr := fmt.Sprintf(":%d", w.Port)
	fmt.Printf("steppr worker listening on %s (%d handler(s))\n", addr, len(w.handlers))
	return http.ListenAndServe(addr, mux)
}

func (w *Worker) serveHandlers(rw http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(rw, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.mu.RLock()
	ids := make([]string, 0, len(w.handlers))
	for id := range w.handlers {
		ids = append(ids, id)
	}
	w.mu.RUnlock()
	sort.Strings(ids)
	writeJSON(rw, http.StatusOK, map[string]any{"node_ids": ids})
}

func (w *Worker) serveExecute(rw http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(rw, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var msg WorkflowMessage
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("decoding request: %v", err),
		})
		return
	}

	w.mu.RLock()
	fn := w.handlers[msg.NodeID]
	w.mu.RUnlock()
	if fn == nil {
		writeJSON(rw, http.StatusBadRequest, map[string]any{
			"error": fmt.Sprintf("no handler for node %q", msg.NodeID),
		})
		return
	}

	result, err := safeInvoke(fn, &msg)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, &NodeResponse{
			ExecutionID: msg.ExecutionID,
			NodeID:      msg.NodeID,
			Status:      "failure",
			Output:      map[string]any{},
			Error:       &ErrorInfo{Code: "HANDLER_ERROR", Message: err.Error()},
		})
		return
	}

	writeJSON(rw, http.StatusOK, result)
}

// safeInvoke runs fn and converts panics into normal errors so a worker
// never crashes the process on a buggy handler.
func safeInvoke(fn HandlerFunc, msg *WorkflowMessage) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panic: %v\n%s", r, debug.Stack())
		}
	}()
	return fn(msg)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		http.Error(rw, "marshal error", http.StatusInternalServerError)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_, _ = rw.Write(data)
}
