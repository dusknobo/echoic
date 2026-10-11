$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $projectDir '.runtime\server.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No recorded Echoic server.'; exit }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$serverProcess = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
$expectedExe = Join-Path $projectDir 'backend\.venv\Scripts\python.exe'
if ($serverProcess) {
    $recordedStartTime = [DateTimeOffset]::MinValue
    # PowerShell 7 parses JSON ISO dates into DateTime automatically. Casting
    # those to string drops fractional seconds; keep the original ticks.
    if ($state.processStartTimeUtc -is [DateTimeOffset]) {
        $recordedStartTime = $state.processStartTimeUtc
        $validStartTime = $true
    } elseif ($state.processStartTimeUtc -is [DateTime]) {
        $recordedStartTime = [DateTimeOffset]$state.processStartTimeUtc
        $validStartTime = $true
    } else {
        $validStartTime = $state.processStartTimeUtc -and [DateTimeOffset]::TryParse(
            [string]$state.processStartTimeUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$recordedStartTime
        )
    }
    if (-not $validStartTime) {
        throw 'No verified process start time was recorded. Refusing to stop a possibly reused PID.'
    }
    $sameStartTime = $serverProcess.StartTime.ToUniversalTime().Ticks -eq $recordedStartTime.UtcDateTime.Ticks
    if ($serverProcess.Path -ne $expectedExe -or -not $sameStartTime) {
        throw 'Process identity changed. Refusing to stop an unrelated process.'
    }
    # Windows venv Python can launch the base interpreter as a child. Stop
    # only a listener verified to belong to this recorded Echoic launcher.
    $serverPort = ([Uri]$state.url).Port
    $venvConfigPath = Join-Path $projectDir 'backend\.venv\pyvenv.cfg'
    $baseHomeLine = Get-Content -LiteralPath $venvConfigPath | Where-Object { $_ -match '^home\s*=' } | Select-Object -First 1
    if (-not $baseHomeLine) { throw 'Cannot verify the base Python interpreter.' }
    $expectedChildExe = Join-Path ($baseHomeLine -replace '^home\s*=\s*', '') 'python.exe'
    $listeners = @(Get-NetTCPConnection -LocalPort $serverPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -eq $serverProcess.Id) { continue }
        $childInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listener.OwningProcess)
        $childProcess = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        $expectedCommand = '(?i)(?:^|\s)local_server\.py\s+--port\s+' + $serverPort + '(?:\s|$)'
        if (-not $childProcess -or $childInfo.ParentProcessId -ne $serverProcess.Id -or
            $childProcess.Path -ne $expectedChildExe -or
            $childInfo.CommandLine -notmatch $expectedCommand -or
            $childProcess.StartTime.ToUniversalTime() -lt $serverProcess.StartTime.ToUniversalTime()) {
            throw 'Port listener does not belong to the verified Echoic process. Refusing to stop it.'
        }
        $childStartTicks = $childProcess.StartTime.ToUniversalTime().Ticks
        $confirmedChild = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        if (-not $confirmedChild -or $confirmedChild.Path -ne $expectedChildExe -or
            $confirmedChild.StartTime.ToUniversalTime().Ticks -ne $childStartTicks) {
            throw 'Listener identity changed. Refusing to stop it.'
        }
        Stop-Process -InputObject $confirmedChild
    }
    $remainingLauncher = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($remainingLauncher) {
        if ($remainingLauncher.Path -ne $expectedExe -or
            $remainingLauncher.StartTime.ToUniversalTime().Ticks -ne $recordedStartTime.UtcDateTime.Ticks) {
            throw 'Launcher identity changed. Refusing to stop it.'
        }
        Stop-Process -InputObject $remainingLauncher
    }
    Write-Host 'Echoic stopped.'
} else {
    $serverPort = ([Uri]$state.url).Port
    if (Get-NetTCPConnection -LocalPort $serverPort -State Listen -ErrorAction SilentlyContinue) {
        throw 'The recorded launcher is gone but a listener remains. Cannot verify it; state was preserved.'
    }
    Write-Host 'Echoic was already stopped.'
}
Remove-Item -LiteralPath $statePath
