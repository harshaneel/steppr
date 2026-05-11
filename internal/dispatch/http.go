package dispatch

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/harshaneel/steppr/internal/model"
)

type HTTPDispatcher struct {
	Client *http.Client
}

func New() *HTTPDispatcher {
	return &HTTPDispatcher{
		Client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (d *HTTPDispatcher) Dispatch(workerURL string, msg *model.WorkflowMessage) ([]byte, error) {
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshaling message: %w", err)
	}

	resp, err := d.Client.Post(workerURL+"/execute", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("dispatching to worker %s: %w", workerURL, err)
	}
	defer resp.Body.Close()

	// Cap the response size to protect the orchestrator from a misbehaving or
	// malicious worker streaming an unbounded body.
	const maxResponseBytes = 10 << 20 // 10 MiB
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("reading worker response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker %s returned status %d: %s", workerURL, resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

func (d *HTTPDispatcher) DispatchNode(workerURL string, msg *model.WorkflowMessage) (*model.NodeResponse, error) {
	data, err := d.Dispatch(workerURL, msg)
	if err != nil {
		return nil, err
	}
	var resp model.NodeResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("unmarshaling node response: %w", err)
	}
	return &resp, nil
}

func (d *HTTPDispatcher) DispatchFilter(workerURL string, msg *model.WorkflowMessage) (*model.FilterResponse, error) {
	data, err := d.Dispatch(workerURL, msg)
	if err != nil {
		return nil, err
	}
	var resp model.FilterResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("unmarshaling filter response: %w", err)
	}
	return &resp, nil
}
