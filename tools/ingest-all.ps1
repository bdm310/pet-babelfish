# -PartsOnly re-extracts parts text and skips OCR. ingest.py runs a full ingest
# anyway for any catalog that isn't in OPFS yet, so this is safe as a blanket run.
# When the DB schema has changed, -PartsOnly rebuilds a fresh current-schema DB and
# carries the existing diagrams + callouts across (no re-render, no re-OCR), so it
# stays the right blanket command after an interpretation-layer change too.
param([switch]$PartsOnly)

$root = "C:\Users\chell\Documents\GitHub\pet-babelfish"
Set-Location $root
$env:PYTHONUTF8 = "1"

# Every PDF in pet-source-pdf. Catalog IDs are ingest.py's default -- the PDF
# filename stem -- which is what the OPFS catalogs are keyed by.
$pdfs = Get-ChildItem "$root\pet-source-pdf\*.pdf" | Sort-Object Name

$log = "$root\tools\ingest-all.log"
Set-Content $log "" -Encoding utf8

foreach ($pdf in $pdfs) {
    $id = $pdf.BaseName -replace ' ', '-'
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content $log "[$ts] START $id"
    Write-Host "[$ts] START $id"

    $ingestArgs = @($pdf.FullName, '--catalog-id', $id, '--timeout', '60')
    if ($PartsOnly) { $ingestArgs += '--parts-only' }
    uv run --with playwright python tools/ingest.py @ingestArgs

    $exit = $LASTEXITCODE
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    if ($exit -eq 0) {
        Add-Content $log "[$ts] DONE $id (exit $exit)"
        Write-Host "[$ts] DONE $id"
    } else {
        Add-Content $log "[$ts] FAILED $id (exit $exit)"
        Write-Host "[$ts] FAILED $id (exit $exit)"
    }
}

Add-Content $log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ALL DONE"
Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ALL DONE"
