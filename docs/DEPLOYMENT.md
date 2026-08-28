# Deploy FieldMerge to Azure

This guide starts with the current local folder and no GitHub repository. It
ends with a public repository, an automated Azure deployment, and the custom
address `https://fieldmerge.irfanburakozer.com`.

## What will run in the cloud

```text
Visitor's browser
      |
      v
Cloudflare DNS (address lookup only; proxy disabled)
      |
      v
Public Azure web Container App (React + Nginx, one warm replica)
      |
      +-- /api (HTTP + WebSocket) --> Internal Azure API Container App
                                      (FastAPI, one warm replica)
                                      |
                                      v
                         Private PostgreSQL Flexible Server
```

Only the web Container App accepts public traffic. The API is internal to the
Container Apps environment, and PostgreSQL has public access disabled. Azure
terminates HTTPS and supports the WebSocket used by the live page.

The repository also creates a manual Container Apps job that runs Alembic
database migrations before each release. GitHub Actions verifies HTTP,
PostgreSQL, and WebSocket behavior after deployment and restores the previously
deployed images if that release check fails.

## Cost and warm-container boundary

Do not run the foundation script until you intend to create billable Azure
resources. It creates:

- a burstable PostgreSQL Flexible Server (`Standard_B1ms`) with 32 GiB of
  storage and seven-day backups;
- a Container Apps environment connected to a virtual network;
- one web replica and one API replica that stay warm;
- private DNS and a Log Analytics workspace with a 1 GiB daily ingestion cap
  and 30-day retention;
- a migration job that runs only during deployment.

The web and API both use `minReplicas: 1` and `maxReplicas: 1`. Keeping them
warm avoids the long first request that a recruiter can encounter when an app
scales from zero, but it also means they can accrue compute charges while no one
is visiting. PostgreSQL is also provisioned continuously.

An Azure free subscription or promotional credit can pay these charges while
credit remains, but it does not make every resource permanently free. Free
allowances and credits are shared across the subscription, so other portfolio
projects can consume them. Before provisioning:

1. open **Azure Portal > Cost Management + Billing**;
2. review the subscription's remaining credit and free-service usage;
3. estimate `eastus2` prices in the
   [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/);
4. create a small budget alert for the resource group.

Budget alerts notify you; they do not stop resources. The complete cost stop is
to delete `rg-fieldmerge-prod` after exporting anything you want to keep.

## Secrets and repository safety

No secrets are committed to this repository. `.gitignore` excludes `.env`
files, virtual environments, installed packages, local databases, logs, and
build output. The committed `.env.example` and
`infra/azure/parameters.example.json` contain placeholders only.

The foundation script generates the PostgreSQL password in memory, uses a
temporary parameter file that it deletes, and sends the resulting database URL
directly to the masked GitHub secret `FIELDMERGE_DATABASE_URL`. The OIDC script
does not create an Azure client secret. GitHub receives short-lived Azure
credentials only when the production workflow runs.

Never paste a database URL, password, Azure credential, GitHub token, or local
`.env` file into the repository.

## 1. Install and sign in to the command-line tools

You need Git, Azure CLI, GitHub CLI, and PowerShell. Docker Desktop is useful for
the local checks but is not used to run production.

On Windows, install any missing tools from PowerShell:

```powershell
winget install --exact --id Git.Git
winget install --exact --id Microsoft.AzureCLI
winget install --exact --id GitHub.cli
```

Close and reopen PowerShell after installation. Then sign in:

```powershell
az login
az account list --output table

gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git
gh auth status
```

`az account list` displays the Azure subscription ID needed below. Select the
subscription that contains the free credit if more than one appears.

No personal access token is required for this path. GitHub CLI opens the browser
for authorization, and the deployment uses OIDC instead of a saved Azure
password.

## 2. Create the public GitHub repository and push this folder

Open PowerShell in the FieldMerge root: the folder containing `README.md`,
`compose.yaml`, `backend`, and `frontend`.

This local copy is already initialized on the `main` branch, but it has no
commit and no remote repository. Review the files before the first commit:

```powershell
git status --short
```

Do not continue if the output includes a real `.env` file, password, database
URL, token, `.venv`, or `node_modules`. `.env.example` files are expected and
safe to commit.

Create the first commit and the public GitHub repository:

```powershell
git add .
git commit -m "Build FieldMerge offline synchronization demo"

gh repo create irfanozer/field-merge `
  --public `
  --source . `
  --remote origin `
  --push
```

Confirm the result:

```powershell
git remote -v
gh repo view irfanozer/field-merge --web
```

The required repository format is `OWNER/REPOSITORY`, so this project uses
`irfanozer/field-merge`.

## 3. Wait for CI and publish the two container packages

