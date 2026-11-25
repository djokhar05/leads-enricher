# Lead Enrichment Microservice

The Lead Enrichment service processes local CSV lead files, generates candidate
email addresses, sends bounded candidate batches to the separate verifier
microservice, and writes a local enriched CSV.

It does not use S3 or MongoDB for enrichment data. Input, output, checkpoints,
job state, audit records, and runtime data remain on the enrichment host.

## Requirements

- Node.js 22 or newer
- npm
- Network access to the verifier microservice
- A configured verifier shared-secret token
- Sufficient local disk space

Recommended initial host:

- 2 CPU cores
- 8 GB RAM
- 100 GB SSD
- 100 Mbps or faster network

A 4-core/16 GB host is safer for concurrent jobs or large verification batches.

## Install

```bash
cd lead-enrichment
npm install
npm run build
cp .env.example .env
```

Edit `.env` before starting the service.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP server port | `3002` |
| `LEAD_ENRICHMENT_AUTH_TOKEN` | Bearer token required by this service | Required |
| `LEAD_ENRICHMENT_STATE_DIR` | Durable job snapshots | `./data/jobs` |
| `LEAD_ENRICHMENT_INPUT_DIR` | Allowed input directory | `./data/input` |
| `LEAD_ENRICHMENT_OUTPUT_DIR` | Allowed output directory | `./data/output` |
| `LEAD_ENRICHMENT_AUDIT_DIR` | Host-local audit JSONL files | `./data/audit` |
| `LEAD_ENRICHMENT_SUPPRESSIONS_PATH` | Optional suppression CSV | Empty |
| `VERIFIER_BASE_URL` | Verifier HTTP address | `http://127.0.0.1:3001` |
| `VERIFIER_AUTH_TOKEN` | Verifier bearer token | Empty |
| `LEAD_ENRICHMENT_PROVIDER_CALL_LIMIT` | Maximum provider calls per job | `1000` |
| `LEAD_ENRICHMENT_BATCH_SIZE` | Source rows per processing batch | `100` |
| `LEAD_ENRICHMENT_MAX_CONCURRENT_JOBS` | Jobs active in one process | `2` |
| `LEAD_ENRICHMENT_MAX_RETRY_ATTEMPTS` | Maximum retry count | `3` |
| `LEAD_ENRICHMENT_RETRY_BACKOFF_MS` | Initial retry delay | `1000` |
| `LEAD_ENRICHMENT_MIN_FREE_DISK_BYTES` | Disk pause/reject threshold | `1073741824` |
| `LEAD_ENRICHMENT_RETENTION_DAYS` | Terminal snapshot/file retention | `30` |
| `LEAD_ENRICHMENT_MAX_UPLOAD_BYTES` | Maximum multipart upload | `5368709120` |

Provider/finder secrets remain on the enrichment host:

```text
LEAD_FINDER_BASE_URL
LEAD_FINDER_AUTH_TOKEN
LEAD_LLM_BASE_URL
LEAD_LLM_API_KEY
LEAD_LLM_MODEL
```

Never expose these values through API responses, browser code, audit logs, or
client-side configuration.

## Run the HTTP Service

```bash
npm start
```

The service listens on `PORT`, defaulting to `3002`.

Bind it only to localhost or a private network for normal deployment. The
platform backend is the intended public proxy.

For a persistent PM2 process, run `npm run start:pm2` from the service
directory. This starts the already-built service and saves the PM2 process list.
To restore it after a server reboot, configure `pm2 startup` once and follow
the command it prints. For subsequent deployments, deploy the build and run
`pm2 restart lead-enrichment` rather than starting a duplicate process.

## Run the CLI

```bash
npm start -- --input ./data/input/leads.csv
```

Options:

