# Resets LM Studio to a clean state and optionally loads a model.
#
# Works around a known LM Studio/AMD-Vulkan bug where ejecting a model does
# not release VRAM (lmstudio-ai/lmstudio-bug-tracker#1618) — a full process
# kill + relaunch is currently the only reliable way to release it. Also
# explicitly cycles the API server layer, since a GUI relaunch alone has
# been observed to leave it in a stale state.
#
# Usage:
#   powershell -File lmstudio-reset.ps1 [-Model <model-key>]
#
# Exits non-zero on any failed stage so callers can detect failure.

param(
    [string]$Model = ""
)

$ErrorActionPreference = 'Stop'

$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$lmStudioExe = Join-Path $env:LOCALAPPDATA 'Programs\LM Studio\LM Studio.exe'
$apiBase = 'http://localhost:1234'

function Get-GpuDedicatedMb {
    try {
        $samples = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples |
            Where-Object { $_.CookedValue -gt 0 }
        return [math]::Round((($samples | Measure-Object -Property CookedValue -Sum).Sum) / 1MB, 1)
    } catch {
        return -1
    }
}

function Wait-ServerUp {
    param([int]$TimeoutSecs)
    $deadline = (Get-Date).AddSeconds($TimeoutSecs)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-RestMethod -Uri "$apiBase/v1/models" -TimeoutSec 3 -ErrorAction Stop | Out-Null
            return $true
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

if (-not (Test-Path $lmStudioExe)) {
    Write-Error "LM Studio.exe not found at $lmStudioExe"
    exit 1
}
if (-not (Test-Path $lms)) {
    Write-Error "lms.exe not found at $lms"
    exit 1
}

Write-Host "GPU dedicated memory before reset: $(Get-GpuDedicatedMb) MB"

Write-Host "Killing LM Studio..."
Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and (Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 500
}
if (Get-Process -Name 'LM Studio' -ErrorAction SilentlyContinue) {
    Write-Error "LM Studio process(es) still running 15s after Stop-Process."
    exit 1
}
Write-Host "GPU dedicated memory after kill: $(Get-GpuDedicatedMb) MB"

Write-Host "Relaunching LM Studio..."
# Hand the launch off to explorer.exe so LM Studio ends up outside this
# console's process tree/job object. Otherwise Windows Terminal kills the
# whole descendant tree (including LM Studio) when the pane/window closes.
Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$lmStudioExe`""

if (-not (Wait-ServerUp -TimeoutSecs 60)) {
    Write-Error "LM Studio server did not come back up within 60s of relaunch."
    exit 1
}
Write-Host "Server responding after relaunch."

Write-Host "Cycling the API server..."
& $lms server stop | Out-Null
Start-Sleep -Seconds 1
& $lms server start | Out-Null

if (-not (Wait-ServerUp -TimeoutSecs 30)) {
    Write-Error "API server did not come back up after explicit stop/start."
    exit 1
}
Write-Host "Server confirmed up after explicit restart."

if ($Model -ne "") {
    # AMDVLK has a known ~2GiB single-allocation ceiling (llama.cpp/ggml-org#15054).
    # At this model's required context length (32k) + GPU offload, load-time GPU
    # buffer allocation crashes the llama-server engine process (exitCode
    # 3221225477 / STATUS_ACCESS_VIOLATION) intermittently -- confirmed via Windows
    # Event Log to be a crash inside amdvlk64.dll itself (also reproduced by a
    # separate app, Ollama, hitting the same driver offset), not an LM Studio or
    # model bug. A crashed attempt fails fast (a few seconds) and a load that
    # succeeds is stable afterward, so retrying is the practical workaround.
    $maxLoadAttempts = 20
    $loadSucceeded = $false
    for ($attempt = 1; $attempt -le $maxLoadAttempts; $attempt++) {
        Write-Host "Loading model: $Model (attempt $attempt/$maxLoadAttempts)"
        & $lms load $Model -y --identifier $Model | ForEach-Object { Write-Host $_ }
        if ($LASTEXITCODE -eq 0) {
            $loadSucceeded = $true
            break
        }
        Write-Host "Load attempt $attempt failed (exit $LASTEXITCODE) -- likely the AMDVLK crash; retrying..."
        # A crashed attempt never produces a running instance to unload, so this
        # call itself errors ("Model Not Found") -- expected, swallow it. Under
        # $ErrorActionPreference = 'Stop', an unhandled native-command stderr
        # write here would otherwise abort the whole script.
        try { & $lms unload $Model 2>$null | Out-Null } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $loadSucceeded) {
        Write-Error "lms load failed after $maxLoadAttempts attempts."
        exit 1
    }

    $deadline = (Get-Date).AddSeconds(120)
    $loaded = $false
    while ((Get-Date) -lt $deadline) {
        $psOut = & $lms ps 2>$null
        $modelLine = $psOut | Where-Object { $_.Trim() -ne '' -and $_ -notmatch '^IDENTIFIER' } | Select-Object -First 1
        if ($modelLine -and $modelLine -match [regex]::Escape($Model)) {
            $loaded = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $loaded) {
        Write-Error "Model '$Model' did not show as loaded (via 'lms ps') within 120s."
        exit 1
    }
    Write-Host "Model loaded: $Model"
}

Write-Host "GPU dedicated memory final: $(Get-GpuDedicatedMb) MB"
Write-Host "Reset complete."
exit 0
