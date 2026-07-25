# Ingest every source PDF that does NOT yet have a docs/catalogs/<id>.sqlite.
# ingest.py itself also skips anything already in OPFS, so this is doubly safe to
# re-run. Catalog id = PDF filename stem (matches the docs/catalogs naming).
$root = "C:\Users\chell\Documents\GitHub\pet-babelfish"
Set-Location $root
$env:PYTHONUTF8 = "1"

$pdfs = Get-ChildItem "$root\pet-source-pdf\*.pdf" | Sort-Object Name
$log  = "$root\tools\ingest-missing.log"
Set-Content $log "" -Encoding utf8

foreach ($pdf in $pdfs) {
    $id  = $pdf.BaseName
    $out = "$root\docs\catalogs\$id.sqlite"
    if (Test-Path $out) {
        Add-Content $log "[$(Get-Date -Format 'HH:mm:ss')] SKIP $id (already in docs/catalogs)"
        continue
    }
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content $log "[$ts] START $id"
    Write-Host "[$ts] START $id"

    uv run --with playwright python tools/ingest.py $pdf.FullName --catalog-id $id --timeout 60

    $exit = $LASTEXITCODE
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    if ($exit -eq 0) { Add-Content $log "[$ts] DONE $id" }
    else             { Add-Content $log "[$ts] FAILED $id (exit $exit)" }
}
Add-Content $log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ALL DONE"