```text
--serve                    Start the HTTP service
--input <path>             Input CSV path
--output <path>            Output CSV path
--provider <name>          builtin, mailtester_ninja, reacher, or qev
--provider-call-limit <n>  Maximum provider calls
--batch-size <n>           Rows per processing batch
--email-column <name>      Existing-email column
--first-name-column <name> First-name column
--last-name-column <name>  Last-name column
--domain-column <name>     Company-domain column
--retain-missing-email     Keep rows without a candidate email
-h, --help                 Print CLI help
-v, --version              Print package version
```

Example:

```bash
npm start -- \
  --input ./data/input/leads.csv \
  --output ./data/output/leads.csv \
  --provider builtin \
  --email-column email \
  --first-name-column first_name \
  --last-name-column last_name \
  --domain-column domain
```

## CSV Behavior

The input is read incrementally with `csv-parse`. The complete file is not loaded
into memory.

The first CSV row supplies column names. A source row receives:

- A stable `lead_row_id`
- An existing email or generated candidate patterns
- Verification status and reason

Original source columns are preserved in the output before enrichment columns.
By default, rows without a candidate email are excluded from the output. The
admin can turn off this filter when creating a job, API clients can set
`excludeMissingEmail` to `false`, and CLI users can pass
`--retain-missing-email`. The input file is unchanged, and job progress counts
all processed rows. A candidate is not necessarily verified: rows with invalid,
uncertain, or otherwise unverified candidates are still included.

If an email column exists, the supplied address is authoritative. Otherwise,
the service currently generates ranked patterns such as:

```text
first.last@domain
first_last@domain
first@domain
initiallast@domain
```

These are candidates, not confirmed mailbox addresses.
Names that match the mapped company name are not used to generate candidates.
This only catches matching names; it does not confirm that other names belong
to the company or that a verified address belongs to the intended person.

To copy the header and a chosen number of data rows into a new CSV without
splitting multiline fields, run:

```bash
python3 scripts/first-rows.py 1000 input.csv first-1000.csv
```

The output file must not already exist. Use a complete source CSV; malformed
records encountered within the selected rows are reported as errors. If fewer
rows are available, all available rows are copied.

## Processing Concurrency

The service has two independent concurrency boundaries:

1. **Concurrent jobs**
   `LEAD_ENRICHMENT_MAX_CONCURRENT_JOBS` limits jobs running in this process.

2. **Rows per batch**
   `LEAD_ENRICHMENT_BATCH_SIZE` limits source rows buffered and verified together.

Recommended starting values:

```text
Maximum concurrent jobs: 1
Batch size: 100
Provider call limit: conservative and below provider quota
```

Increase concurrency only after measuring RAM, disk growth, verifier queue depth,
provider latency, and provider quota usage.

## Verifier Authentication

The enrichment service sends this header to the verifier:

```text
Authorization: Bearer <VERIFIER_AUTH_TOKEN>
```

The enrichment service itself requires:

```text
Authorization: Bearer <LEAD_ENRICHMENT_AUTH_TOKEN>
```

Use a private network or localhost binding unless the service has additional
reverse-proxy authentication.

## Verifier Reachability

`GET /health` checks both enrichment itself and the verifier:

- Enrichment process status
- Active jobs
- Maximum concurrent jobs
- RSS and heap memory
- Disk total/free/used
- Verifier reachability
- Verifier queue depth
- Verifier provider availability

## Job Lifecycle

Job states:

| State | Meaning |
|---|---|
| `queued` | Waiting for an active slot |
| `processing` | Reading, verifying, and writing |
| `paused` | Provider/rate-limit pause or operator pause |
| `completed` | All input rows reached an output state |
| `failed` | Parser, filesystem, verifier, or service failure |
| `cancelled` | Operator cancellation; completed checkpoints are retained |

Supported controls:

- Resume paused/failed/cancelled jobs
- Retry failed/paused jobs within the retry limit
- Cancel queued/active/paused jobs
- Download completed outputs
- Inspect audit entries
- Preview/apply retention cleanup

