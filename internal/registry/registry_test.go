package registry

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newWorker(t *testing.T, nodeIDs []string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/handlers" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"node_ids": nodeIDs})
	}))
}

func TestDiscoverAndResolve(t *testing.T) {
	w1 := newWorker(t, []string{"validate", "enrich"})
	defer w1.Close()
	w2 := newWorker(t, []string{"enrich", "pay"})
	defer w2.Close()

	r := New()
	results := r.Discover([]string{w1.URL, w2.URL}, time.Second)
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	for _, res := range results {
		if res.Error != nil {
			t.Errorf("unexpected error for %s: %v", res.WorkerURL, res.Error)
		}
	}

	// Single-worker handlers resolve to that worker.
	got, ok := r.Resolve("validate")
	if !ok || got != w1.URL {
		t.Errorf("Resolve(validate): got %q ok=%v, want %q", got, ok, w1.URL)
	}

	got, ok = r.Resolve("pay")
	if !ok || got != w2.URL {
		t.Errorf("Resolve(pay): got %q ok=%v, want %q", got, ok, w2.URL)
	}

	// Multi-worker handler round-robins between both workers.
	seen := map[string]int{}
	for i := 0; i < 6; i++ {
		got, ok := r.Resolve("enrich")
		if !ok {
			t.Fatal("Resolve(enrich) returned !ok")
		}
		seen[got]++
	}
	if seen[w1.URL] != 3 || seen[w2.URL] != 3 {
		t.Errorf("expected even round-robin distribution, got %v", seen)
	}

	// Unknown node returns false.
	if _, ok := r.Resolve("bogus"); ok {
		t.Error("Resolve(bogus) should return ok=false")
	}

	// Has() reflects registration state.
	if !r.Has("validate") {
		t.Error("Has(validate) should be true")
	}
	if r.Has("nope") {
		t.Error("Has(nope) should be false")
	}
}

func TestDiscoverFailingWorker(t *testing.T) {
	w := newWorker(t, []string{"alpha"})
	defer w.Close()

	r := New()
	results := r.Discover([]string{w.URL, "http://127.0.0.1:1"}, 200*time.Millisecond)
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if results[0].Error != nil {
		t.Errorf("alpha worker should succeed: %v", results[0].Error)
	}
	if results[1].Error == nil {
		t.Error("unreachable worker should produce an error")
	}
	// Working worker still produced a registration.
	if !r.Has("alpha") {
		t.Error("alpha should be registered despite the second worker failing")
	}
}
