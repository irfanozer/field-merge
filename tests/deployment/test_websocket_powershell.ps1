[CmdletBinding()]
param(
    [Alias("PythonExe")][Parameter(Mandatory)][string] $PythonExecutable,
    [string] $CommonScriptPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$fixturePython = (Resolve-Path -LiteralPath $PythonExecutable).Path
$fixtureServer = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "fixtures/websocket_server.py")).Path
$script:Passed = 0
$script:Failed = 0
if (-not $CommonScriptPath) {
    $CommonScriptPath = Join-Path $PSScriptRoot "../../scripts/aws/common.ps1"
}
# This suite loads helpers only; cloud commands must never be used.
function aws { throw "This WebSocket fixture must not invoke AWS." }
function gh { throw "This WebSocket fixture must not invoke GitHub." }
. $CommonScriptPath

function Assert-True {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw $Message }
}

function Invoke-TestCase {
    param([string] $Name, [scriptblock] $Body)
    try {
        & $Body
        $script:Passed++
        Write-Host "PASS $Name"
    }
    catch {
        $script:Failed++
        Write-Host "FAIL ${Name}: $($_.Exception.Message)"
    }
}

function Get-FixtureEvents {
    if (Test-Path -LiteralPath $script:FixtureLog) {
        Get-Content -LiteralPath $script:FixtureLog | ForEach-Object { $_ | ConvertFrom-Json }
    }
}

function Assert-ProbeFailure {
    param([string] $Path, [string] $Origin, [string] $MessagePattern, [int] $TimeoutSeconds = 3)
    $caught = $null
    try {
        Assert-FieldMergeWebSocketOrigin -StreamUri "$script:FixtureBase$Path" -Origin $Origin -TimeoutSeconds $TimeoutSeconds
    }
    catch { $caught = $_ }
    Assert-True ($null -ne $caught) "The invalid or stalled stream was accepted: $Path"
    Assert-True ($caught.Exception.Message -match $MessagePattern) "Unexpected error for ${Path}: $($caught.Exception.Message)"
}

$fixtureDirectory = Join-Path ([IO.Path]::GetTempPath()) "fieldmerge websocket fixture $([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
$readyFile = Join-Path $fixtureDirectory "ready.json"
$script:FixtureLog = Join-Path $fixtureDirectory "events.jsonl"
$fixtureProcess = $null
$previewOrigin = "https://preview.fieldmerge.invalid"
$customOrigin = "https://fieldmerge.example.invalid"

