[CmdletBinding()]
param(
    [string]$ApiBaseUrl = "http://127.0.0.1:8003"
)

$ErrorActionPreference = "Stop"
$documentId = "inspection-pump-07"
$api = $ApiBaseUrl.TrimEnd("/")

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

Write-Host "1/5 Checking database-backed readiness..."
$ready = Invoke-RestMethod -Method Get -Uri "$api/health/ready" -TimeoutSec 10
Assert-True ($null -ne $ready) "The readiness endpoint returned no body."

Write-Host "2/5 Resetting only the fixed demonstration inspection..."
$reset = Invoke-RestMethod -Method Post -Uri "$api/api/v1/demo/reset" -TimeoutSec 15
Assert-True ($reset.document.document_id -eq $documentId) "The demo reset returned the wrong document."

Write-Host "3/5 Reading the authoritative PostgreSQL-backed state..."
$document = Invoke-RestMethod -Method Get -Uri "$api/api/v1/documents/$documentId" -TimeoutSec 10
Assert-True ($document.document_id -eq $documentId) "The document response has the wrong ID."
Assert-True (-not [string]::IsNullOrWhiteSpace([string]$document.state_digest)) "The document has no state digest."

Write-Host "4/5 Performing an idempotent incremental synchronization..."
$syncRequest = @{
    client_id = "smoke-check"
    known_vector = @{}
    pending_operations = @()
} | ConvertTo-Json -Depth 8
$sync = Invoke-RestMethod `
    -Method Post `
    -Uri "$api/api/v1/documents/$documentId/sync" `
    -ContentType "application/json" `
    -Body $syncRequest `
    -TimeoutSec 15
Assert-True ($sync.document_id -eq $documentId) "Synchronization returned the wrong document."
Assert-True ($sync.state_digest -eq $document.state_digest) "Read and sync endpoints disagree on the state digest."

Write-Host "5/5 Inspecting the persisted operation log..."
$log = Invoke-RestMethod -Method Get -Uri "$api/api/v1/documents/$documentId/operations" -TimeoutSec 10
$operations = if ($null -ne $log.operations) { @($log.operations) } elseif ($null -ne $log.items) { @($log.items) } else { @($log) }
Assert-True ($operations.Count -gt 0) "The demonstration operation log is empty."

Write-Host ""
Write-Host "Smoke test passed." -ForegroundColor Green
Write-Host "Document:        $documentId"
Write-Host "State digest:    $($sync.state_digest)"
Write-Host "Server sequence: $($sync.server_sequence)"
Write-Host "Log operations:  $($operations.Count)"
