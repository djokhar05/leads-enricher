# Lead Enrichment

Independent local-file enrichment microservice. It reads a CSV from the host filesystem,
generates or reuses candidate addresses, sends bounded verification batches to the verifier,
and writes all source rows to a local CSV output.

## Run

```bash
npm install
npm run build
npm start -- --serve
```

CLI:

```bash
npm start -- --input ./data/input/leads.csv --output ./data/output/leads.csv --provider builtin
```

Configure `VERIFIER_BASE_URL`, `VERIFIER_AUTH_TOKEN`, state/output directories, authentication,
provider-call limits, retention, concurrency, and disk thresholds through `.env`. The service does
not upload enrichment inputs or outputs to S3.

## HTTP endpoints

- `GET /health` — enrichment/verifier health and resource summary
- `GET /resources` — RSS, heap, disk, and active-job counts
- `GET /jobs` — durable job list
- `GET /jobs/:id` — job detail
- `GET /jobs/:id/output` — completed CSV download
- `POST /jobs` — create a local-path job
- `POST /upload` — multipart CSV upload to the configured input directory
- `POST /jobs/:id/resume` — resume an existing paused/failed/cancelled job
- `POST /jobs/:id/retry` — retry with bounded retry count
- `POST /jobs/:id/cancel` — request cooperative cancellation
- `GET /files` — allowlisted input/output listings
- `GET /audit` — bounded host-local audit entries
- `GET /retention/preview` — preview terminal-job and file cleanup
- `POST /retention/apply` — apply retention cleanup

All HTTP endpoints require `Authorization: Bearer <LEAD_ENRICHMENT_AUTH_TOKEN>`.
