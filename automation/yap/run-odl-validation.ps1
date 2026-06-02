# run-odl-validation.ps1
# Cleanup + run multipli di validazione ODL, safe-by-default.
#
# Uso:
#   cd C:\Users\Anas\giorgio\automation\yap
#   .\run-odl-validation.ps1

[CmdletBinding()]
param(
    [string]$TestDate = '2026-12-27',
    [string]$TestTime = '07:00',
    [string]$TestSearch = 'ZZ555ZZ',
    [string]$PayloadFile = 'test-real-vehicle-payload.json',
    [string]$TestCustomerMarker = 'TEST AUTOMAZIONE',
    [int]$RunCount = 2,
    [int]$PauseSeconds = 20
)

$YAP_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$RESULTS = Join-Path $YAP_DIR "analysis\odl-test-results"
New-Item -ItemType Directory -Force -Path $RESULTS | Out-Null

function Use-FallbackEnvValue {
    param(
        [string]$Name,
        [string]$Fallback,
        [switch]$Sensitive
    )
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
        [Environment]::SetEnvironmentVariable($Name, $Fallback)
        $label = if ($Sensitive) { '[local-only debug fallback]' } else { '[local fallback]' }
        Write-Host "  $label $Name non impostata, uso fallback locale." -ForegroundColor DarkYellow
    }
}

function Get-TrailingJsonBlock {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    for ($i = $Text.Length - 1; $i -ge 0; $i--) {
        if ($Text[$i] -ne '{') { continue }
        $candidate = $Text.Substring($i).Trim()
        if (-not $candidate) { continue }
        try {
            $null = $candidate | ConvertFrom-Json -ErrorAction Stop
            return $candidate
        } catch {
        }
    }
    return $null
}

function Invoke-OdlRun {
    param([int]$RunIndex)
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $payloadPath = if ([System.IO.Path]::IsPathRooted($PayloadFile)) { $PayloadFile } else { Join-Path $YAP_DIR $PayloadFile }
    $logFile = Join-Path $RESULTS "val-run$RunIndex-$ts.log"

    Write-Host ''
    Write-Host ("  [Run $RunIndex] avvio worker...") -ForegroundColor Cyan
    Push-Location $YAP_DIR
    $raw = node yap-worker.mjs --payload-file $payloadPath --date $TestDate --time $TestTime --commit --debug 2>&1
    Pop-Location
    $raw | Out-File $logFile -Encoding UTF8

    $jsonText = Get-TrailingJsonBlock -Text ($raw -join "`n")
    if (-not $jsonText) {
        Write-Host ("  [Run $RunIndex] ERRORE: nessun JSON valido nell output.") -ForegroundColor Red
        return $null
    }

    try {
        $res = $jsonText | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Host ("  [Run $RunIndex] ERRORE parsing JSON: " + $_) -ForegroundColor Red
        $raw | Select-Object -Last 10 | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
        return $null
    }

    $wr = $res.result.write_report
    if (-not $res.ok) {
        Write-Host ("  [Run $RunIndex] ok=false") -ForegroundColor Yellow
        Write-Host ("    saved             : " + $res.result.saved) -ForegroundColor Yellow
        Write-Host ("    openedPractice    : " + $wr.openedPractice) -ForegroundColor Yellow
        Write-Host ("    odlRouteEffective : " + $wr.odlRouteEffective) -ForegroundColor Yellow
        Write-Host ("    openedOdl         : " + $wr.openedOdl) -ForegroundColor Yellow
        Write-Host ("    workspaceState    : " + $wr.workspaceState) -ForegroundColor Yellow
        Write-Host ("    reason            : " + $wr.reason) -ForegroundColor Yellow
        Write-Host ("    odl.error         : " + $wr.odl.error) -ForegroundColor Yellow
    }

    return [PSCustomObject]@{
        RunIndex          = $RunIndex
        Ok                = $res.ok
        Saved             = $res.result.saved
        OpenedPractice    = $wr.openedPractice
        OdlRouteEffective = $wr.odlRouteEffective
        OpenedOdl         = $wr.openedOdl
        WorkspaceState    = $wr.workspaceState
        VerifyMatched     = $wr.verify.matched
        VerifyTotal       = $wr.verify.total
        VerifyRatio       = $wr.verify.ratio
        OdlError          = $wr.odl.error
        LogFile           = $logFile
    }
}

