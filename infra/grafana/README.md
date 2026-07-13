# GPU observability with Grafana

Rukter exposes a read-only Prometheus-compatible endpoint at `/metrics` and a human-facing monitor at `/gpu-status.html`. The endpoint contains only aggregate worker, queue and anonymous session gauges; it never includes a job id, user identity, provider token, worker IP, or upload URL.

Run Grafana and Prometheus in a private monitoring network, then put them behind the existing admin SSO/Cloudflare Access policy. Do not expose Grafana anonymously and do not place `AMD_GPU_ORCHESTRATOR_TOKEN` in a dashboard or browser request.

Minimal Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: rukter-ai
    metrics_path: /metrics
    scrape_interval: 10s
    static_configs:
      - targets: [rukter.ai]
```

The public dashboard is intentionally polling-based and read-only. The Prometheus endpoint is for Grafana panels such as GPU utilization, VRAM, temperature, worker readiness, active GPU jobs, queued jobs and anonymous active sessions. Installing Grafana itself remains an infrastructure operation and must be scheduled through the deployment drain after the live app is idle.