The first push starts **CI**. Open the repository's **Actions** tab and wait for
the backend, frontend, and container jobs to pass.

After CI succeeds, **Publish images and deploy production** starts
automatically. Its image job publishes:

- `ghcr.io/irfanozer/field-merge-backend:<commit-sha>`
- `ghcr.io/irfanozer/field-merge-frontend:<commit-sha>`

Azure deployment is intentionally skipped at this point because
`AZURE_DEPLOYMENT_ENABLED` is not yet `true`.

A public GitHub repository does not automatically make its GHCR packages
public. For each package:

1. open `https://github.com/irfanozer/field-merge`;
2. select the package under **Packages**;
3. select **Package settings**;
4. find **Danger Zone > Change package visibility**;
5. choose **Public** and confirm the package name.

Make both `field-merge-backend` and `field-merge-frontend` public. Azure then
pulls the images without a GitHub password or registry token.

If the packages do not appear after CI succeeds, manually start the publishing
workflow:

```powershell
gh workflow run deploy-production.yml `
  --repo "irfanozer/field-merge" `
  --ref main
```

## 4. Create the Azure foundation

Use the subscription ID shown by `az account list --output table`:

```powershell
.\scripts\azure\bootstrap-foundation.ps1 `
  -SubscriptionId "YOUR_AZURE_SUBSCRIPTION_ID" `
  -GitHubRepository "irfanozer/field-merge" `
  -Location "eastus2" `
  -ConfirmCosts
```

The script:

1. registers the Azure providers used by the project;
2. creates `rg-fieldmerge-prod`;
3. deploys the virtual network, private DNS, Log Analytics, Container Apps
   environment, private PostgreSQL server, and `fieldmerge` database;
4. generates a strong database password without printing it;
5. stores the TLS-required database URL as the masked GitHub secret
   `FIELDMERGE_DATABASE_URL`;
6. creates the non-secret GitHub Actions variables used by the workflow;
7. leaves Azure application deployment disabled.

The final output should say **Foundation created successfully** and tell you to
run the OIDC script next.

## 5. Configure passwordless GitHub-to-Azure access

Run:

```powershell
.\scripts\azure\configure-github-oidc.ps1 `
  -SubscriptionId "YOUR_AZURE_SUBSCRIPTION_ID" `
  -GitHubRepository "irfanozer/field-merge"
```

This script reads the real GitHub owner and repository IDs, creates the GitHub
`production` environment, creates a dedicated Microsoft Entra application,
grants it Contributor access only to `rg-fieldmerge-prod`, and creates the exact
federated identity expected by the workflow. It also saves
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` as repository
variables.

The successful final message is **GitHub OIDC is ready. No Azure client secret
was created.** Do not manually type a federated subject in Azure; the script
uses immutable GitHub IDs to avoid an `AADSTS700213` identity mismatch.

## 6. Check the GitHub settings and enable deployment

Open **GitHub repository > Settings > Secrets and variables > Actions**.

Under **Secrets**, confirm:

- `FIELDMERGE_DATABASE_URL`

Under **Variables**, confirm:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_NAME_PREFIX`
- `AZURE_ENVIRONMENT_NAME`
- `AZURE_CONTAINER_APPS_ENVIRONMENT`
- `FIELDMERGE_CUSTOM_DOMAIN`
- `FIELDMERGE_REQUIRE_CUSTOM_DOMAIN`
- `AZURE_DEPLOYMENT_ENABLED`

Enable deployment:

```powershell
gh variable set AZURE_DEPLOYMENT_ENABLED `
  --repo "irfanozer/field-merge" `
  --body "true"
```

Start the first release:

```powershell
gh workflow run deploy-production.yml `
  --repo "irfanozer/field-merge" `
  --ref main
```

You can instead open **Actions > Publish images and deploy production > Run
workflow**, select `main`, and press **Run workflow**.

The release performs these steps in order:

1. publishes the tested commit as immutable image digests;
2. signs in to Azure with a short-lived OIDC token;
3. validates the Bicep templates;
4. creates and runs the private Alembic migration job;
5. deploys the internal API and public web app with one warm replica each;
6. verifies public health, PostgreSQL persistence, and a real WebSocket update;
7. restores the previous image digests if live verification fails.

## 7. Find and test the generated Azure address

In GitHub:

1. open **Actions**;
2. open the latest **Publish images and deploy production** run;
3. open its **Summary** page;
4. find **FieldMerge production deployment**.

The summary contains two clickable values:

- **Public URL** - the address tested by the workflow;
- **Azure origin** - the generated `azurecontainerapps.io` address.

On the first deployment, both values are the generated Azure address because
the custom certificate does not exist yet. Open it and run the guided demo. Do
not configure the custom domain until this address works.

