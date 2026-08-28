[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $SubscriptionId,

    [string] $ResourceGroup = "rg-fieldmerge-prod",

    [Parameter(Mandatory)]
    [ValidateSet("DELETE-FIELDMERGE-PRODUCTION")]
    [string] $Confirmation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $true
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is not installed or is not on PATH."
}

az account set --subscription $SubscriptionId
$resourceId = az group show --name $ResourceGroup --query id --output tsv --only-show-errors
if (-not $resourceId) {
    throw "Resource group '$ResourceGroup' was not found."
}

Write-Host "Deleting $ResourceGroup and every Azure resource inside it ..."
az group delete --name $ResourceGroup --yes --no-wait --only-show-errors
Write-Host "Deletion was accepted by Azure. Billing stops only after the resources finish deleting."
