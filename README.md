# FieldMerge

FieldMerge protects field reports when internet access is unreliable. Two
workers can open the same report, lose their connection, and save different
notes on their own devices. When internet access returns, FieldMerge sends both
changes to the server, keeps either note from silently overwriting the other,
and asks a person to approve the final wording when the notes disagree.

The public demonstration places two test tablets side by side in one browser so
the complete journey is easy to follow. The tablets losing signal is a guided
test scenario. The offline queues, FastAPI requests, PostgreSQL writes,
conflict handling, and live updates are real application behavior.

## What the guided demo shows

The guided run follows one shared pump inspection:

1. Both test tablets receive the same report from PostgreSQL.
2. Each worker saves a different note while their tablet is offline.
3. The tablets reconnect and send their waiting changes through the real API.
4. FieldMerge stores both notes instead of choosing whichever request arrived
   last.
5. The visitor approves the final report wording.
6. The server sends that approved report to both tablets and the page verifies
   that all three saved copies match.

Use **Go to the guided demo**, then **Start the guided demo**. Steps 1-3 run
automatically. At step 4, review the two notes and select **Save final report and
update both tablets**. A more detailed one-minute walkthrough is available in
[`docs/DEMO_GUIDE.md`](docs/DEMO_GUIDE.md).

## Architecture

```text
Tablet North replica             Tablet South replica
Browser storage + queued ops     Browser storage + queued ops
          |                                |
          +---------- HTTP sync -----------+
                           |
                     FastAPI service
              validation + causal merge rules
                    |              |
            PostgreSQL log     WebSocket notices
        operations + snapshots       |
                    |                 +----> connected browsers
             materialized state
```

Each edit carries an operation ID, an actor counter, and the version vector the
device had observed before editing. Those fields let the backend distinguish
"newer" from "concurrent" without relying on network arrival order.

| Concern | FieldMerge behavior |
| --- | --- |
| Duplicate delivery | Accepted once by operation ID and actor/counter dot |
| Reconnect ordering | Merge result is independent of arrival order |
| Scalar fields | Deterministic last-writer-wins tie-breaker |
| Observation | Concurrent values remain as an explicit conflict |
| Resolution | A human-approved operation must cover every conflict candidate |
| Old replica | Snapshot plus remaining operations provides catch-up |
| Live UI | WebSocket publishes committed backend snapshots |

The precise envelope and API responses are documented in
[`docs/SYNC_CONTRACT.md`](docs/SYNC_CONTRACT.md). The implementation design is
expanded in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Deployment

The repository includes a deployment-ready GitHub Actions and Azure Container
Apps path. It publishes immutable frontend and backend images, runs database
migrations, deploys one warm web replica and one warm API replica, and verifies
HTTP, PostgreSQL, and WebSocket behavior before accepting a release.

No cloud resources are created merely by cloning or running the project. Start
with [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the complete beginner guide,
including creating the public GitHub repository, configuring passwordless Azure
access, finding the generated Azure URL, and adding
`fieldmerge.irfanburakozer.com` with an Azure managed certificate.

Secrets are not committed to this repository. Local `.env` files, virtual
environments, dependencies, database files, and generated artifacts are ignored.
The deployment script saves the database URL directly as a masked GitHub secret,
and GitHub uses short-lived identity federation rather than a stored Azure
password.

## Run locally

You need Docker Desktop with its Linux container engine running.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

Then open:

- Demo: <http://localhost:3002>
- Interactive API documentation: <http://localhost:8003/docs>
- Backend readiness: <http://localhost:8003/health/ready>

The first build downloads the images and dependencies, so later starts are
faster. PostgreSQL data remains in the named `fieldmerge-postgres-data` volume
when the containers stop.

To run in the background and wait for readiness:

```powershell
.\scripts\dev.ps1
```

To stop the application without deleting its database:

```powershell
.\scripts\stop.ps1
```

## Verify the complete request path

With the stack running, the smoke test resets only the fixed demo inspection,
synchronizes it, verifies its operation log, and confirms the WebSocket-facing
backend is ready:

```powershell
.\scripts\smoke.ps1
```

For a small, reproducible read/sync latency sample:

```powershell
.\scripts\benchmark.ps1 -Requests 200
```

The benchmark is a local engineering check, not a production capacity claim.
Its raw JSON result is written to `benchmark-results/`.

## Work without Docker

The backend and frontend can also be run separately during development with
Python 3.12 and Node.js 24.

```powershell
# Terminal 1: start PostgreSQL only
docker compose up -d postgres

# Terminal 2: backend
Set-Location backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
$env:FIELDMERGE_DATABASE_URL = "postgresql+asyncpg://fieldmerge:fieldmerge-local-only@localhost:5434/fieldmerge"
alembic upgrade head
uvicorn fieldmerge.main:app --reload --port 8003

# Terminal 3: frontend
Set-Location frontend
npm ci
$env:VITE_API_BASE_URL = "http://localhost:8003"
npm run dev -- --port 3002
```

## Quality checks

The continuous-integration workflow runs the same core checks expected locally:

```powershell
# Backend
Set-Location backend
ruff format --check .
ruff check .
mypy src
pytest

# Frontend
Set-Location ..\frontend
npm ci
npm run lint
npm run test
npm run build

# Container definitions
Set-Location ..
docker compose config --quiet
docker compose build backend frontend
```

After creating `backend/.venv`, the PowerShell wrapper runs the backend,
frontend, and Compose checks in one command:

```powershell
.\scripts\check.ps1
```

## Repository map

```text
backend/                 FastAPI API, causal merge engine, persistence, tests
backend/requirements*.lock  Hashed runtime and CI dependency versions
frontend/                Two-tablet React demo and browser replica
backend/Dockerfile       Reproducible FastAPI container image
frontend/Dockerfile      Reproducible React/Nginx container image
docs/SYNC_CONTRACT.md     Operation and wire contract
docs/ARCHITECTURE.md      Merge, persistence, and catch-up design
docs/DEMO_GUIDE.md        One-minute recruiter walkthrough
docs/DEPLOYMENT.md        GitHub, Azure, DNS, verification, and cleanup guide
docs/SECURITY.md          Security boundaries and production checklist
scripts/                  Local start, smoke, and benchmark commands
.github/workflows/ci.yml  Backend, frontend, and container verification
.github/workflows/deploy-production.yml  Immutable image publishing and Azure release
```

## Current scope

The synchronization engine, two-device demo, persistence, compaction path,
tests, local containers, CI, and bounded public-demo deployment configuration
are included. The Azure resources and custom domain are created only when the
owner follows the deployment guide.

FieldMerge is not presented as a complete field-service product. The included
cloud configuration is deliberately limited to one fixed fictional inspection.
Authentication, tenant isolation, attachment synchronization, push
notifications, and native mobile packaging would be required before using the
engine for real customers or sensitive records. See
[`docs/SECURITY.md`](docs/SECURITY.md) for the exact boundary.

## License

FieldMerge is available under the [MIT License](LICENSE).
