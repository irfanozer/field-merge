[CmdletBinding()]
param(
    [switch]$NoBuild,
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $projectRoot

try {
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
        Write-Host "Created .env from the safe local defaults."
    }

    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is not reachable. Start Docker Desktop and wait until its Linux engine is running."
    }

    $arguments = @("compose", "up", "--detach")
    if (-not $NoBuild) {
        $arguments += "--build"
    }
    & docker @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose could not start FieldMerge."
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $readyUri = "http://127.0.0.1:8003/health/ready"
    $ready = $false

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $readyUri -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        }
        catch {
            Start-Sleep -Seconds 2
        }
    }

    if (-not $ready) {
        docker compose ps
        docker compose logs --tail 80 backend
        throw "FieldMerge did not become ready within $TimeoutSeconds seconds."
    }

    docker compose ps
    Write-Host ""
    Write-Host "FieldMerge is ready." -ForegroundColor Green
    Write-Host "Demo:     http://localhost:3002"
    Write-Host "API docs: http://localhost:8003/docs"
    Write-Host ""
    Write-Host "Run .\scripts\smoke.ps1 to verify the persisted request path."
}
finally {
    Pop-Location
}