Cancellation interrupts website research and AI requests and asks the verifier
to stop scheduling further checks. Checks already in progress may finish and
incur charges; their counts are recorded before cancellation completes.
Uncheckpointed rows are retried on resume. Both the enrichment service and the
verifier must run the updated version for cooperative verifier cancellation.

## Checkpoints and Restart Recovery

The service writes JSON snapshots after each batch:

```text
LEAD_ENRICHMENT_STATE_DIR/<job-id>.json
```

Snapshots contain:

- Input/output paths
- Status
- Current checkpoint row
- Processed/total rows
- Provider and billable call counts
- Retry count
- Job mappings, processing settings, and output filter
- Pause/cancel/error information

At HTTP server startup, durable `queued`, `processing`, and `paused` snapshots
are requeued up to the configured concurrency limit.

Already-written output is retained. Restart behavior should be tested against
the actual input/output size before production use.

## File and Resource Limits

The service rejects:

- Uploads above `LEAD_ENRICHMENT_MAX_UPLOAD_BYTES`
- Input/output paths outside the allowlisted directories
- Non-CSV uploads
- Unauthorized requests
- Job starts above `LEAD_ENRICHMENT_MAX_CONCURRENT_JOBS`
- Jobs while free disk is below `LEAD_ENRICHMENT_MIN_FREE_DISK_BYTES`

For a one-million-row file, reserve considerably more than 1 GB. Real disk use
depends on:

- Input width
- Candidate count
- Output columns
- Audit volume
- State/checkpoint size
- Temporary filesystem usage

## Bad Files

Malformed CSV behavior depends on parser and column settings:

- Empty lines are skipped
- BOM headers are handled
- Missing/extra column counts are relaxed
- Missing mapping values produce no candidate
- Candidate-unavailable rows are omitted by default; when retained, they are
  marked `not_deep_verified`
- Parsing/filesystem/verifier failures mark the job failed
- Provider rate limits mark the job paused
- Cancelled jobs retain already-written rows

The service does not silently convert provider or parser failures into valid
addresses.

## Retention and Cleanup

Retention preview reports terminal job snapshots and output/input files eligible
after `LEAD_ENRICHMENT_RETENTION_DAYS`.

```text
GET  /retention/preview
POST /retention/apply
```

Cleanup deletes only terminal-job snapshots and files owned/referenced by those
eligible terminal jobs. It should not be used as an automatic backup or deletion
policy without an operator-retention decision.

## HTTP API

```text
GET  /health
GET  /jobs
GET  /jobs/:jobId
GET  /jobs/:jobId/output
POST /jobs
POST /upload
POST /jobs/:jobId/resume
POST /jobs/:jobId/retry
POST /jobs/:jobId/cancel
GET  /files
GET  /resources
GET  /audit
GET  /retention/preview
POST /retention/apply
```

All endpoints require Bearer authentication.

## Admin UI

The platform backend exposes the service through:

```text
/api/admin/lead-enrichment/*
```

The admin Lead Enrichment page contains:

- Overview
- Jobs
- Create Job / Upload
- Files
- Resources
- Audit
- Retention
- Settings

The browser never receives enrichment service credentials or direct private URLs.

## Main Bottlenecks

The first likely bottlenecks are:

1. Verifier/provider latency
2. Provider quota or rate limit
3. Verifier queue depth
4. Disk write throughput
5. Free disk exhaustion
6. Concurrent jobs exceeding available RAM
7. Wide or malformed CSV rows
8. Slow external finder/LLM provider
9. Missing restart/production benchmarks
10. Lack of multi-host shared coordination

## Benchmark

```bash
npm run benchmark
```

The benchmark currently covers candidate-generation workloads of:

```text
300
3,000
30,000
300,000
1,000,000
5,000,000
```

It reports elapsed time, rows/second, RSS, and heap usage. It is a
candidate-processing benchmark, not an end-to-end provider-verification
benchmark.
