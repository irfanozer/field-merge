[CmdletBinding()]
param(
    [ValidateSet("irfanozer/field-merge")][string] $GitHubRepository = "irfanozer/field-merge",
    [string] $Region = "us-east-1",
    [string] $Profile = "fieldmerge",
    [string] $StackName = "fieldmerge-aws-prod",
    [switch] $EnableDeployment
)
. "$PSScriptRoot/common.ps1"
Initialize-FieldMergeAws -Region $Region -Profile $Profile
$stack = Get-FieldMergeStack $StackName
if (-not $stack) { throw "Run the AWS foundation bootstrap first." }
Assert-FieldMergeStackOwnership -Stack $stack
$outputs = Get-FieldMergeOutputs $stack
$origin = $outputs.OriginDomainName
if ($EnableDeployment) {
    $addresses = [Net.Dns]::GetHostAddresses($origin) | ForEach-Object IPAddressToString
    if ($outputs.PublicIp -notin $addresses) { throw "$origin must resolve directly to $($outputs.PublicIp) before enabling deployment. Set its A record to DNS only." }
}
$repositoryJson = Invoke-FieldMergeGitHub -Arguments @("api", "repos/$GitHubRepository")
$repositoryDetails = $repositoryJson | ConvertFrom-Json
$repository = $repositoryDetails.full_name
Assert-FieldMergeStackOwnership -Stack $stack -GitHubOwnerId ([string] $repositoryDetails.owner.id) -GitHubRepositoryId ([string] $repositoryDetails.id)
$configuredRepository = ($stack.Parameters | Where-Object ParameterKey -eq "GitHubRepository").ParameterValue
if ($repository -cne $configuredRepository) { throw "Repository does not match the stack's exact GitHubRepository: $configuredRepository" }
$environmentJson = Invoke-FieldMergeGitHub -Arguments @("api", "repos/$repository/environments/aws-production") -AllowNotFound
if ($null -eq $environmentJson) {
    Write-Host "Creating the aws-production GitHub environment, restricted to main."
    $environmentBody = '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
    Invoke-FieldMergeGitHub -Arguments @("api", "--method", "PUT", "repos/$repository/environments/aws-production", "--input", "-") -InputJson $environmentBody | Out-Null
    Invoke-FieldMergeGitHub -Arguments @("api", "--method", "POST", "repos/$repository/environments/aws-production/deployment-branch-policies", "-f", "name=main", "-f", "type=branch") | Out-Null
}
else {
    $environment = ($environmentJson -join "`n") | ConvertFrom-Json
    if (-not $environment.deployment_branch_policy) {
        throw "In GitHub Settings > Environments > aws-production, restrict deployment branches to main. Existing environment protections are not overwritten."
    }
    if (-not $environment.deployment_branch_policy.custom_branch_policies) {
        throw "Set aws-production deployment branches to Selected branches and tags, allowing only the main branch."
    }
    $rulesJson = Invoke-FieldMergeGitHub -Arguments @("api", "repos/$repository/environments/aws-production/deployment-branch-policies")
    $rules = @(($rulesJson | ConvertFrom-Json).branch_policies)
    if ($rules.Count -ne 1 -or $rules[0].name -ne "main" -or $rules[0].type -ne "branch") {
        throw "The aws-production environment must allow only the main branch. Existing rules were preserved."
    }
}
$variables = @{
    AWS_REGION = $Region
    AWS_STACK_NAME = $StackName
    AWS_DEPLOYMENT_ROLE_ARN = $outputs.DeploymentRoleArn
}
foreach ($key in $variables.Keys) {
    Invoke-FieldMergeGitHub -Arguments @("variable", "set", $key, "--repo", $repository, "--body", $variables[$key]) | Out-Null
}
# Enable last, only after the branch restriction and all deployment settings
# have been configured successfully. An omitted switch leaves opt-in unchanged.
if ($EnableDeployment) {
    Invoke-FieldMergeGitHub -Arguments @("variable", "set", "AWS_DEPLOYMENT_ENABLED", "--repo", $repository, "--body", "true") | Out-Null
}
Write-Host "AWS deployment settings are ready. No permanent AWS access keys are stored in GitHub."
Write-Host "Azure files, variables, credentials, and deployment settings were not changed."
Write-Host "Run GitHub Actions > Deploy FieldMerge to AWS > Run workflow on main."
