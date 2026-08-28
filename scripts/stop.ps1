[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$DeleteDatabase
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $projectRoot

try {
    if ($DeleteDatabase) {
        if ($PSCmdlet.ShouldProcess(
            "the fieldmerge-postgres-data Docker volume",
            "stop FieldMerge and permanently delete local database data"
        )) {
            docker compose down --volumes
        }
    }
    else {
        docker compose down
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose could not stop FieldMerge cleanly."
    }
}
finally {
    Pop-Location
}

