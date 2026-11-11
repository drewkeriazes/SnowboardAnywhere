# Snowboard sim data fetcher. Downloads everything listed in pipeline/manifests/<slug>.json
# into raw/<slug>/. Safe to re-run: finished files are skipped, partial files are retried.
# Works on Windows PowerShell 5.1 and PowerShell 7. No installs needed.
param(
    [string]$Slug = "vail",
    [int]$Concurrency = 6,
    # parent folder for raw data; downloads go to <RawDir>\<Slug>. Default: raw\ inside the repo.
    [string]$RawDir = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13 } catch { try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {} }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # repo root
$manifestPath = Join-Path $root "pipeline\manifests\$Slug.json"
$rawDir = if ($RawDir) { Join-Path $RawDir $Slug } else { Join-Path $root "raw\$Slug" }
if (-not (Test-Path $manifestPath)) { Write-Host "Manifest not found: $manifestPath" -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force -Path $rawDir | Out-Null
$log = Join-Path $rawDir "fetch_log.txt"
function Log($msg) { $line = "{0}  {1}" -f (Get-Date -Format "HH:mm:ss"), $msg; Write-Host $line; Add-Content -Path $log -Value $line }

# Environment notes for the processing side
$envFile = Join-Path $rawDir "env.txt"
$envInfo = @()
$envInfo += "os=" + [System.Environment]::OSVersion.VersionString
$envInfo += "ps=" + $PSVersionTable.PSVersion.ToString()
foreach ($exe in @("python", "py", "node", "npm", "git")) {
    $cmd = Get-Command $exe -ErrorAction SilentlyContinue
    if ($cmd) {
        try { $v = & $exe --version 2>&1 | Select-Object -First 1 } catch { $v = "?" }
        $envInfo += "$exe=" + $cmd.Source + " (" + $v + ")"
    } else { $envInfo += "$exe=missing" }
}
$envInfo | Set-Content -Path $envFile

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$items = @($manifest.items)
Log "Manifest ${Slug}: $($items.Count) items -> $rawDir"

Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMinutes(15)
$client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "snowboard-sim-fetch/0.1 (personal project)") | Out-Null

# Per-host politeness: how many requests may be in flight at once
function HostLimit($url) {
    if ($url -like "*nationalmap.gov*") { return 2 }
    if ($url -like "*planetarycomputer*") { return 3 }
    if ($url -like "*overpass-api.de*") { return 1 }
    return $Concurrency
}

# Build the work list, skipping finished files
$work = New-Object System.Collections.Generic.List[object]
$skipped = 0
foreach ($it in $items) {
    $dest = Join-Path $rawDir ($it.path -replace "/", "\")
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) { $skipped++; continue }
    $alts = @(); if ($it.alts) { $alts = @($it.alts) }
    $work.Add([pscustomobject]@{ url = $it.url; path = $it.path; dest = $dest; method = $it.method; body = $it.body; tries = 0; alts = $alts })
}
Log "Skipping $skipped already downloaded; $($work.Count) to fetch"

$inflight = @{}      # task -> item
$hostCounts = @{}
$done = 0; $failed = New-Object System.Collections.Generic.List[object]; $bytes = 0L
$queue = New-Object System.Collections.Generic.Queue[object]
foreach ($w in $work) { $queue.Enqueue($w) }
$deferred = New-Object System.Collections.Generic.List[object]
$lastReport = Get-Date

function StartItem($it) {
    $h = ([Uri]$it.url).Host
    if ($it.method -eq "POST") {
        $content = New-Object System.Net.Http.StringContent($it.body, [System.Text.Encoding]::UTF8, "application/x-www-form-urlencoded")
        $task = $client.PostAsync($it.url, $content)
    } else {
        # DATA-021: the 3DEP ImageServer drops some exports without answering; a healthy 1500 px chunk takes
        # about 10 s, so give up on it after 3 min and retry instead of holding one of its two slots for 15 min
        $limit = if ($it.url -like "*nationalmap.gov*") { [TimeSpan]::FromMinutes(3) } else { $client.Timeout }
        $cts = New-Object System.Threading.CancellationTokenSource($limit)
        $task = $client.GetAsync($it.url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token)
    }
    $script:inflight[$task] = $it
    if (-not $script:hostCounts.ContainsKey($h)) { $script:hostCounts[$h] = 0 }
    $script:hostCounts[$h]++
}

