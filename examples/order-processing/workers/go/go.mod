module github.com/harshaneel/steppr/examples/order-processing/workers/go

go 1.22

require github.com/harshaneel/steppr/sdk/go v0.0.0

// Use the local SDK source during development; replace with a tagged
// version once the SDK is published.
replace github.com/harshaneel/steppr/sdk/go => ../../../../sdk/go
