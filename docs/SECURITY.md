# Security and deployment boundary

FieldMerge has two distinct security contexts:

1. the local development stack, intended for one developer machine; and
2. the Azure public-demo configuration, hardened around one fixed fictional
   inspection so visitors can evaluate the synchronization behavior.

The public demo is not a general production field-service product. It does not
contain user accounts, tenants, customer records, or sensitive field data, and
it should not be repurposed for them without the additional controls below.

## What the bounded public demo protects

- Only the React/Nginx web Container App has public Azure ingress.
- The FastAPI Container App is reachable only inside the Container Apps
  environment; the web container proxies same-origin `/api` and WebSocket
  traffic to it.
- PostgreSQL uses a delegated private subnet, private DNS, and disabled public
  network access.
- Azure ingress requires HTTPS/WSS, and the custom hostname uses an Azure
  managed certificate.
- The production API restricts document access to the fixed fictional
  `inspection-pump-07` record.
- WebSocket connections require an allowed browser origin and the fixed demo
  document ID.
- API schemas reject unknown fields, malformed operation envelopes, blank
  values, oversized identifiers, and unsupported fields.
- A sync request accepts at most 20 pending operations in public-demo mode.
- The fixed report's operation history has a hard 1,000-operation ceiling.
- Operation IDs and actor/counter pairs are unique, so retries cannot create a
  second copy of the same edit.
- Merge policies are enforced by the server rather than accepted from the
  browser.
- Containers run their application processes as non-root users.
- The frontend and API each stay at exactly one replica, which keeps the
  demonstration predictable and avoids multiplying process-local WebSocket
  state.
- The deployment uses immutable container image digests, applies migrations
  before release, checks the live HTTP/database/WebSocket path, and restores the
  prior image digests when verification fails.

The reset and compaction routes remain intentionally available for the fixed
fictional report. Any visitor can change or reset that shared demonstration
record. That is acceptable only because the data is disposable, contains no
personal information, and is bounded by document and operation limits.

## Secret handling

No secrets are committed to this repository.

- `.gitignore` excludes real `.env` files, virtual environments, installed
  packages, local databases, logs, and build output.
- Committed configuration examples contain placeholders only.
- The Azure foundation script generates a database password in memory and
  deletes its temporary deployment parameter file.
- The complete TLS-required database URL is stored as the masked GitHub secret
  `FIELDMERGE_DATABASE_URL`.
- Azure Container Apps receives the database URL as a secret reference rather
  than plain source configuration.
- GitHub authenticates to Azure through OIDC with a short-lived token. No Azure
  client secret or password is created for the workflow.
- The deployment identity has Contributor access only on
  `rg-fieldmerge-prod`, not on the whole subscription.

Do not paste credentials into issues, workflow logs, screenshots, source files,
or committed parameter files. If a database URL is ever exposed, rotate the
PostgreSQL administrator password and replace the GitHub secret.

## Why this is not yet a real multi-user product

The public visitor is anonymous. The fixed demo restriction limits the blast
radius, but it is not user authentication or authorization. Before storing real
work or allowing arbitrary documents, the product would need:

1. user authentication and authorization on every document and operation;
2. tenant isolation in the API, database schema, indexes, and queries;
3. server-issued device identities instead of browser-selected actor IDs;
4. per-user and per-tenant request rate limits, quotas, and abuse detection;
5. authorization and stronger policy around reset, compaction, and operation-log
   endpoints;
6. attachment type, size, malware, storage, and download controls;
7. encryption and retention policies appropriate for the actual data;
8. audit logs for authentication and synchronization decisions without copying
   sensitive observation text into infrastructure logs;
9. automated PostgreSQL backups plus a tested point-in-time restore procedure;
10. dependency and image scanning, alerting, incident response, and credential
    rotation procedures;
11. load, reliability, and WebSocket fan-out testing based on measured product
    traffic;
12. a multi-replica WebSocket backplane or managed real-time service before
    horizontally scaling the API.

## Custom-domain safety

The first deployment uses the generated Azure hostname. After Cloudflare DNS
and the Azure managed certificate are working, set the GitHub Actions variable
`FIELDMERGE_REQUIRE_CUSTOM_DOMAIN=true`.

Every later deployment reads the existing hostname and certificate ID and
passes them back into the infrastructure template. If the required certificate
cannot be found, the workflow stops before updating the web app. This protects
the working `fieldmerge.irfanburakozer.com` binding from being removed by a
normal deployment.

Keep the Cloudflare CNAME in **DNS only** mode. Proxying it changes the expected
certificate validation and traffic path.

## Operations to monitor

- Azure costs and remaining subscription credit;
- PostgreSQL storage, connections, backup status, and failed queries;
- Container restarts, readiness failures, 4xx/5xx responses, and latency;
- Log Analytics ingestion against the configured daily cap;
- migration-job and GitHub deployment failures;
- operation history approaching the fixed 1,000-operation ceiling;
- unexpected reset or compaction frequency.

Deleting `rg-fieldmerge-prod` is the complete Azure cost stop and permanently
deletes the database and all application resources. The exact deployment and
cleanup steps are in [`DEPLOYMENT.md`](DEPLOYMENT.md).
