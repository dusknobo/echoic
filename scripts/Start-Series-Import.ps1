param([string]$ManifestPath, [string]$CollectionName = 'A2英语听力51集')
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $projectDir 'backend\.venv\Scripts\python.exe'
if (-not $ManifestPath) {
    $ManifestPath = Join-Path (Split-Path -Parent $projectDir) 'A2英语听力51集\manifest.json'
}
$jobDir = Join-Path $projectDir '.runtime\imports'
New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
$processPath = Join-Path $jobDir 'BV1uD421p7UP-process.json'
if (Test-Path -LiteralPath $processPath) {
    $recorded = Get-Content -LiteralPath $processPath -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $recorded.pid -ErrorAction SilentlyContinue
    if ($existing -and $existing.Path -eq $pythonExe -and $existing.StartTime.ToUniversalTime().ToString('o') -eq $recorded.processStartTimeUtc) {
        Write-Host 'Series transcription is already running.'
        exit
    }
}
$scriptPath = Join-Path $PSScriptRoot 'import_local_series.py'
$arguments = @('-X', 'utf8', ('"{0}"' -f $scriptPath), '--manifest', ('"{0}"' -f $ManifestPath), '--collection', ('"{0}"' -f $CollectionName))
$process = Start-Process -FilePath $pythonExe -ArgumentList $arguments -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $jobDir 'BV1uD421p7UP.out.log') -RedirectStandardError (Join-Path $jobDir 'BV1uD421p7UP.err.log')
@{pid=$process.Id; processStartTimeUtc=$process.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $processPath -Encoding UTF8
Write-Host "Series transcription is running in the background. Progress: $jobDir\BV1uD421p7UP.json"
