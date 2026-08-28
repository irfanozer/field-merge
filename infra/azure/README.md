# Azure infrastructure

The templates in this directory are applied by the production GitHub Actions
workflow:

- `foundation.bicep` creates the private network, PostgreSQL Flexible Server,
  Log Analytics workspace, and Container Apps environment.
- `migration.bicep` creates a manually triggered Alembic migration job.
- `apps.bicep` deploys one internal API and one public web application.

Run `scripts/azure/bootstrap-foundation.ps1` once for a new Azure environment.
Normal releases are then performed by `.github/workflows/deploy-production.yml`.

`parameters.example.json` documents non-secret parameter shapes only. Never put
the real database password or database URL in this directory.

The complete first-deployment sequence is in [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).
