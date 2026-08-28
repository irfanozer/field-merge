# Local benchmark interpretation

`scripts/benchmark.ps1` measures repeated synchronization requests with no
pending operations against the built-in inspection. It reports minimum, median,
p95, p99, maximum, and requests per second, then saves the sample and environment
metadata as JSON.

This check is useful for detecting a large local regression in request handling.
It does **not** establish production throughput because it runs one PowerShell
client, one document, one local Docker network, and no realistic concurrent
WebSocket population.

## Reproducible run

1. Start a clean stack with `docker compose up --build -d`.
2. Run `scripts/smoke.ps1` once.
3. Run `scripts/benchmark.ps1 -Warmup 20 -Requests 200`.
4. Keep the generated JSON when comparing a later commit on the same machine.

For deployment sizing, add concurrent documents and actors, write-heavy sync
batches, compacted clients, WebSocket fan-out, database resource metrics, and a
steady-state run long enough to observe connection-pool behavior.

