Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Initialize-FieldMergeAws {
    param([string] $Region = "us-east-1", [string] $Profile = "")
    if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "Install AWS CLI v2 first." }
    if ($Region -ne "us-east-1") { throw "This deployment currently supports us-east-1, including its CloudFront certificate." }
    $script:AwsArguments = @("--region", $Region, "--no-cli-pager")
    if ($Profile) { $script:AwsArguments += @("--profile", $Profile) }
    $env:AWS_PAGER = ""
}

function Invoke-FieldMergeAws {
    param([Parameter(Mandatory)][string[]] $Arguments, [string] $MissingPattern = "")
    # Windows PowerShell 5.1 promotes redirected native stderr to ErrorRecords.
    # Capture it separately so Stop cannot preempt exit-code handling, and a
    # successful command's warnings cannot corrupt its JSON stdout.
    Get-Command aws -ErrorAction Stop | Out-Null
    $PSNativeCommandUseErrorActionPreference = $false
    $stderrPath = [IO.Path]::GetTempFileName()
    $callerErrorPreference = $ErrorActionPreference
    try {
        try {
            $ErrorActionPreference = "Continue"
            $result = & aws @script:AwsArguments @Arguments --output json 2> $stderrPath
            $exitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $callerErrorPreference }
        $stderrText = [IO.File]::ReadAllText($stderrPath).Trim()
    }
    finally {
        $ErrorActionPreference = $callerErrorPreference
        if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
    }
    $resultText = ($result | ForEach-Object { "$_" }) -join "`n"
    if ($exitCode -ne 0) {
        $diagnosticText = (@($stderrText, $resultText) | Where-Object { $_ }) -join "`n"
        # PowerShell 5.1 may wrap native ErrorRecord text across lines. Match
        # expected messages independent of wrapping, but retain full diagnostics.
        $matchingText = [regex]::Replace($diagnosticText, '\s+', ' ')
        if ($MissingPattern -and $matchingText -match $MissingPattern) { return $null }
        if (-not $diagnosticText) { $diagnosticText = "AWS CLI returned no diagnostic output." }
        # Do not include arguments: some commands handle confidential values.
        throw "AWS command failed ($($Arguments[0..1] -join ' '), exit $exitCode): $diagnosticText"
    }
    if ($stderrText) { Write-Warning $stderrText }
    if ($resultText.Trim()) { return $resultText | ConvertFrom-Json }
}

function Invoke-FieldMergeGitHub {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [string] $InputJson,
        [switch] $AllowNotFound
    )
    # A missing environment is expected on first setup. In Windows PowerShell
    # 5.1, merged native stderr would throw before we can inspect its exit code.
    Get-Command gh -ErrorAction Stop | Out-Null
    $PSNativeCommandUseErrorActionPreference = $false
    # Do not pipe JSON to native stdin: the runner's Windows PowerShell console
    # encoding can add a UTF-8 BOM even when OutputEncoding requests no BOM.
    # Keep the caller's --input - contract, but give gh an exact UTF-8 file.
    $stderrPath = [IO.Path]::GetTempFileName()
    $requestPath = $null
    $callerErrorPreference = $ErrorActionPreference
    try {
        $nativeArguments = @($Arguments)
        if ($PSBoundParameters.ContainsKey("InputJson")) {
            $inputIndexes = @(for ($index = 0; $index -lt $nativeArguments.Count; $index++) {
                if ($nativeArguments[$index] -eq "--input") { $index }
            })
            if ($inputIndexes.Count -ne 1 -or $inputIndexes[0] + 1 -ge $nativeArguments.Count -or
                $nativeArguments[$inputIndexes[0] + 1] -ne "-") {
                throw "InputJson requires exactly one --input - argument."
            }
            $requestPath = [IO.Path]::GetTempFileName()
            [IO.File]::WriteAllText($requestPath, $InputJson, [Text.UTF8Encoding]::new($false))
            $nativeArguments[$inputIndexes[0] + 1] = $requestPath
        }
        try {
            $ErrorActionPreference = "Continue"
            $result = & gh @nativeArguments 2> $stderrPath
            $exitCode = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $callerErrorPreference }
        $stderrText = [IO.File]::ReadAllText($stderrPath).Trim()
    }
    finally {
        $ErrorActionPreference = $callerErrorPreference
        if (Test-Path -LiteralPath $stderrPath) { Remove-Item -LiteralPath $stderrPath -Force }
        if ($requestPath -and (Test-Path -LiteralPath $requestPath)) { Remove-Item -LiteralPath $requestPath -Force }
    }
    $resultText = ($result | ForEach-Object { "$_" }) -join "`n"
    if ($exitCode -ne 0) {
        $diagnosticText = (@($stderrText, $resultText) | Where-Object { $_ }) -join "`n"
        $matchingText = [regex]::Replace($diagnosticText, '\s+', ' ')
        if ($AllowNotFound -and $matchingText -match '\bHTTP 404\b' -and
            $matchingText -notmatch '\bHTTP (?!404\b)\d{3}\b') { return $null }
        if (-not $diagnosticText) { $diagnosticText = "GitHub CLI returned no diagnostic output." }
        # Arguments or request bodies may contain configuration values.
        throw "GitHub command failed (exit $exitCode): $diagnosticText"
    }
    if ($stderrText) { Write-Warning $stderrText }
    return $resultText
}

