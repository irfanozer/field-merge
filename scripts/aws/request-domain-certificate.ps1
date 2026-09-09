[CmdletBinding()]
param(
    [string] $Domain = "fieldmerge.irfanburakozer.com",
    [string] $Region = "us-east-1",
    [string] $Profile = "fieldmerge",
    [string] $CertificateArn = ""
)
. "$PSScriptRoot/common.ps1"
Assert-FieldMergeDomain $Domain
Initialize-FieldMergeAws -Region $Region -Profile $Profile
if (-not $CertificateArn) {
    $certificates = Invoke-FieldMergeAws -Arguments @("acm", "list-certificates", "--certificate-statuses", "ISSUED", "PENDING_VALIDATION")
    $matches = @($certificates.CertificateSummaryList | Where-Object DomainName -eq $Domain)
    if ($matches.Count -gt 1) { throw "Several matching certificates exist. Rerun with -CertificateArn to select one explicitly." }
    if ($matches.Count -eq 1) { $CertificateArn = $matches[0].CertificateArn }
    else {
        $requested = Invoke-FieldMergeAws -Arguments @("acm", "request-certificate", "--domain-name", $Domain, "--validation-method", "DNS", "--idempotency-token", "fieldmergeweb")
        $CertificateArn = $requested.CertificateArn
    }
}
if ($CertificateArn -notmatch '^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[a-f0-9-]+$') {
    throw "CloudFront requires an ACM certificate in us-east-1."
}
$records = @()
for ($attempt = 0; $attempt -lt 12; $attempt++) {
    $certificate = (Invoke-FieldMergeAws -Arguments @("acm", "describe-certificate", "--certificate-arn", $CertificateArn)).Certificate
    if ($Domain -notin $certificate.SubjectAlternativeNames) { throw "This certificate does not cover $Domain." }
    $records = @($certificate.DomainValidationOptions | Where-Object { $_.PSObject.Properties.Name -contains "ResourceRecord" } | ForEach-Object ResourceRecord)
    if ($records.Count -gt 0) { break }
    Start-Sleep -Seconds 5
}
Write-Host "Certificate ARN: $CertificateArn"
Write-Host "Status: $($certificate.Status)"
if ($records.Count -eq 0) { throw "DNS validation records are still being prepared. Rerun this command with -CertificateArn $CertificateArn." }
Write-Host "`nAdd these ADDITIONAL Cloudflare DNS records. Use DNS only (gray cloud)."
foreach ($record in $records) { Write-Host "$($record.Type)    $($record.Name)    $($record.Value)" }
Write-Host "Keep these records for automatic renewal. Do not change the live fieldmerge CNAME yet."
Write-Host "After ACM shows Issued, run scripts/aws/enable-custom-domain.ps1 with this CertificateArn."