try {
    # ProcessStartInfo works in Windows PowerShell 5.1 and PowerShell 7 on both
    # operating systems; CreateNoWindow keeps this local helper invisible.
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $fixturePython
    $startInfo.Arguments = '"' + $fixtureServer + '" --ready-file "' + $readyFile + '" --log-file "' + $script:FixtureLog + '"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $fixtureProcess = [Diagnostics.Process]::Start($startInfo)
    $startupDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $readyFile)) {
        if ($fixtureProcess.HasExited) {
            throw "Loopback fixture failed to start: $($fixtureProcess.StandardError.ReadToEnd())"
        }
        if ([DateTime]::UtcNow -ge $startupDeadline) { throw "Loopback fixture did not become ready within 10 seconds." }
        Start-Sleep -Milliseconds 50
    }
    $ready = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
    Assert-True ($ready.port -gt 0 -and $ready.port -le 65535) "Invalid loopback fixture port."
    $script:FixtureBase = "ws://127.0.0.1:$($ready.port)"
    Write-Host "Real local .NET WebSocket regression tests: PowerShell $($PSVersionTable.PSVersion)"

    Invoke-TestCase "Preview Origin receives the expected initial document" {
        $output = Assert-FieldMergeWebSocketOrigin -StreamUri "$script:FixtureBase/preview" -Origin $previewOrigin -TimeoutSeconds 3
        Assert-True ($null -eq $output) "The assertion helper leaked a snapshot to its caller."
        $requests = @(Get-FixtureEvents | Where-Object { $_.event -eq "request" -and $_.path -eq "/preview" })
        Assert-True ($requests.Count -eq 1 -and $requests[0].origin -ceq $previewOrigin) "The preview Origin header was not sent exactly."
    }

    Invoke-TestCase "Prospective custom Origin is forwarded and accepted" {
        Assert-FieldMergeWebSocketOrigin -StreamUri "$script:FixtureBase/custom" -Origin $customOrigin -TimeoutSeconds 3
        $requests = @(Get-FixtureEvents | Where-Object { $_.event -eq "request" -and $_.path -eq "/custom" })
        Assert-True ($requests.Count -eq 1 -and $requests[0].origin -ceq $customOrigin) "The custom Origin header was not sent exactly."
    }

    Invoke-TestCase "Fragmented snapshot larger than one receive buffer succeeds" {
        Assert-FieldMergeWebSocketOrigin -StreamUri "$script:FixtureBase/fragmented" -Origin $customOrigin -TimeoutSeconds 3
    }

    Invoke-TestCase "Unapproved Origin is rejected by a real HTTP 403 handshake" {
        Assert-ProbeFailure -Path "/denied" -Origin "https://untrusted.invalid" -MessagePattern "WebSocket verification failed"
        $responses = @(Get-FixtureEvents | Where-Object { $_.event -eq "response" -and $_.path -eq "/denied" })
        Assert-True ($responses.Count -eq 1 -and $responses[0].status -eq 403) "Origin rejection was not an actual server-side HTTP 403."
        Assert-True (@(Get-FixtureEvents | Where-Object { $_.event -eq "connected" -and $_.path -eq "/denied" }).Count -eq 0) "The rejected Origin reached the stream handler."
    }

    Invoke-TestCase "Wrong document is rejected" {
        Assert-ProbeFailure -Path "/wrong-document" -Origin $customOrigin -MessagePattern "expected FieldMerge demo document"
    }

    Invoke-TestCase "Wrong event type is rejected" {
        Assert-ProbeFailure -Path "/wrong-event" -Origin $customOrigin -MessagePattern "expected FieldMerge demo document"
    }

    Invoke-TestCase "Binary first message is rejected" {
        Assert-ProbeFailure -Path "/binary" -Origin $customOrigin -MessagePattern "non-text message"
    }

    Invoke-TestCase "Close before the snapshot is rejected" {
        Assert-ProbeFailure -Path "/early-close" -Origin $customOrigin -MessagePattern "stream closed"
    }

    Invoke-TestCase "First-message deadline is bounded" {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        Assert-ProbeFailure -Path "/message-timeout" -Origin $customOrigin -MessagePattern "WebSocket verification failed" -TimeoutSeconds 1
        $timer.Stop()
        Assert-True ($timer.Elapsed.TotalSeconds -ge 0.5 -and $timer.Elapsed.TotalSeconds -lt 5) "The 1-second receive deadline took $($timer.Elapsed.TotalSeconds) seconds."
        Assert-True (@(Get-FixtureEvents | Where-Object { $_.event -eq "connected" -and $_.path -eq "/message-timeout" }).Count -eq 1) "The timeout happened before the successful handshake."
    }

    Invoke-TestCase "Handshake deadline is bounded" {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        Assert-ProbeFailure -Path "/handshake-timeout" -Origin $customOrigin -MessagePattern "WebSocket verification failed" -TimeoutSeconds 1
        $timer.Stop()
        Assert-True ($timer.Elapsed.TotalSeconds -ge 0.5 -and $timer.Elapsed.TotalSeconds -lt 5) "The 1-second handshake deadline took $($timer.Elapsed.TotalSeconds) seconds."
    }

    Invoke-TestCase "Failure cleanup allows the next valid handshake" {
        Assert-FieldMergeWebSocketOrigin -StreamUri "$script:FixtureBase/after-failure" -Origin $customOrigin -TimeoutSeconds 3
    }

    Invoke-TestCase "Verification sent no client data or demo edits" {
        Start-Sleep -Milliseconds 100
        $events = @(Get-FixtureEvents)
        Assert-True (@($events | Where-Object event -eq "unexpected-client-message").Count -eq 0) "The verification sent application messages."
        $closedStreams = @($events | Where-Object event -eq "closed")
        Assert-True ($closedStreams.Count -ge 9) "Expected completed stream observations were missing."
        Assert-True (@($closedStreams | Where-Object client_messages -ne 0).Count -eq 0) "The verification changed stream data."
    }
}
finally {
    if ($null -ne $fixtureProcess) {
        if (-not $fixtureProcess.HasExited) {
            $fixtureProcess.Kill()
            [void] $fixtureProcess.WaitForExit(5000)
        }
        $fixtureProcess.Dispose()
    }
    # Delete only this test's own validated temporary directory.
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureDirectory)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -notlike "fieldmerge websocket fixture *") {
        throw "Refusing to clean an unexpected WebSocket fixture directory."
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}

Write-Host "Passed: $script:Passed. Failed: $script:Failed."
if ($script:Failed -gt 0) { exit 1 }
# Report the test result explicitly instead of an inherited native exit code.
exit 0
