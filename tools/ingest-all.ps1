$root = "C:\Users\chell\Documents\GitHub\pet-babelfish"
Set-Location $root
$env:PYTHONUTF8 = "1"

$pdfs = @(
    @{ file = "356_356A_1950-1959.pdf";           id = "356" },
    @{ file = "997-1_2005-2008.pdf";              id = "997-1" },
    @{ file = "997-1Turbo-GT2_2007-2009.pdf";     id = "997-1tt" },
    @{ file = "997-2_2009-2012.pdf";              id = "997-2" },
    @{ file = "997-2Turbo-GT2RS_2010-2013.pdf";   id = "997-2tt" },
    @{ file = "997GT3-GT3RS_2007-2011.pdf";       id = "997-gt3" },
    @{ file = "Boxster(987-1)_2005-2008.pdf";     id = "987-1" },
    @{ file = "Boxster(987-2)_2009-2012.pdf";     id = "987-2" },
    @{ file = "Cayenne-955(E1)_2003-2006.pdf";    id = "cayenne-955" }
)

$log = "$root\tools\ingest-all.log"
Set-Content $log "" -Encoding utf8

foreach ($entry in $pdfs) {
    $pdf = "$root\pet-source-pdf\$($entry.file)"
    $id  = $entry.id
    $ts  = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content $log "[$ts] START $id"
    Write-Host "[$ts] START $id"

    uv run --with playwright python tools/ingest.py $pdf --catalog-id $id --timeout 60
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
