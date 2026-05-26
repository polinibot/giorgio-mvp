# YAP Agenda - Ispezione batch degli appuntamenti trovati
# Esegui: .\automation\yap\inspect-found-appointments.ps1

$env:YAP_USERNAME = 'anasilsupremo@offcarchiuduno'
$env:YAP_PASSWORD = 'Qweasdzxc@123'

$appointments = @(
    @{ Date = "2026-03-16"; Search = "Italtrans"; Description = "Italtrans filippina - carrozzeria" },
    @{ Date = "2026-03-15"; Search = "revisione"; Description = "Cofano/freccia/revisione - 3285625559" },
    @{ Date = "2026-03-23"; Search = "Passat"; Description = "Passat - misto officina+carrozzeria+revisione" },
    @{ Date = "2026-03-25"; Search = "Frigor"; Description = "Frigor Trasporti - carrozzeria cerchi/paraurti" },
    @{ Date = "2026-03-30"; Search = "3899885954"; Description = "Porta posteriore sx - 3899885954" }
)

$outputDir = "automation/yap/analysis/inspections"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

foreach ($appt in $appointments) {
    $date = $appt.Date
    $search = $appt.Search
    $desc = $appt.Description
    
    Write-Host "`n🔍 Ispezionando: $desc ($date)" -ForegroundColor Cyan
    
    node automation/yap/yap-agenda-inspector.mjs `
        --date $date `
        --search $search `
        --output-dir $outputDir
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host "   ✅ Trovato e ispezionato" -ForegroundColor Green
    } else {
        Write-Host "   ❌ Non trovato o errore" -ForegroundColor Red
    }
    
    Start-Sleep -Seconds 2
}

Write-Host "`n📁 Tutte le ispezioni salvate in: $outputDir" -ForegroundColor Yellow
Write-Host "📊 Per analizzare i risultati:" -ForegroundColor Yellow
Write-Host "   node automation/yap/analyze-inspections.mjs" -ForegroundColor Gray
