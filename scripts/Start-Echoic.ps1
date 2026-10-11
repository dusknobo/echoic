param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectDir 'backend'
$pythonExe = Join-Path $backendDir '.venv\Scripts\python.exe'
$runtimeDir = Join-Path $projectDir '.runtime'
$baseUrl = 'http://127.0.0.1:18765'
if (-not (Test-Path -LiteralPath $pythonExe)) { throw 'Backend not installed. See LOCAL_SETUP.md.' }
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
function Get-EchoicHealth([int]$TimeoutSeconds = 2) {
    # Loopback health must bypass system/environment proxies in PowerShell 5/7.
    $request = [System.Net.HttpWebRequest]::Create("$baseUrl/api/local/health")
    $request.Proxy = $null
    $request.Timeout = $TimeoutSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    $response = $null
    $reader = $null
    try {
        $response = $request.GetResponse()
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}
try { $health = Get-EchoicHealth 2 } catch { $health = $null }
if ($health.application -ne 'Echoic') {
    $server = Start-Process -FilePath $pythonExe -ArgumentList @('local_server.py', '--port', '18765') -WorkingDirectory $backendDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'server.out.log') -RedirectStandardError (Join-Path $runtimeDir 'server.err.log') -PassThru
    $processStartTimeUtc = $server.StartTime.ToUniversalTime().ToString('o')
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        Start-Sleep -Seconds 1
        if ($server.HasExited) { throw "Echoic exited. Read .runtime\server.err.log." }
        try { $health = Get-EchoicHealth 1 } catch { $health = $null }
        if ($health.application -eq 'Echoic') { break }
    }
    if ($health.application -ne 'Echoic') { throw "Server is starting slowly. Read .runtime\server.err.log." }
    @{ pid = $server.Id; url = $baseUrl; startedAt = $processStartTimeUtc; processStartTimeUtc = $processStartTimeUtc } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'server.json') -Encoding UTF8
}
Write-Host "Echoic is running at $baseUrl"
if (-not $NoBrowser) { Start-Process $baseUrl }
