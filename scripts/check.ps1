[CmdletBinding()]
param(
    [switch]$SkipFrontendInstall
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backendPython = Join-Path $projectRoot "backend\.venv\Scripts\python.exe"

function Assert-CommandSucceeded {
    param([string]$CommandLabel)

    if ($LASTEXITCODE -ne 0) {
        throw "$CommandLabel failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $backendPython)) {
    throw "backend\.venv is missing. Create it and run python -m pip install -e `".[dev]`" from the backend directory first."
}

Push-Location (Join-Path $projectRoot "backend")
try {
    & $backendPython -m ruff format --check . (Join-Path $projectRoot "scripts\smoke.py")
    Assert-CommandSucceeded "Backend formatting check"
    & $backendPython -m ruff check . (Join-Path $projectRoot "scripts\smoke.py")
    Assert-CommandSucceeded "Backend lint"
    & $backendPython -m mypy src
    Assert-CommandSucceeded "Backend type-check"
    & $backendPython -m pytest
    Assert-CommandSucceeded "Backend tests"
}
finally {
    Pop-Location
}

Push-Location (Join-Path $projectRoot "frontend")
try {
    if (-not $SkipFrontendInstall) {
        npm ci
        Assert-CommandSucceeded "Frontend dependency installation"
    }
    npm run lint
    Assert-CommandSucceeded "Frontend lint"
    npm run test
    Assert-CommandSucceeded "Frontend tests"
    npm run build
    Assert-CommandSucceeded "Frontend build"
}
finally {
    Pop-Location
}

Push-Location $projectRoot
try {
    docker compose config --quiet
    Assert-CommandSucceeded "Compose validation"
}
finally {
    Pop-Location
}

Write-Host "All local quality checks passed." -ForegroundColor Green
