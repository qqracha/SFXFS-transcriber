$ErrorActionPreference = 'SilentlyContinue'
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workDir = Join-Path $appRoot 'work'
$targets = @(
    @{ File = (Join-Path $workDir 'backend.pid'); Marker = 'server.app:app' },
    @{ File = (Join-Path $workDir 'frontend.pid'); Marker = 'run start' }
)

function Stop-OwnedProcessTree([int]$RootId) {
    $children = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $RootId }
    foreach ($child in $children) {
        Stop-OwnedProcessTree -RootId $child.ProcessId
    }
    Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue
}

foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target.File)) { continue }
    $processId = [int](Get-Content -LiteralPath $target.File -ErrorAction SilentlyContinue | Select-Object -First 1)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -like "*$($target.Marker)*") {
        Stop-OwnedProcessTree -RootId $processId
    }
    Remove-Item -LiteralPath $target.File -Force -ErrorAction SilentlyContinue
}

Write-Host 'SFXFS Transcriber остановлен.'
