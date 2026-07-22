# serve.ps1
# Start the static file server and query bridge together.
#
# Usage: .\serve.ps1 [-StaticPort 8080] [-BridgePort 9876]
#
# Static files: http://localhost:8080
# Query bridge: http://localhost:9876
#
# Ctrl+C stops both.

param(
    [int]$StaticPort = 8080,
    [int]$BridgePort = 9876
)

$docsPath = Join-Path $PSScriptRoot "..\docs"

# Start Python HTTP server in a hidden window
$server = Start-Process python `
    -ArgumentList "-m", "http.server", $StaticPort, "--directory", $docsPath `
    -PassThru -WindowStyle Hidden

Write-Host "Static:  http://localhost:$StaticPort"
Write-Host "Bridge:  http://localhost:$BridgePort"
Write-Host "Viewer:  http://localhost:$StaticPort/viewer.html"
Write-Host ""
Write-Host "To take a screenshot:"
Write-Host "  uv run --with playwright python tools/screenshot.py"
Write-Host ""
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
    & "$PSScriptRoot\query-bridge.ps1" -Port $BridgePort
} finally {
    if (-not $server.HasExited) {
        $server.Kill()
        Write-Host "HTTP server stopped."
    }
}
