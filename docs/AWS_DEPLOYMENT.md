# Deploy FieldMerge to AWS

This is an independent deployment option beside Azure. The existing Azure
templates, scripts, certificates, and workflow remain available. No AWS resources
are created just by copying or pushing these files. Provisioning requires
`-ConfirmCosts`, and releases require `AWS_DEPLOYMENT_ENABLED=true`.

## What you are deploying

```text
Browser -> CloudFront HTTPS
             |-- React page and assets -> private S3 bucket
             `-- /api/* and health -> HTTPS Caddy -> private Nginx -> FastAPI
                                     HTTP and WebSockets              |
                                                                 PostgreSQL
                                                      (one warm EC2 server)

GitHub CI -> public immutable GHCR images
          -> temporary AWS OIDC credentials -> release archive in S3
          -> Systems Manager -> migrations and containers on EC2
          -> frontend assets in S3 -> CloudFront refresh -> live sync test

PostgreSQL -> daily logical backup -> separate private S3 backup bucket
```

This uses the same single-server approach as RouteWise, but creates a separate
FieldMerge server, database, disks, buckets, distribution, and deployment role.
It does not modify RouteWise. The account's GitHub OIDC provider can be reused;
the FieldMerge role is restricted to its own repository and environment.

- EC2 runs Caddy, Nginx, Python/FastAPI, and PostgreSQL continuously. Containers
  stay warm, with no intentional scale-to-zero delay.
- Encrypted EBS storage keeps database data across application releases.
- CloudFront serves the React files from private S3 and forwards HTTP API calls
  and WebSocket connections to the server. Dynamic responses are not cached.
- Systems Manager runs deployment commands without opening SSH.
- ACM provides the public CloudFront certificate. Caddy manages the separate
  origin certificate.
- Cloudflare remains the DNS provider only. CloudFormation is the infrastructure
  tool, not CloudFront or Cloudflare.

There is no Lightsail, RDS, ECS, EKS, load balancer, NAT gateway, or Route 53 in
this design. This is a small public demonstration, not a highly available
production service. Server restarts, maintenance, and migrations can interrupt
requests. One API process is intentional because live broadcasts use an
in-process connection manager.

### Costs and data

The default is a separate `t3.small` with 2 GiB RAM, one public IPv4 address,
a 12 GiB root disk, and a 30 GiB data disk. These resources are billable while
the server is idle. S3, backups, retained snapshots, and CloudFront usage can
add charges. T3 Standard credit mode avoids surplus CPU-credit charges but can
throttle sustained CPU load.

Review the [AWS pricing calculator](https://calculator.aws/) and your remaining
account credits before step 3. This is not a permanently free deployment.
Create a budget alert, understanding that alerts do not stop spending. Keeping
FieldMerge on Azure and AWS at the same time means paying for both. Stopping
EC2 does not remove disk, backup, or allocated IPv4 charges.

AWS starts with a fresh fictional pump inspection. Existing Azure notes,
operation history, and browser-local offline queues are not migrated. The live
smoke test resets only the fixed demo inspection before and after verification.
Do not store real field work or sensitive information in either public demo.
If old demo history matters, plan an export and restore before switching DNS.

## 1. Copy and push the additions

Use the existing `irfanozer/field-merge` repository. There is no need to create a
new repository or replace its Azure files. Review local changes before copying:
matching destination files listed below will be overwritten.

```powershell
$fieldMergeSource = "C:\path\to\updated\field-merge"
$fieldMergeDestination = "D:\field-merge"

robocopy "$fieldMergeSource\infra\aws" "$fieldMergeDestination\infra\aws" /E /R:2 /W:2
robocopy "$fieldMergeSource\scripts\aws" "$fieldMergeDestination\scripts\aws" /E /R:2 /W:2 /XD __pycache__
robocopy "$fieldMergeSource\tests\deployment" "$fieldMergeDestination\tests\deployment" /E /R:2 /W:2 /XD __pycache__
robocopy "$fieldMergeSource\.github\workflows" "$fieldMergeDestination\.github\workflows" aws-assets.yml deploy-aws.yml /R:2 /W:2
robocopy "$fieldMergeSource\docs" "$fieldMergeDestination\docs" AWS_DEPLOYMENT.md /R:2 /W:2
robocopy "$fieldMergeSource" "$fieldMergeDestination" README.md /R:2 /W:2

Set-Location D:\field-merge
git status --short
git add infra/aws scripts/aws tests/deployment .github/workflows/aws-assets.yml .github/workflows/deploy-aws.yml docs/AWS_DEPLOYMENT.md README.md
git diff --cached --stat
git commit -m "Add independent AWS deployment for FieldMerge"
git push origin main
```

Replace the source path with the folder containing the prepared files. Robocopy
codes 0 through 7 are nonfatal; stop on any code 8 or higher. These commands do
not use `/MIR` and do not copy `.git`, secrets, databases, or dependencies.

Wait for **CI**, **AWS deployment assets**, and the image-publishing job in
**Publish images and deploy production**. The existing Azure job still follows
your existing `AZURE_DEPLOYMENT_ENABLED` setting.

Both GHCR packages must be public:

- `ghcr.io/irfanozer/field-merge-backend`
- `ghcr.io/irfanozer/field-merge-frontend`

A public repository does not automatically make its packages public. In GitHub,
open your profile, **Packages**, each package, **Package settings**, then
**Change visibility**, **Public**. No personal registry token is needed.

## 2. Sign in to the same AWS account

AWS CLI v2 and GitHub CLI are already needed by the RouteWise setup. Use a
separate local profile name so the commands are easy to recognize. A profile
name is not a separate AWS account and does not create resources.

```powershell
aws --version
aws login --profile fieldmerge
aws sts get-caller-identity --profile fieldmerge
gh auth status
```

Select the same AWS account you used for RouteWise. Use a non-root identity with
the required infrastructure permissions and MFA. If GitHub is signed out, run
`gh auth login`. Browser-based `aws login` requires AWS CLI 2.32.0 or later;
update the CLI if needed. An organization using IAM Identity Center can use
`aws configure sso --profile fieldmerge` instead.

The workflow uses short-lived GitHub OIDC credentials, not saved AWS access
keys. Your local AWS setup login and GitHub's deployment identity are separate.
See [AWS CLI browser login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html).

## 3. Create the AWS foundation

This is the first step that creates billable resources. Run from `D:\field-merge`:

```powershell
.\scripts\aws\bootstrap-foundation.ps1 `
  -GitHubRepository "irfanozer/field-merge" `
  -Region "us-east-1" `
  -Profile "fieldmerge" `
  -OriginDomain "origin-fieldmerge.irfanburakozer.com" `
  -ConfirmCosts
```

The stack is `fieldmerge-aws-prod`. Wait for provisioning to finish. The output
prints the server's `PublicIp` and generated `*.cloudfront.net` preview address.
The application is not deployed yet.

If provisioning fails, check **AWS Console > CloudFormation > fieldmerge-aws-prod
> Events**. Do not delete the stack or rotate secrets as a troubleshooting step.
Repeat runs preserve existing secrets, AMI, origin, certificate, and selected
parameters. Use one production stack for the `/fieldmerge/prod/*` secret names.

## 4. Add the origin DNS record

In Cloudflare, add the new record printed by bootstrap:

| Field | Value |
| --- | --- |
| Type | A |
| Name | `origin-fieldmerge` |
| IPv4 address | The bootstrap's `PublicIp` value |
| Proxy status | DNS only, gray cloud |
| TTL | Auto |

Do not change the existing `fieldmerge` record yet. Keep Azure serving the public
website during preparation. Do not create an AAAA record for the origin.

If your DNS zone has restrictive CAA records, allow `letsencrypt.org` for Caddy
and an [ACM-supported Amazon authority](https://docs.aws.amazon.com/acm/latest/userguide/troubleshooting-caa.html)
for the public certificate. The origin uses HTTPS and a secret header; port 443
accepts CloudFront sources only. Port 80 is for certificate validation. Opening
the origin directly in a browser is not a valid application health check.

## 5. Connect GitHub and deploy to the preview address

Once the origin DNS points directly to the printed IP:

```powershell
.\scripts\aws\configure-github-oidc.ps1 `
  -GitHubRepository "irfanozer/field-merge" `
  -Region "us-east-1" `
  -Profile "fieldmerge" `
  -EnableDeployment

gh workflow run deploy-aws.yml --repo irfanozer/field-merge --ref main
```

The setup creates or safely reuses the `aws-production` GitHub environment,
allows releases from `main`, and saves the non-secret AWS settings. Existing
environment protections are not silently removed. Azure's `production`
environment and variables are not changed.

Open **GitHub > irfanozer/field-merge > Actions > Deploy FieldMerge to AWS**.
The workflow checks successful CI and AWS asset validation for the exact commit,
waits for its public images, verifies image revision labels and immutable
digests, runs migrations, starts the server, publishes the frontend, and performs
the live synchronization test. Its **Summary** contains the preview URL.

AWS releases do not depend on the Azure deployment job succeeding. Keep the
existing image-publishing workflow enabled because both clouds use its images.

## 6. Test the AWS preview

Open the generated `https://...cloudfront.net` address. Run the guided demo,
reconnect both tablets, review the conflict, and save the final report. Confirm
live updates work and both tablets agree with the saved report.

Deployment verification checks the HTML, browser protections, readiness,
uncached API responses, an accepted operation, its PostgreSQL operation-log
entry, and the matching WebSocket update. A working page alone is not enough.

The AWS setup was prepared locally without provisioning a live FieldMerge AWS
stack. The first successful cloud workflow is the deployment acceptance check.

## 7. Request and bind the public certificate

```powershell
.\scripts\aws\request-domain-certificate.ps1 `
  -Domain "fieldmerge.irfanburakozer.com" `
  -Profile "fieldmerge"
```

Add the printed ACM validation CNAME in Cloudflare as **DNS only**. Its name
begins with an underscore. It is an additional record, not the `fieldmerge`
record. Keep it for certificate renewal.

In **AWS Certificate Manager**, choose **US East (N. Virginia), us-east-1** and
wait for **Issued**. Copy the certificate's **ARN**, not the CloudFront ID,
EC2 ID, or IAM role ARN. It has this shape:

```text
arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/CERTIFICATE_UUID
```

Bind that issued certificate:

```powershell
.\scripts\aws\enable-custom-domain.ps1 `
  -Domain "fieldmerge.irfanburakozer.com" `
  -CertificateArn "PASTE_YOUR_ISSUED_CERTIFICATE_ARN_HERE" `
  -Profile "fieldmerge"
```

Binding the certificate does not change Cloudflare DNS. FieldMerge also checks
the browser's WebSocket Origin, so deploy again **before switching DNS** to add
the custom hostname to the server's allowlist:

```powershell
gh workflow run deploy-aws.yml --repo irfanozer/field-merge --ref main
```

Wait for success, then run `enable-custom-domain.ps1` again with the same ARN.
Follow its verification result. Do not switch DNS while it reports that the
custom-domain WebSocket Origin is not ready.

## 8. Move the public address to AWS

Save the current Azure CNAME target for rollback. After the custom-domain
verification passes, disable automatic Azure releases before changing DNS:

```powershell
gh variable set AZURE_DEPLOYMENT_ENABLED --repo irfanozer/field-merge --body false
```

Wait for any already-running Azure deployment to finish. The existing Azure
workflow tests its configured public hostname and resets the fictional demo.
After cutover that hostname belongs to AWS, so leaving Azure releases enabled
could make the two workflows reset/test the same AWS demo concurrently. This
switch preserves image publishing and all Azure source files. It does not stop
or delete the still-running Azure resources.

Then change only this record in Cloudflare:

| Field | New value |
| --- | --- |
| Type | CNAME |
| Name | `fieldmerge` |
| Target | The generated `....cloudfront.net` hostname, without `https://` |
| Proxy status | DNS only, gray cloud |

Keep `origin-fieldmerge`, the ACM validation CNAME, and Azure verification
records. Open `https://fieldmerge.irfanburakozer.com` and repeat the guided demo.
After DNS propagation, explicitly request verification of the public hostname:

```powershell
gh workflow run deploy-aws.yml `
  --repo irfanozer/field-merge `
  --ref main `
  -f verify_custom_domain=true
```

This opt-in check also resets the fixed fictional inspection while testing it.
Do not enable it before cutover, while the public address still serves Azure.

AWS and Azure have separate databases. Switching DNS does not synchronize their
history. Existing browser-local edits may refer to the old server's state;
restart the fictional demo and reload the page after cutover.

Do not delete Azure resources until the AWS demo is verified and you decide
whether old Azure data or a running rollback target is needed. Keeping Azure
files in Git does not require paying for an Azure deployment indefinitely.

## Future changes and deployment switches

Push to `main` as usual. CI, image publishing, and the enabled AWS release run
automatically. A failed exact-commit check prevents AWS deployment.

| Repository variable | Meaning |
| --- | --- |
| `AWS_DEPLOYMENT_ENABLED=true` | Allow AWS application releases |
| `AWS_DEPLOYMENT_ENABLED=false` | Pause AWS releases, not AWS billing |
| `AZURE_DEPLOYMENT_ENABLED=true` | Keep the existing Azure release job enabled |
| `AZURE_DEPLOYMENT_ENABLED=false` | Skip Azure release but keep image publishing |

Keep Azure releases disabled after the public DNS switch, as described in step
8. If you later move back, first verify the Azure deployment at its original
Azure address, restore its DNS target, and then re-enable Azure releases. A
simultaneous automatic deployment to both clouds would need separate cloud-local
verification targets; this guide does not modify the Azure workflow.

Disabling releases does not delete resources or stop Azure hosting costs. None
of the AWS scripts changes the Azure setting for you.

## Backups, recovery, and maintenance

The data disk is identified by its exact EBS ID before mounting or formatting.
Unrecognized disks are not formatted. Containers depend on that disk being
mounted. Daily compressed PostgreSQL backups go to a private S3 bucket; the
default lifecycle is 14 days. A backup must succeed before a later migration.

Use **Systems Manager > Session Manager** to access the server, not SSH:

```bash
sudo docker ps
sudo systemctl status fieldmerge-backup.timer
sudo journalctl -u fieldmerge-backup.service --no-pager -n 50
sudo cat /srv/fieldmerge/last-backup.txt
sudo df -h / /srv/fieldmerge
```

Never print or share `/srv/fieldmerge/runtime.env`; it contains secrets. An
authorized operator can request a backup with:

```bash
sudo bash /opt/fieldmerge/current/scripts/aws/backup-database.sh
```

Backup archive validation is not a full restore drill. Restore a selected dump
to an isolated PostgreSQL 17 instance and test document reads, synchronization,
and conflicts before depending on recovery. The runtime role can upload backups
but cannot read or delete them. Use a separate authorized recovery identity.
Never test restore by overwriting the live database.

Migrations are not automatically reversed. A compatible forward release is the
normal recovery path; restoring an old database could discard newer edits.
Monitor free disk, CPU credits, failed requests, container restarts, and backup
success. Plan OS and container security updates. Retained image layers and old
assets need periodic review.

## Troubleshooting

- **AWS job skipped:** check `AWS_DEPLOYMENT_ENABLED` and run from `main`.
- **No successful exact-commit checks:** wait for CI and AWS deployment assets.
  A manual release does not bypass failed tests.
- **PowerShell native-command error:** use these updated AWS scripts together;
  they handle warning output and expected GitHub 404 responses on PowerShell
  5.1 and 7. Do not copy an older `common.ps1` over the new one.
- **Origin DNS rejected:** the `origin-fieldmerge` A record must point to this
  stack's public IP with proxy disabled. Wait for DNS propagation.
- **Image access denied:** make both FieldMerge GHCR packages public.
- **OIDC denied:** verify this repository, `aws-production`, the main-branch
  policy, and `sts.amazonaws.com` audience. Do not broaden the role to every repo.
- **502 or certificate error:** check the origin A record, CAA records, Caddy
  logs, and CloudFront's deployed status.
- **Page loads but live updates fail:** verify WebSocket Origin allowlisting,
  the post-certificate redeploy, and the complete smoke test. CloudFront must
  forward the WebSocket handshake headers and Origin. See
  [CloudFront WebSocket support](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html).
- **Server not online in Systems Manager:** check EC2 status, its role, outbound
  connectivity, and instance startup logs. Do not open SSH to the internet.
- **Migration or release failure:** use the workflow's Systems Manager command
  ID under **Run Command**. Do not reset the database or rotate its password.

The template enables termination protection and retains S3 buckets. Data-volume
deletion/replacement takes a snapshot. These protections can leave billable
resources after an intentional teardown and do not replace a recovery plan.
