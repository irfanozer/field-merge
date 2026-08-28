[CmdletBinding()]
param(
    [ValidateRange(1, 10000)]
    [int]$Requests = 200,

    [ValidateRange(0, 1000)]
    [int]$Warmup = 20,

    [string]$ApiBaseUrl = "http://127.0.0.1:8003"
)

$ErrorActionPreference = "Stop"
$documentId = "inspection-pump-07"
$api = $ApiBaseUrl.TrimEnd("/")
$syncUri = "$api/api/v1/documents/$documentId/sync"
$body = @{
    client_id = "local-benchmark"
    known_vector = @{}
    pending_operations = @()
} | ConvertTo-Json -Depth 8 -Compress

Invoke-RestMethod -Method Get -Uri "$api/health/ready" -TimeoutSec 10 | Out-Null

Write-Host "Warming up with $Warmup synchronization requests..."
for ($index = 0; $index -lt $Warmup; $index++) {
    Invoke-RestMethod -Method Post -Uri $syncUri -ContentType "application/json" -Body $body -TimeoutSec 15 | Out-Null
}

Write-Host "Measuring $Requests sequential synchronization requests..."
$samples = [System.Collections.Generic.List[double]]::new()
$total = [System.Diagnostics.Stopwatch]::StartNew()
for ($index = 0; $index -lt $Requests; $index++) {
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-RestMethod -Method Post -Uri $syncUri -ContentType "application/json" -Body $body -TimeoutSec 15 | Out-Null
    $timer.Stop()
    $samples.Add($timer.Elapsed.TotalMilliseconds)
}
$total.Stop()

$sorted = @($samples | Sort-Object)
function Get-Percentile {
    param(
        [double[]]$Values,
        [double]$Percentile
    )

    if ($Values.Count -eq 1) {
        return $Values[0]
    }

    $rank = [Math]::Ceiling(($Percentile / 100.0) * $Values.Count) - 1
    $index = [Math]::Max(0, [Math]::Min($Values.Count - 1, $rank))
    return $Values[$index]
}

$result = [ordered]@{
    measured_at_utc = (Get-Date).ToUniversalTime().ToString("o")
    api_base_url = $api
    document_id = $documentId
    warmup_requests = $Warmup
    measured_requests = $Requests
    elapsed_seconds = [Math]::Round($total.Elapsed.TotalSeconds, 3)
    requests_per_second = [Math]::Round($Requests / $total.Elapsed.TotalSeconds, 2)
    latency_ms = [ordered]@{
        minimum = [Math]::Round($sorted[0], 2)
        median = [Math]::Round((Get-Percentile -Values $sorted -Percentile 50), 2)
        p95 = [Math]::Round((Get-Percentile -Values $sorted -Percentile 95), 2)
        p99 = [Math]::Round((Get-Percentile -Values $sorted -Percentile 99), 2)
        maximum = [Math]::Round($sorted[-1], 2)
    }
    note = "Sequential local engineering sample; not a production capacity claim."
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resultsDirectory = Join-Path $projectRoot "benchmark-results"
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
$fileStamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$resultPath = Join-Path $resultsDirectory "sync-$fileStamp.json"
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding UTF8

Write-Host ""
$result | ConvertTo-Json -Depth 6
Write-Host ""
Write-Host "Saved $resultPath" -ForegroundColor Green