function Invoke-Cleanup {
    param([string]$Label = '')
    Write-Host ''
    if ($Label) { Write-Host ("  [Cleanup $Label]") -ForegroundColor DarkGray }
    Push-Location $YAP_DIR
    $out = node yap-delete-appointment.mjs --date $TestDate --search $TestSearch 2>&1
    Pop-Location
    $txt = ($out -join ' ')
    if ($txt -match 'deleted|eliminat|success|rimoss') {
        Write-Host '  Appuntamento rimosso.' -ForegroundColor DarkGray
    } else {
        Write-Host '  Nessun appuntamento trovato (o gia rimosso).' -ForegroundColor DarkGray
    }
}

Use-FallbackEnvValue -Name 'YAP_USERNAME' -Fallback 'anasilsupremo@offcarchiuduno' -Sensitive
Use-FallbackEnvValue -Name 'YAP_PASSWORD' -Fallback 'Qweasdzxc@123' -Sensitive
Use-FallbackEnvValue -Name 'YAP_TEST_CUSTOMER_MARKER' -Fallback $TestCustomerMarker
Use-FallbackEnvValue -Name 'YAP_WRITE_ODL' -Fallback '1'

Write-Host '======================================================'
Write-Host ("  ODL VALIDATION SUITE  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host '======================================================'
Write-Host ("  RunCount: " + $RunCount)

Write-Host ''
Write-Host '--- PRE-CLEANUP ---'
Invoke-Cleanup 'pre'

$runs = @()
for ($index = 1; $index -le $RunCount; $index++) {
    Write-Host ''
    Write-Host ("--- RUN $index/$RunCount (attendi 60-120s) ---")
    $run = Invoke-OdlRun -RunIndex $index
    if ($run) {
        $icon = if ($run.Ok -and $run.VerifyRatio -ge 1.0) { 'PASS' } else { 'FAIL' }
        $color = if ($icon -eq 'PASS') { 'Green' } else { 'Red' }
        Write-Host ("  [$icon] ok=" + $run.Ok + " saved=" + $run.Saved + " workspace=" + $run.WorkspaceState + " openedOdl=" + $run.OpenedOdl + " verify=" + $run.VerifyMatched + "/" + $run.VerifyTotal + " ratio=" + $run.VerifyRatio) -ForegroundColor $color
    }
    $runs += $run

    Write-Host ''
    Write-Host ("--- CLEANUP dopo Run $index ---")
    Invoke-Cleanup ("run$index")
    if ($index -lt $RunCount -and $PauseSeconds -gt 0) {
        Write-Host ("  Pausa " + $PauseSeconds + "s...") -ForegroundColor DarkGray
        Start-Sleep -Seconds $PauseSeconds
    }
}

Write-Host ''
Write-Host '======================================================'
Write-Host '  SUMMARY VALIDAZIONE'
Write-Host '======================================================'

$completedRuns = @($runs | Where-Object { $_ })
$passed = 0
foreach ($run in $completedRuns) {
    $icon = if ($run.Ok -and $run.VerifyRatio -ge 1.0) { 'PASS' } else { 'FAIL' }
    if ($icon -eq 'PASS') { $passed++ }
    Write-Host ("  [$icon] Run " + $run.RunIndex + " workspace=" + $run.WorkspaceState + " openedOdl=" + $run.OpenedOdl + " verify=" + $run.VerifyMatched + "/" + $run.VerifyTotal + " ratio=" + $run.VerifyRatio)
}

if ($completedRuns.Count -ne $RunCount) {
    Write-Host ("  ATTENZIONE: completate solo " + $completedRuns.Count + "/" + $RunCount + " run.") -ForegroundColor Yellow
}

Write-Host ''
if ($passed -eq $RunCount) {
    Write-Host ("  VALIDAZIONE COMPLETATA: " + $passed + "/" + $RunCount + " run passate.") -ForegroundColor Green
} else {
    Write-Host ("  VALIDAZIONE INCOMPLETA: " + $passed + "/" + $RunCount + " run passate.") -ForegroundColor Red
}
Write-Host ("  Log dir: " + $RESULTS)
