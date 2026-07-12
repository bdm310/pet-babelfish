# query-bridge.ps1
# HTTP relay between Claude and the pet-babelfish browser app.
#
# POST /query   -- queue a SQL statement (Claude does this)
# GET  /query   -- return pending query and clear it (browser polls this)
# POST /result  -- browser posts query result as JSON
# GET  /result  -- return last result (Claude reads this)

param([int]$Port = 9876)

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Query bridge on http://localhost:$Port/"
Write-Host "Open catalog-browser.html and select a catalog, then POST SQL to /query"

$pending = ''
$result  = ''

function Respond($ctx, $body, $type, $code) {
    if (-not $type) { $type = 'text/plain; charset=utf-8' }
    if (-not $code) { $code = 200 }
    $r = $ctx.Response
    $r.StatusCode  = $code
    $r.ContentType = $type
    $r.Headers.Set('Access-Control-Allow-Origin',  '*')
    $r.Headers.Set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $r.Headers.Set('Access-Control-Allow-Headers', 'Content-Type')
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $r.ContentLength64 = $bytes.Length
    $r.OutputStream.Write($bytes, 0, $bytes.Length)
    $r.Close()
}

function Read-Body($req) {
    (New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)).ReadToEnd()
}

function Timestamp { (Get-Date).ToString('HH:mm:ss') }

try {
    while ($listener.IsListening) {
        $ctx    = $listener.GetContext()
        $method = $ctx.Request.HttpMethod
        $path   = $ctx.Request.Url.AbsolutePath

        if ($method -eq 'OPTIONS') { Respond $ctx '' $null $null; continue }

        if ($method -eq 'POST' -and $path -eq '/query') {
            $pending = Read-Body $ctx.Request
            $ts   = Timestamp
            $snip = $pending.Substring(0, [Math]::Min(80, $pending.Length))
            Write-Host "[$ts] queued: $snip"
            Respond $ctx 'ok' $null $null

        } elseif ($method -eq 'GET' -and $path -eq '/query') {
            Respond $ctx $pending $null $null
            $pending = ''

        } elseif ($method -eq 'POST' -and $path -eq '/result') {
            $result = Read-Body $ctx.Request
            $ts  = Timestamp
            $len = $result.Length
            Write-Host "[$ts] result: $len bytes"
            Respond $ctx 'ok' $null $null

        } elseif ($method -eq 'GET' -and $path -eq '/result') {
            Respond $ctx $result 'application/json; charset=utf-8' $null

        } else {
            Respond $ctx 'not found' $null 404
        }
    }
} finally {
    $listener.Stop()
    Write-Host 'Bridge stopped.'
}