while ($queue.Count -gt 0 -or $inflight.Count -gt 0 -or $deferred.Count -gt 0) {
    # fill in-flight slots, respecting per-host limits
    $n = $queue.Count
    for ($k = 0; $k -lt $n -and $inflight.Count -lt $Concurrency; $k++) {
        $it = $queue.Dequeue()
        $h = ([Uri]$it.url).Host
        $cur = 0; if ($hostCounts.ContainsKey($h)) { $cur = $hostCounts[$h] }
        if ($cur -ge (HostLimit $it.url)) { $deferred.Add($it); continue }
        StartItem $it
    }
    foreach ($d in $deferred) { $queue.Enqueue($d) }
    $deferred.Clear()

    if ($inflight.Count -eq 0) { Start-Sleep -Milliseconds 100; continue }

    $tasks = [System.Threading.Tasks.Task[]]@($inflight.Keys)
    $idx = [System.Threading.Tasks.Task]::WaitAny($tasks, 2000)
    if ($idx -lt 0) {
        if (((Get-Date) - $lastReport).TotalSeconds -ge 15) {
            Log ("  ... {0} done, {1} in flight, {2} queued, {3:N0} MB" -f $done, $inflight.Count, $queue.Count, ($bytes / 1MB)); $lastReport = Get-Date
        }
        continue
    }
    $task = $tasks[$idx]
    $it = $inflight[$task]
    $inflight.Remove($task)
    $h = ([Uri]$it.url).Host; $hostCounts[$h]--
    $ok = $false; $err = ""
    try {
        if ($task.IsFaulted) { throw $task.Exception.InnerException }
        $resp = $task.Result
        if (-not $resp.IsSuccessStatusCode) { throw ("HTTP " + [int]$resp.StatusCode) }
        $tmp = $it.dest + ".part"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $it.dest) | Out-Null
        $fs = [System.IO.File]::Create($tmp)
        try { $resp.Content.CopyToAsync($fs).Wait() } finally { $fs.Close() }
        $resp.Dispose()
        $len = (Get-Item $tmp).Length
        if ($len -le 0) { throw "empty response" }
        # Overpass returns 200 with an HTML/remark body when it fails; sanity check JSON
        if ($it.path -like "osm/*") {
            $head = [System.IO.File]::ReadAllText($tmp).Substring(0, [Math]::Min(200, $len))
            if ($head -notmatch '"elements"' -and $head -notmatch '"version"') { throw "overpass error: $head" }
        }
        if (Test-Path $it.dest) { Remove-Item $it.dest -Force }
        Rename-Item -Path $tmp -NewName (Split-Path -Leaf $it.dest)
        $bytes += $len; $done++; $ok = $true
    } catch {
        $err = $_.Exception.Message
        if (Test-Path ($it.dest + ".part")) { Remove-Item ($it.dest + ".part") -Force }
    }
    if (-not $ok) {
        $it.tries++
        if ($it.alts.Count -gt 0) {
            # rotate to the next mirror
            $next = $it.alts[0]; $it.alts = @($it.alts | Select-Object -Skip 1) + @($it.url); $it.url = $next
        }
        if ($it.tries -lt 6) {
            Log ("  retry {0} ({1}) after error: {2} -> {3}" -f $it.path, $it.tries, $err, ([Uri]$it.url).Host)
            Start-Sleep -Seconds (3 * $it.tries)
            $queue.Enqueue($it)
        } else {
            Log ("  FAILED {0}: {1}" -f $it.path, $err)
            $failed.Add($it)
        }
    }
    if (((Get-Date) - $lastReport).TotalSeconds -ge 15) {
        Log ("  ... {0} done, {1} in flight, {2} queued, {3:N0} MB" -f $done, $inflight.Count, $queue.Count, ($bytes / 1MB)); $lastReport = Get-Date
    }
}

Log ("Finished: {0} downloaded ({1:N0} MB), {2} skipped, {3} failed" -f $done, ($bytes / 1MB), $skipped, $failed.Count)
if ($failed.Count -gt 0) {
    Log "Failed items (re-run this script to retry them):"
    foreach ($f in $failed) { Log ("  " + $f.path) }
    exit 2
}
"complete $(Get-Date -Format o)" | Set-Content -Path (Join-Path $rawDir "FETCH_COMPLETE.txt")
exit 0