function Invoke-FieldMergeAwsJson {
    param([string[]] $Arguments, [object] $Payload, [string] $MissingPattern = "")
    $requestPath = Join-Path ([IO.Path]::GetTempPath()) "fieldmerge-aws-$([Guid]::NewGuid().ToString('N')).json"
    try {
        [IO.File]::WriteAllText($requestPath, ($Payload | ConvertTo-Json -Depth 40), [Text.UTF8Encoding]::new($false))
        Invoke-FieldMergeAws -Arguments ($Arguments + @("--cli-input-json", "file://$requestPath")) -MissingPattern $MissingPattern
    }
    finally {
        if (Test-Path -LiteralPath $requestPath) { Remove-Item -LiteralPath $requestPath -Force }
    }
}

function Get-FieldMergeStack {
    param([string] $StackName)
    $result = Invoke-FieldMergeAws -Arguments @("cloudformation", "describe-stacks", "--stack-name", $StackName) -MissingPattern "does not exist"
    if ($null -eq $result) { return $null }
    return $result.Stacks[0]
}

function Get-FieldMergeOutputs {
    param([object] $Stack)
    $result = @{}
    foreach ($entry in $Stack.Outputs) { $result[$entry.OutputKey] = $entry.OutputValue }
    return $result
}

function Assert-FieldMergeStackOwnership {
    param(
        [Parameter(Mandatory)][object] $Stack,
        [string] $GitHubOwnerId = "",
        [string] $GitHubRepositoryId = ""
    )
    if ("Tags" -notin $Stack.PSObject.Properties.Name -or "Parameters" -notin $Stack.PSObject.Properties.Name) {
        throw "The existing stack has no verifiable FieldMerge ownership metadata. Use the separate fieldmerge-aws-prod stack."
    }
    $projectTags = @($Stack.Tags | Where-Object { $_.Key -ceq "Project" -and $_.Value -ceq "FieldMerge" })
    $parameters = @{}
    foreach ($entry in $Stack.Parameters) { $parameters[$entry.ParameterKey] = $entry.ParameterValue }
    if ($projectTags.Count -ne 1 -or $parameters["GitHubRepository"] -cne "irfanozer/field-merge" -or
        $parameters["GitHubOwnerId"] -notmatch '^[0-9]+$' -or $parameters["GitHubRepositoryId"] -notmatch '^[0-9]+$' -or
        ($GitHubOwnerId -and $parameters["GitHubOwnerId"] -ne $GitHubOwnerId) -or
        ($GitHubRepositoryId -and $parameters["GitHubRepositoryId"] -ne $GitHubRepositoryId)) {
        throw "Refusing to modify this stack: it is not tagged FieldMerge with the intended GitHub repository and immutable IDs. Use the separate fieldmerge-aws-prod stack."
    }
}

function Assert-FieldMergeDomain {
    param([string] $Domain)
    if ($Domain -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') {
        throw "Supply a lowercase DNS hostname without https://, a path, or a wildcard."
    }
}

function Wait-FieldMergeStack {
    param([string] $StackName, [bool] $Creating)
    $waiter = if ($Creating) { "stack-create-complete" } else { "stack-update-complete" }
    Write-Host "Waiting for AWS infrastructure. CloudFront can take 15 minutes or longer."
    Invoke-FieldMergeAws -Arguments @("cloudformation", "wait", $waiter, "--stack-name", $StackName) | Out-Null
}

function Assert-FieldMergeWebSocketOrigin {
    param(
        [Parameter(Mandatory)][uri] $StreamUri,
        [Parameter(Mandatory)][string] $Origin,
        [ValidateRange(1, 60)][int] $TimeoutSeconds = 20
    )
    # The deployment uses wss through the preview hostname, with the prospective
    # public Origin. Loopback ws is allowed only for offline fixture tests.
    $localWebSocket = $StreamUri.Scheme -eq "ws" -and $StreamUri.IsLoopback
    if (-not $StreamUri.IsAbsoluteUri -or ($StreamUri.Scheme -ne "wss" -and -not $localWebSocket) -or
        $StreamUri.UserInfo -or $StreamUri.Query -or $StreamUri.Fragment) {
        throw "Supply a secure WebSocket URI (or loopback ws for local testing)."
    }
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $deadline = [Threading.CancellationTokenSource]::new()
    $message = [IO.MemoryStream]::new()
    try {
        $socket.Options.SetRequestHeader("Origin", $Origin)
        # One deadline bounds the handshake AND the complete first message.
        $deadline.CancelAfter($TimeoutSeconds * 1000)
        [void] $socket.ConnectAsync($StreamUri, $deadline.Token).GetAwaiter().GetResult()
        $buffer = New-Object byte[] 8192
        do {
            $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $deadline.Token).GetAwaiter().GetResult()
            if ($received.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text) {
                throw "The stream closed or returned a non-text message before its document snapshot."
            }
            $message.Write($buffer, 0, $received.Count)
            if ($message.Length -gt 1048576) { throw "The initial document snapshot exceeded the 1 MiB verification limit." }
        } while (-not $received.EndOfMessage)
        $snapshot = [Text.Encoding]::UTF8.GetString($message.ToArray()) | ConvertFrom-Json
        if ($snapshot.type -ne "document.committed" -or $snapshot.document.document_id -ne "inspection-pump-07") {
            throw "The stream did not return the expected FieldMerge demo document."
        }
        # Reading this first snapshot does not send edits or reset demo data.
    }
    catch {
        throw "WebSocket verification failed for Origin ${Origin}: $($_.Exception.Message)"
    }
    finally {
        # Do not wait for an unresponsive peer to complete a close handshake.
        $socket.Abort()
        $socket.Dispose()
        $deadline.Dispose()
        $message.Dispose()
    }
}