## 8. Add Cloudflare DNS and an Azure managed certificate

Print the exact DNS values from Azure:

```powershell
.\scripts\azure\show-domain-records.ps1 `
  -SubscriptionId "YOUR_AZURE_SUBSCRIPTION_ID"
```

Create the printed records under **Cloudflare > irfanburakozer.com > DNS >
Records**:

| Type | Name | Target or value | Proxy status |
| --- | --- | --- | --- |
| CNAME | `fieldmerge` | generated `azurecontainerapps.io` hostname | **DNS only** |
| TXT | `asuid.fieldmerge` | Azure verification ID | n/a |

The Cloudflare CNAME must use the gray cloud, **DNS only**, not Proxied. Azure
must see the direct CNAME to issue and renew the certificate.

If the Cloudflare zone already has any CAA record, also allow DigiCert:

| Type | Name | Flags | Tag | CA domain |
| --- | --- | ---: | --- | --- |
| CAA | `@` | `0` | `issue` | `digicert.com` |

After DNS resolves:

1. open **Azure Portal > Container Apps > fieldmerge-web-prod**;
2. open **Networking > Custom domains**;
3. choose **Add custom domain**;
4. enter `fieldmerge.irfanburakozer.com`;
5. choose an Azure managed certificate and CNAME validation;
6. if the domain says **No binding**, select **Add binding** and choose the
   managed certificate;
7. wait until the domain is shown as secured;
8. open `https://fieldmerge.irfanburakozer.com` in a private browser window.

Protect that binding during every future deployment:

```powershell
gh variable set FIELDMERGE_REQUIRE_CUSTOM_DOMAIN `
  --repo "irfanozer/field-merge" `
  --body "true"
```

Run the deployment workflow one more time. It reads the existing custom domain
and managed-certificate resource ID and passes both back into Bicep. When
`FIELDMERGE_REQUIRE_CUSTOM_DOMAIN=true`, a future release stops before changing
the web app if the certificate cannot be found. This prevents a deployment from
silently removing the working hostname binding.

## 9. Verify the public deployment

Run these checks from the repository root:

```powershell
$baseUrl = "https://fieldmerge.irfanburakozer.com"

Invoke-RestMethod "$baseUrl/healthz"
Invoke-RestMethod "$baseUrl/health/ready"
.\scripts\smoke.ps1 -ApiBaseUrl $baseUrl
```

The smoke test resets only the fixed fictional inspection, reads it from
PostgreSQL, performs an idempotent sync, and reads the persisted operation log.

The GitHub deployment workflow also performs the fuller verification that opens
a WebSocket, submits a unique change, confirms that HTTP and WebSocket return
the same committed state, reads the change back from PostgreSQL, and resets the
fictional inspection afterward.

Finally, open the site and complete the visible guided demo:

1. select **Go to the guided demo**;
2. select **Start the guided demo**;
3. wait for steps 1-3 to complete;
4. review the two saved offline notes;
5. select **Save final report and update both tablets**;
6. confirm the page says **Verified: both tablets match the server.**

## Normal updates after the first deployment

For later changes:

```powershell
git status
git add .
git commit -m "Describe the change"
git push
```

A successful CI run on `main` automatically triggers the production workflow.
The release keeps the web and API warm, preserves the custom hostname and
certificate, migrates the database before releasing new images, and verifies
the live system.

Pause future releases without deleting Azure resources:

```powershell
gh variable set AZURE_DEPLOYMENT_ENABLED `
  --repo "irfanozer/field-merge" `
  --body "false"
```

This pauses deployments but does not stop billing.

## Complete cleanup and cost stop

Deleting the resource group permanently deletes the Azure database, logs,
Container Apps, migration job, managed certificate, and networking resources.
It cannot be undone.

First pause deployments, then run the explicit cleanup command:

```powershell
gh variable set AZURE_DEPLOYMENT_ENABLED `
  --repo "irfanozer/field-merge" `
  --body "false"

.\scripts\azure\destroy-production.ps1 `
  -SubscriptionId "YOUR_AZURE_SUBSCRIPTION_ID" `
  -Confirmation "DELETE-FIELDMERGE-PRODUCTION"
```

Azure accepts the deletion asynchronously. Billing stops only after the
resources finish deleting. Confirm in **Azure Portal > Resource groups** that
`rg-fieldmerge-prod` is gone.

Then remove the Cloudflare `fieldmerge` CNAME and `asuid.fieldmerge` TXT record.
If the dedicated Microsoft Entra application is no longer needed, delete
`fieldmerge-github-production` under **Microsoft Entra ID > App registrations**.
The public GitHub repository and GHCR packages remain available unless you
choose to delete them separately.
