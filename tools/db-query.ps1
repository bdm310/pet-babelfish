# tools/db-query.ps1
# Run a SQL query via the query bridge and print tabular results.
#
# Prerequisites:
#   - query-bridge.ps1 (or serve.ps1) must be running
#   - catalog-browser.html or viewer.html must be open in the browser with a catalog loaded
#
# Usage:
#   .\tools\db-query.ps1 "SELECT COUNT(*) FROM part"
#   .\tools\db-query.ps1 "SELECT position, part_number, description FROM part LIMIT 5"

param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Sql,

    [int]$BridgePort = 9876,
    [int]$WaitMs     = 1500
)

$base = "http://localhost:$BridgePort"

try {
    Invoke-WebRequest "$base/query" -Method POST -Body $Sql -UseBasicParsing | Out-Null
} catch {
    Write-Error "Cannot reach query bridge at $base — is serve.ps1 running?"
    exit 1
}

Start-Sleep -Milliseconds $WaitMs

$raw = (Invoke-WebRequest "$base/result" -UseBasicParsing).Content
if (-not $raw -or $raw.Trim() -eq '') {
    Write-Error "No result received. Is a catalog open in the browser?"
    exit 1
}

$parsed = $raw | ConvertFrom-Json

if (-not $parsed.ok) {
    Write-Error "SQL error: $($parsed.error)"
    exit 1
}

if (-not $parsed.data -or $parsed.data.Count -eq 0) {
    Write-Host "(no rows)"
    exit 0
}

foreach ($stmt in $parsed.data) {
    $cols = $stmt.columns
    Write-Host ($cols -join "`t")
    Write-Host ("-" * ([math]::Min(80, ($cols -join "`t").Length + 8)))
    foreach ($row in $stmt.values) {
        Write-Host ($row -join "`t")
    }
}
