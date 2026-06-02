# run-odl-test.ps1
# Safe-by-default ODL test suite:
# - probe read-only sulla pratica
# - worker reale di validazione
# - nessuna modifica al repo o al worker senza flag esplicito
#
# Uso:
#   cd C:\Users\Anas\giorgio\automation\yap
#   .\run-odl-test.ps1
#   .\run-odl-test.ps1 -ApplyDetectedPageEnum

[CmdletBinding()]
param(
    [string]$ProbeDate = '2026-11-12',
    [string]$ProbeSearch = 'FK079BX',
    [string]$ProbeLabel = 'fk079bx',
    [string]$WorkerDate = '2026-12-27',
    [string]$WorkerTime = '07:00',
    [string]$PayloadFile = 'test-real-vehicle-payload.json',
    [string]$TestCustomerMarker = 'TEST AUTOMAZIONE',
    [switch]$ApplyDetectedPageEnum
)

$YAP_DIR   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RESULTS   = Join-Path $YAP_DIR "analysis\odl-test-results"
$TS        = Get-Date -Format 'yyyyMMdd-HHmmss'
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

function Find-LastJsonLine {
    param([string[]]$Lines)
    if (-not $Lines) { return $null }
    for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
        $line = [string]$Lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $obj = $line | ConvertFrom-Json -ErrorAction Stop
            return $obj
        } catch {
        }
    }
    return $null
}

function Set-PageEnumInWorker {
    param(
        [string]$WorkerPath,
        [string]$PageEnum
    )
    $workerContent = Get-Content $WorkerPath -Raw -Encoding UTF8
    $updated = $workerContent -replace 'Page:\s*"ODL"', ('Page: "' + $PageEnum + '"')
    if ($updated -eq $workerContent) {
        Write-Host "  Nessun placeholder Page:\"ODL\" aggiornato nel worker." -ForegroundColor DarkYellow
        return
    }
    Set-Content $WorkerPath -Value $updated -Encoding UTF8 -NoNewline
    Write-Host "  Worker aggiornato esplicitamente: Page -> '$PageEnum'" -ForegroundColor Yellow
}

Use-FallbackEnvValue -Name 'YAP_USERNAME' -Fallback 'anasilsupremo@offcarchiuduno' -Sensitive
Use-FallbackEnvValue -Name 'YAP_PASSWORD' -Fallback 'Qweasdzxc@123' -Sensitive
Use-FallbackEnvValue -Name 'YAP_TEST_CUSTOMER_MARKER' -Fallback $TestCustomerMarker
Use-FallbackEnvValue -Name 'YAP_WRITE_ODL' -Fallback '1'

