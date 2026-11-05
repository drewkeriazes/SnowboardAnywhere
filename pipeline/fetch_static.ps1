# Downloads the two static source files that replace the Overpass queries:
#   1. Geofabrik Colorado OSM extract (.osm.pbf, ~300 MB)  -> raw\static\colorado-latest.osm.pbf
#   2. USGS GNIS Colorado domestic names (.zip, ~10 MB)    -> raw\static\DomesticNames_CO_Text.zip
# Plain file downloads, no query servers. Safe to re-run: finished files are skipped.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root "raw\static"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$files = @(
    @{ url = "https://download.geofabrik.de/north-america/us/colorado-latest.osm.pbf"; name = "colorado-latest.osm.pbf" },
    @{ url = "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_CO_Text.zip"; name = "DomesticNames_CO_Text.zip" }
)

Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(60)
$client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "snowboard-sim-fetch/0.1 (personal project)") | Out-Null

foreach ($f in $files) {
    $dest = Join-Path $out $f.name
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) { Write-Host "skip  $($f.name) (already downloaded)"; continue }
    $tmp = "$dest.part"
    $ok = $false
    for ($try = 1; $try -le 4 -and -not $ok; $try++) {
        try {
            Write-Host ("{0}  {1} (try {2})" -f (Get-Date -Format "HH:mm:ss"), $f.name, $try)
            $resp = $client.GetAsync($f.url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
            if (-not $resp.IsSuccessStatusCode) { throw ("HTTP " + [int]$resp.StatusCode) }
            $total = $resp.Content.Headers.ContentLength
            $stream = $resp.Content.ReadAsStreamAsync().Result
            $fs = [System.IO.File]::Create($tmp)
            try {
                $buf = New-Object byte[] (1MB); $got = 0L; $last = Get-Date
                while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                    $fs.Write($buf, 0, $n); $got += $n
                    if (((Get-Date) - $last).TotalSeconds -ge 5) {
                        if ($total) { Write-Host ("          {0:N0} / {1:N0} MB" -f ($got / 1MB), ($total / 1MB)) } else { Write-Host ("          {0:N0} MB" -f ($got / 1MB)) }
                        $last = Get-Date
                    }
                }
            } finally { $fs.Close(); $stream.Dispose(); $resp.Dispose() }
            if ($total -and $got -ne $total) { throw "incomplete: $got of $total bytes" }
            Move-Item -Force $tmp $dest
            Write-Host ("done  {0} ({1:N0} MB)" -f $f.name, ($got / 1MB))
            $ok = $true
        } catch {
            $ex = $_.Exception; $parts = @(); while ($ex) { $parts += $ex.Message; $ex = $ex.InnerException }
            Write-Host ("error {0}: {1}" -f $f.name, (($parts | Select-Object -Unique) -join " <- ")) -ForegroundColor Yellow
            if (Test-Path $tmp) { Remove-Item $tmp -Force }
            Start-Sleep -Seconds (5 * $try)
        }
    }
    if (-not $ok) { Write-Host "FAILED $($f.name)" -ForegroundColor Red; exit 2 }
}
"complete $(Get-Date -Format o)" | Set-Content -Path (Join-Path $out "STATIC_COMPLETE.txt")
Write-Host "All static files downloaded to $out"
exit 0
