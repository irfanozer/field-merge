[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $CertificateArn,
    [string] $Domain = "fieldmerge.irfanburakozer.com",
    [string] $Region = "us-east-1",
    [string] $Profile = "fieldmerge",
    [string] $StackName = "fieldmerge-aws-prod"
)
. "$PSScriptRoot/common.ps1"
Assert-FieldMergeDomain $Domain
Initialize-FieldMergeAws -Region $Region -Profile $Profile
$account = Invoke-FieldMergeAws -Arguments @("sts", "get-caller-identity")
if ($CertificateArn -notmatch "^arn:aws:acm:us-east-1:$($account.Account):certificate/[a-f0-9-]+$") {
    throw "Supply a certificate from this AWS account in us-east-1."
}
$certificate = (Invoke-FieldMergeAws -Arguments @("acm", "describe-certificate", "--certificate-arn", $CertificateArn)).Certificate
if ($certificate.Status -ne "ISSUED" -or $Domain -notin $certificate.SubjectAlternativeNames) {
    throw "The certificate must be ISSUED and explicitly cover $Domain. Add ACM's validation CNAME in Cloudflare first."
}
$stack = Get-FieldMergeStack $StackName
if (-not $stack -or $stack.StackStatus -notin @("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE")) {
    throw "The AWS foundation must be deployed and not updating."
}
Assert-FieldMergeStackOwnership -Stack $stack
$outputs = Get-FieldMergeOutputs $stack
if ($Domain -eq $outputs.OriginDomainName) {
    throw "The public hostname must differ from the direct EC2 origin hostname. Keep the origin A record pointing to EC2."
}
$previousDomain = ($stack.Parameters | Where-Object ParameterKey -eq "WebCustomDomain").ParameterValue
$domainChanged = $previousDomain -cne $Domain
Write-Host "Verifying the AWS preview without changing demo data..."
$previewOrigin = "https://$($outputs.DistributionDomainName)"
$page = Invoke-WebRequest -Uri "$previewOrigin/" -UseBasicParsing -TimeoutSec 20
if ($page.StatusCode -ne 200 -or $page.Content -notmatch "FieldMerge" -or
    $page.Headers["Content-Security-Policy"] -notmatch "wss:") {
    throw "Deploy and verify the FieldMerge AWS preview, including its secure WebSocket CSP, before binding a public hostname."
}
$ready = Invoke-WebRequest -Uri "$previewOrigin/health/ready" -UseBasicParsing -TimeoutSec 20
if ($ready.StatusCode -ne 200 -or $ready.Headers["Content-Type"] -notmatch "application/json") {
    throw "The AWS API is not ready. Complete the first AWS deployment before binding a public hostname."
}
$null = $ready.Content | ConvertFrom-Json
$streamUri = [uri] "wss://$($outputs.DistributionDomainName)/api/v1/documents/inspection-pump-07/stream"
Assert-FieldMergeWebSocketOrigin -StreamUri $streamUri -Origin $previewOrigin

# Use the deployed template and preserve every unrelated parameter, including
# the AMI, origin token, and any previously configured retention settings.
$parameters = @($stack.Parameters | ForEach-Object {
    if ($_.ParameterKey -eq "WebCustomDomain") { @{ ParameterKey = $_.ParameterKey; ParameterValue = $Domain } }
    elseif ($_.ParameterKey -eq "WebCertificateArn") { @{ ParameterKey = $_.ParameterKey; ParameterValue = $CertificateArn } }
    else { @{ ParameterKey = $_.ParameterKey; UsePreviousValue = $true } }
})
$updated = Invoke-FieldMergeAwsJson -Arguments @("cloudformation", "update-stack") -Payload @{
    StackName = $StackName; UsePreviousTemplate = $true; Parameters = $parameters
    Capabilities = @("CAPABILITY_NAMED_IAM")
} -MissingPattern "No updates are to be performed"
if ($updated) { Wait-FieldMergeStack -StackName $StackName -Creating $false }
$outputs = Get-FieldMergeOutputs (Get-FieldMergeStack $StackName)
Write-Host "`nThe certificate is bound to CloudFront. Public DNS has NOT been changed."
# The first binding is intentionally a two-step operation: CI reads the new
# alias and refreshes the runtime allowlist. This is an expected next step, not
# a failed deployment. Never print cutover guidance before that deployment.
if ($domainChanged) {
    Write-Host "Next, refresh FieldMerge's allowed WebSocket origins with this deployment:"
    Write-Host "gh workflow run deploy-aws.yml --repo irfanozer/field-merge --ref main"
    Write-Host "Wait for that workflow to finish successfully, then rerun this same enable-custom-domain command."
    Write-Host "Keep the public DNS record unchanged until the rerun verifies the new Origin."
    return
}
# FieldMerge checks WebSocket Origin even for same-origin clients. Binding a
# CloudFront alias alone cannot update the running application's allowlist.
# Verify the future Origin through the existing preview address BEFORE telling
# the operator to change DNS. Re-running this script after deployment is safe.
try {
    $streamUri = [uri] "wss://$($outputs.DistributionDomainName)/api/v1/documents/inspection-pump-07/stream"
    Assert-FieldMergeWebSocketOrigin -StreamUri $streamUri -Origin "https://$Domain"
}
catch {
    throw "The certificate is bound, but the custom-domain WebSocket check did not pass. Keep public DNS unchanged. Run GitHub Actions > Deploy FieldMerge to AWS on main to refresh allowed origins, then rerun this script. If deployment already ran, investigate the preview stream. Details: $($_.Exception.Message)"
}
Write-Host "When you are ready, change only this Cloudflare record (DNS only, gray cloud):"
Write-Host "CNAME    $Domain    $($outputs.DistributionDomainName)"
Write-Host "Keep the origin A record and ACM validation CNAME records. Azure resources remain intact."
Write-Host "Then run the public verification from docs/AWS_DEPLOYMENT.md against https://$Domain."