Write-Host '======================================================'
Write-Host ("  ODL TEST SUITE  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host '======================================================'
Write-Host '  Modalita: safe-by-default'
Write-Host ("  ApplyDetectedPageEnum: " + $ApplyDetectedPageEnum.IsPresent)

# --------------------------------------------------
# STEP 1: Probe read-only
# --------------------------------------------------
Write-Host ''
Write-Host '--- STEP 1: Probe read-only ---'
$probeLog = Join-Path $RESULTS "probe-$TS.log"
Push-Location $YAP_DIR
$probeRaw = node yap-pratica-odl-probe.mjs --date $ProbeDate --search $ProbeSearch --label $ProbeLabel 2>&1
Pop-Location
$probeRaw | Out-File $probeLog -Encoding UTF8
$probeRaw | Write-Host

$probeObj = Find-LastJsonLine -Lines $probeRaw
$pageEnumFound = $null
if ($probeObj) {
    $pageEnumFound = $probeObj.pageAfterOdl.pageEnum
    Write-Host ''
    Write-Host ("  pageEnum dopo ODL  : " + $pageEnumFound)
    Write-Host ("  activeTab          : " + $probeObj.pageAfterOdl.activeTab)
    Write-Host ("  hasOdlBadge        : " + $probeObj.pageAfterOdl.hasOdlBadge)
    Write-Host ("  output file        : " + $probeObj.outputFile)
} else {
    Write-Host '  ATTENZIONE: output probe non parsato come JSON lineare.' -ForegroundColor Yellow
}

if ($ApplyDetectedPageEnum.IsPresent -and
    $pageEnumFound -and
    $pageEnumFound -ne 'ODL' -and
    $pageEnumFound -ne 'no_pratica_hash' -and
    $pageEnumFound -ne 'no_page_field' -and
    $pageEnumFound -ne 'parse_error') {

    Write-Host ''
    Write-Host ("  Apply esplicito del Page enum reale: " + $pageEnumFound) -ForegroundColor Yellow
    Set-PageEnumInWorker -WorkerPath (Join-Path $YAP_DIR 'yap-worker.mjs') -PageEnum $pageEnumFound
}

# --------------------------------------------------
# STEP 2: Worker
# --------------------------------------------------
Write-Host ''
Write-Host '--- STEP 2: Worker reale di validazione ---'
Write-Host '  (attendi 60-120 secondi...)'
$workerLog = Join-Path $RESULTS "worker-$TS.log"
$payloadPath = if ([System.IO.Path]::IsPathRooted($PayloadFile)) { $PayloadFile } else { Join-Path $YAP_DIR $PayloadFile }
Push-Location $YAP_DIR
$workerRaw = node yap-worker.mjs --payload-file $payloadPath --date $WorkerDate --time $WorkerTime --commit --debug 2>&1
Pop-Location
$workerRaw | Out-File $workerLog -Encoding UTF8

$workerText = ($workerRaw -join "`n")
$workerJsonText = Get-TrailingJsonBlock -Text $workerText
try {
    if (-not $workerJsonText) { throw 'Nessun trailing JSON valido trovato nell output del worker.' }
    $res = $workerJsonText | ConvertFrom-Json -ErrorAction Stop
    $wr = $res.result.write_report

    Write-Host ''
    Write-Host '  +----- RISULTATO WORKER ---------------------+'
    Write-Host ("  | ok                : " + $res.ok)
    Write-Host ("  | saved             : " + $res.result.saved)
    Write-Host ("  | workspaceState    : " + $wr.workspaceState)
    Write-Host ("  | openedPractice    : " + $wr.openedPractice)
    Write-Host ("  | odlRouteAttempted : " + $wr.odlRouteAttempted)
    Write-Host ("  | odlRouteEffective : " + $wr.odlRouteEffective)
    Write-Host ("  | openedOdl         : " + $wr.openedOdl)
    Write-Host ("  | fallbackClickUsed : " + $wr.odlFallbackClickUsed)
    Write-Host ("  | pageEnumAfterOdl  : " + $wr.pageEnumAfterOdl)
    Write-Host ("  | odl.error         : " + $wr.odl.error)
    Write-Host ("  | verify matched    : " + $wr.verify.matched + "/" + $wr.verify.total + " ratio=" + $wr.verify.ratio)
    Write-Host '  +--------------------------------------------+'

    if ($wr.fields) {
        Write-Host ''
        Write-Host '  Campi:'
        foreach ($f in $wr.fields) {
            $icon = if ($f.status -eq 'written') { 'OK' } else { 'XX' }
            Write-Host ("    [" + $icon + "] " + $f.field_id + ": " + $f.status + " (" + $f.expected + ")")
        }
    }

    $summary = [ordered]@{
        timestamp          = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        mode               = 'safe_odl_test'
        probePageEnum      = $pageEnumFound
        workerOk           = $res.ok
        saved              = $res.result.saved
        workspaceState     = $wr.workspaceState
        openedPractice     = $wr.openedPractice
        odlRouteAttempted  = $wr.odlRouteAttempted
        odlRouteEffective  = $wr.odlRouteEffective
        openedOdl          = $wr.openedOdl
        fallbackClickUsed  = $wr.odlFallbackClickUsed
        pageEnumAfterOdl   = $wr.pageEnumAfterOdl
        odlError           = $wr.odl.error
        verify             = $wr.verify
        fields             = $wr.fields
        probeLog           = $probeLog
        workerLog          = $workerLog
    }
    $summaryPath = Join-Path $RESULTS "summary-$TS.json"
    $summary | ConvertTo-Json -Depth 10 | Out-File $summaryPath -Encoding UTF8
    Write-Host ''
    Write-Host ("  Summary: " + $summaryPath)
} catch {
    Write-Host '  ATTENZIONE: impossibile parsare JSON worker.' -ForegroundColor Red
    Write-Host ("  Errore: " + $_) -ForegroundColor Red
    Write-Host '  Ultime 30 righe log:' -ForegroundColor DarkGray
    $workerRaw | Select-Object -Last 30 | Write-Host
}

Write-Host ''
Write-Host '--- Cleanup manuale opzionale ---'
Write-Host ("  node yap-delete-appointment.mjs --date " + $WorkerDate + " --search ZZ555ZZ")
Write-Host ''
Write-Host ("Log e summary in: " + $RESULTS)
