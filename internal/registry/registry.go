// Package registry maintains the mapping from node IDs to worker URLs.
//
// At orchestrator startup, each configured worker URL is queried for its
// /handlers endpoint, which returns the node IDs that worker can handle.
// The registry stores the inverse mapping: node_id -> [worker_url, ...].
//
// During workflow execution, the dispatcher resolves a node ID to a worker
// URL by consulting the registry. If multiple workers are registered for
// the same node, selection is round-robin to spread load.
package registry

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Registry maps node IDs to the workers that can handle them.
type Registry struct {
	mu       sync.RWMutex
	handlers map[string][]string // node_id -> [worker_url, ...]
	next     map[string]*uint64  // round-robin counter per node_id
}

// New creates an empty registry.
func New() *Registry {
	return &Registry{
		handlers: make(map[string][]string),
		next:     make(map[string]*uint64),
	}
}

// handlersResponse is the shape returned by GET /handlers.
type handlersResponse struct {
	NodeIDs []string `json:"node_ids"`
}

// Discover queries each worker URL for its supported handlers and populates
// the registry. Returns the per-worker results so callers can report what
// was discovered. Workers that fail to respond are reported but do not
// fail the overall discovery.
type DiscoveryResult struct {
	WorkerURL string
	NodeIDs   []string
	Error     error
}

// Discover queries the /handlers endpoint of each worker URL and registers
// the returned node IDs against that worker. Errors from individual workers
// are returned in the per-worker DiscoveryResult; only nil-arg errors are
// returned at the top level.
func (r *Registry) Discover(workerURLs []string, timeout time.Duration) []DiscoveryResult {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	client := &http.Client{Timeout: timeout}

	results := make([]DiscoveryResult, 0, len(workerURLs))
	for _, url := range workerURLs {
		result := DiscoveryResult{WorkerURL: url}
		nodeIDs, err := fetchHandlers(client, url)
		if err != nil {
			result.Error = err
		} else {
			result.NodeIDs = nodeIDs
			r.register(url, nodeIDs)
		}
		results = append(results, result)
	}
	return results
}

func fetchHandlers(client *http.Client, workerURL string) ([]string, error) {
	resp, err := client.Get(workerURL + "/handlers")
	if err != nil {
		return nil, fmt.Errorf("GET %s/handlers: %w", workerURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker %s returned status %d", workerURL, resp.StatusCode)
	}
	var hr handlersResponse
	if err := json.NewDecoder(resp.Body).Decode(&hr); err != nil {
		return nil, fmt.Errorf("decode /handlers from %s: %w", workerURL, err)
	}
	return hr.NodeIDs, nil
}

// register adds a worker URL to the list of providers for each node_id.
func (r *Registry) register(workerURL string, nodeIDs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range nodeIDs {
		// Avoid duplicate registration of the same URL for the same node.
		seen := false
		for _, existing := range r.handlers[id] {
			if existing == workerURL {
				seen = true
				break
			}
		}
		if !seen {
			r.handlers[id] = append(r.handlers[id], workerURL)
			if r.next[id] == nil {
				var c uint64
				r.next[id] = &c
			}
		}
	}
}

// Resolve returns a worker URL for the given node ID using round-robin
// selection across all registered workers. Returns ("", false) if no
// worker is registered.
func (r *Registry) Resolve(nodeID string) (string, bool) {
	r.mu.RLock()
	urls := r.handlers[nodeID]
	counter := r.next[nodeID]
	r.mu.RUnlock()

	if len(urls) == 0 {
		return "", false
	}
	idx := atomic.AddUint64(counter, 1) - 1
	return urls[idx%uint64(len(urls))], true
}

// Has reports whether at least one worker is registered for the node ID.
func (r *Registry) Has(nodeID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.handlers[nodeID]) > 0
}

// NodeIDs returns all registered node IDs in sorted order.
func (r *Registry) NodeIDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Workers returns the list of worker URLs registered for a node ID.
func (r *Registry) Workers(nodeID string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	urls := r.handlers[nodeID]
	out := make([]string, len(urls))
	copy(out, urls)
	return out
}
