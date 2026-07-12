# tools/export-sqlite.ps1
# Export the currently loaded SQLite database out of the browser (via query bridge)
# and save it as a local file. Useful for scripted testing with screenshot.py.
#
# Prerequisites:
#   - query-bridge.ps1 (or serve.ps1) must be running
#   - catalog-browser.html must be open in the browser with a catalog loaded
#
# Usage:
#   .\tools\export-sqlite.ps1
#   .\tools\export-sqlite.ps1 -Out my-catalog.sqlite

param(
    [string]$Out        = "exported.sqlite",
    [int]$BridgePort    = 9876,
    [int]$WaitMs        = 3000
)

$base = "http://localhost:$BridgePort"

Write-Host "Requesting export from browser..."
try {
    Invoke-WebRequest "$base/query" -Method POST -Body '__EXPORT__' -UseBasicParsing | Out-Null
} catch {
    Write-Error "Cannot reach query bridge at $base — is serve.ps1 running?"
    exit 1
}

Start-Sleep -Milliseconds $WaitMs

$raw = (Invoke-WebRequest "$base/result" -UseBasicParsing).Content
if (-not $raw -or $raw.Trim() -eq '') {
    Write-Error "No result. Is catalog-browser.html open with a catalog selected?"
    exit 1
}

$parsed = $raw | ConvertFrom-Json
if (-not $parsed.ok -or -not $parsed.export) {
    Write-Error "Export failed: $raw"
    exit 1
}

$bytes    = [Convert]::FromBase64String($parsed.export)
$outFull  = [IO.Path]::GetFullPath($Out)
[IO.File]::WriteAllBytes($outFull, $bytes)

Write-Host "Saved $($bytes.Length) bytes → $outFull"
if ($parsed.filename) {
    Write-Host "Original catalog: $($parsed.filename)"
}
