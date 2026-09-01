$ErrorActionPreference = 'Stop'

$appRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workDir = Join-Path $appRoot 'work'
$venvDir = Join-Path $appRoot '.venv'
$venvPython = Join-Path $venvDir 'Scripts\python.exe'
$launcherLog = Join-Path $workDir 'launcher.log'
$backendOut = Join-Path $workDir 'backend.stdout.log'
$backendErr = Join-Path $workDir 'backend.stderr.log'
$frontendOut = Join-Path $workDir 'frontend.stdout.log'
$frontendErr = Join-Path $workDir 'frontend.stderr.log'
$backendPidFile = Join-Path $workDir 'backend.pid'
$frontendPidFile = Join-Path $workDir 'frontend.pid'

New-Item -ItemType Directory -Path $workDir -Force | Out-Null
Start-Transcript -LiteralPath $launcherLog -Append | Out-Null

try {
    Write-Host 'SFXFS Transcriber' -ForegroundColor Black -BackgroundColor White
    Write-Host 'Проверяю локальное окружение...'

    if (-not (Test-Path -LiteralPath $venvPython)) {
        python -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать Python-окружение.' }
    }

    & $venvPython -c 'import fastapi, faster_whisper, multipart, uvicorn' 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Первый запуск: устанавливаю движок распознавания...'
        & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $appRoot 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить Python-зависимости. Проверьте интернет.' }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules'))) {
        Write-Host 'Первый запуск: устанавливаю интерфейс...'
        & npm.cmd install --no-audit --no-fund --prefix $appRoot
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости интерфейса.' }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'dist\server\wrangler.json'))) {
        Write-Host 'Собираю интерфейс...'
        Push-Location $appRoot
        try { & npm.cmd run build } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать интерфейс.' }
    }

    $localModels = Join-Path $appRoot 'models'
    $postalModels = Join-Path $env:USERPROFILE 'Documents\Codex\2026-08-28\postal-2-npc-sfx-mp3\outputs\Postal2_RU_Transcriber\models'
    $localSnapshot = Join-Path $localModels 'models--Systran--faster-whisper-small\snapshots'
    $postalSnapshot = Join-Path $postalModels 'models--Systran--faster-whisper-small\snapshots'
    if (Test-Path -LiteralPath $localSnapshot) {
        $modelDir = $localModels
    } elseif (Test-Path -LiteralPath $postalSnapshot) {
        $modelDir = $postalModels
        Write-Host 'Использую уже скачанную модель из проекта Postal 2.'
    } else {
        $modelDir = $localModels
        Write-Host 'Модель small будет скачана при первой транскрибации.'
    }

    $env:TRANSCRIBER_APP_DIR = $appRoot
    $env:TRANSCRIBER_MODEL_DIR = $modelDir
    $env:HF_HUB_DISABLE_XET = '1'
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'

    $backendReady = $false
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health' -TimeoutSec 2
        $backendReady = [bool]$health.ok
    } catch {}
    if (-not $backendReady) {
        $backendProcess = Start-Process -FilePath $venvPython -ArgumentList @('-m','uvicorn','server.app:app','--host','127.0.0.1','--port','8765') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr -PassThru
        Set-Content -LiteralPath $backendPidFile -Value $backendProcess.Id -Encoding ascii
    }

    $frontendReady = $false
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4173/' -UseBasicParsing -TimeoutSec 2
        $frontendReady = $response.StatusCode -eq 200
    } catch {}
    if (-not $frontendReady) {
        $frontendProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','start','--','--port','4173') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr -PassThru
        Set-Content -LiteralPath $frontendPidFile -Value $frontendProcess.Id -Encoding ascii
    }

    Write-Host 'Запускаю приложение' -NoNewline
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $backendReady = $false
        $frontendReady = $false
        try { $backendReady = [bool](Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health' -TimeoutSec 2).ok } catch {}
        try { $frontendReady = (Invoke-WebRequest -Uri 'http://127.0.0.1:4173/' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
        if ($backendReady -and $frontendReady) { break }
        Write-Host '.' -NoNewline
        Start-Sleep -Milliseconds 500
    }
    Write-Host ''
    if (-not $backendReady) { throw 'Локальный движок не запустился. Смотрите work\backend.stderr.log.' }
    if (-not $frontendReady) { throw 'Интерфейс не запустился. Смотрите work\frontend.stderr.log.' }

    Start-Process 'http://127.0.0.1:4173/'
    Write-Host 'Готово. Приложение открыто в браузере.' -ForegroundColor Green
    Write-Host 'Для остановки используйте STOP_APP.cmd.'
}
finally {
    Stop-Transcript | Out-Null
}
