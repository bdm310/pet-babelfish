$root = "C:\Users\chell\Documents\GitHub\pet-babelfish"
Set-Location $root
$env:PYTHONUTF8 = "1"

$catalogs = @("356", "997-1", "997-1tt", "997-2", "997-2tt", "997-gt3", "987-1", "987-2", "cayenne-955")
$log = "$root\tools\verify-all.log"
Set-Content $log "" -Encoding utf8

foreach ($id in $catalogs) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content $log "[$ts] VERIFY $id"
    Write-Host "[$ts] VERIFY $id"

    uv run --with playwright python tools/verify.py --catalog-id $id --out verify-output/$id
    $exit = $LASTEXITCODE

    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    if ($exit -eq 0) {
        Add-Content $log "[$ts] DONE $id"
        Write-Host "[$ts] DONE $id"
    } else {
        Add-Content $log "[$ts] FAILED $id (exit $exit)"
        Write-Host "[$ts] FAILED $id (exit $exit)"
    }
}

Add-Content $log "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ALL DONE"
Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ALL DONE"
