<#
.SYNOPSIS
  Add a folder of downloaded tracks to one station in game/public/music: convert to loudness-matched
  OGG in the station's own folder, update playlist.json and the track tables in CREDITS.md.
.DESCRIPTION
  Downloads happen in the browser (itch.io, OpenGameArt and FMA need a click). Put one station's
  files in one folder, optionally with a tracks.csv next to them:
      file,title,artist,license,url
      Skank the Summer 01.wav,Skank the Summer,DavidKBD,CC BY 4.0,https://davidkbd.itch.io/...
  Then:  .\tools\fetch-music.ps1 -Source "$env:USERPROFILE\Downloads\house" -Playlist "Melodic house"
  Add -Append to put the tracks after the station's existing ones instead of replacing them.
  The stations are "Ska-punk" (ska/), "Melodic house" (house/), "Metal" (metal/) and "Lofi hip-hop"
  (hiphop/); any other name becomes an extra playlist in a folder of its own (heard under Shuffle all).
  Files are numbered in order (01-title.ogg, ...) and normalised like the rest: two-pass loudnorm to
  -11 LUFS, true peak -1 dB, libvorbis q4. The other stations are kept. CREDITS.md keeps its header
  and the notes after the tables; only the tables are rewritten. Only ship CC0 or CC BY tracks, and
  fill in tracks.csv so the credits are right. Needs ffmpeg on PATH (winget install Gyan.FFmpeg).
#>
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [Parameter(Mandatory = $true)] [string] $Playlist,
  [switch] $Append,
  [string] $Out = (Join-Path $PSScriptRoot "..\public\music")
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "ffmpeg not found on PATH (winget install Gyan.FFmpeg)" }
$Out = (Resolve-Path $Out).Path
$folders = @{ 'Ska-punk' = 'ska'; 'Melodic house' = 'house'; 'Metal' = 'metal'; 'Lofi hip-hop' = 'hiphop' }
$folder = if ($folders.ContainsKey($Playlist)) { $folders[$Playlist] } else { ($Playlist.ToLower() -replace '[^a-z0-9]+', '-').Trim('-') }
New-Item -ItemType Directory -Force -Path (Join-Path $Out $folder) | Out-Null
$meta = @{}
$csv = Join-Path $Source 'tracks.csv'
if (Test-Path $csv) { Import-Csv $csv | ForEach-Object { $meta[$_.file] = $_ } }

# existing playlists (an old flat list is Ska-punk)
$lists = [ordered]@{}
$pj = Join-Path $Out 'playlist.json'
if (Test-Path $pj) {
  $raw = Get-Content $pj -Raw | ConvertFrom-Json
  if ($raw -is [array]) { $lists['Ska-punk'] = @($raw) }
  elseif ($raw.playlists) { $raw.playlists.PSObject.Properties | ForEach-Object { $lists[$_.Name] = @($_.Value) } }
}
$tracks = @()
if ($Append -and $lists.Contains($Playlist)) { $tracks = @($lists[$Playlist]) }

# two-pass loudnorm: measure, then apply linearly (the settings every shipped track used)
$target = 'I=-11:TP=-1:LRA=11'
function Convert-Track([string] $src, [string] $dest) {
  $ErrorActionPreference = 'Continue' # ffmpeg reports on stderr, which Windows PowerShell turns into errors
  $log =& ffmpeg -hide_banner -nostats -i $src -af "loudnorm=${target}:print_format=json" -f null - 2>&1 | Out-String
  $m = [regex]::Match($log, '\{[^{}]*"input_i"[^{}]*\}')
  if (-not $m.Success) { throw "loudnorm measure failed for $src" }
  $j = $m.Value | ConvertFrom-Json
  $af = "loudnorm=${target}:measured_I=$($j.input_i):measured_TP=$($j.input_tp):measured_LRA=$($j.input_lra):measured_thresh=$($j.input_thresh):offset=$($j.target_offset):linear=true"
  & ffmpeg -y -loglevel error -i $src -vn -af $af -ar 44100 -c:a libvorbis -q:a 4 $dest
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed on $src" }
}

$n = $tracks.Count
Get-ChildItem $Source -Include *.wav, *.mp3, *.ogg, *.flac, *.m4a -File -Recurse | Sort-Object Name | ForEach-Object {
  $n++
  $m = $meta[$_.Name]
  $base = if ($m -and $m.title) { $m.title } else { [IO.Path]::GetFileNameWithoutExtension($_.Name) }
  $rel = "$folder/" + ('{0:D2}' -f $n) + '-' + ($base.ToLower() -replace '[^a-z0-9]+', '-').Trim('-') + '.ogg'
  Write-Host "  $($_.Name) -> $rel"
  Convert-Track $_.FullName (Join-Path $Out $rel)
  if (-not $m) { Write-Warning "no tracks.csv row for $($_.Name): add title, artist, license and url before shipping" }
  $entry = [ordered]@{ file = $rel; title = $base }
  if ($m) { if ($m.artist) { $entry.artist = $m.artist }; if ($m.license) { $entry.license = $m.license }; if ($m.url) { $entry.url = $m.url } }
  $tracks += [pscustomobject]$entry
}
if ($tracks.Count -eq 0) { throw "no audio files found in $Source" }
$lists[$Playlist] = $tracks

$utf8 = New-Object System.Text.UTF8Encoding $false # no BOM (Set-Content -Encoding UTF8 writes one in Windows PowerShell)
[IO.File]::WriteAllText($pj, (([pscustomobject]@{ playlists = [pscustomobject]$lists } | ConvertTo-Json -Depth 5) + "`n"), $utf8)

# CREDITS.md: keep the header (up to the first table) and the notes after the last one, rewrite the tables
$cp = Join-Path $Out 'CREDITS.md'
$old = if (Test-Path $cp) { @(Get-Content $cp -Encoding UTF8) } else { @() }
if ($old.Count -and $old[0].Length -and $old[0][0] -eq [char]0xFEFF) { $old[0] = $old[0].Substring(1) }
$first = -1; $lastRow = -1
for ($i = 0; $i -lt $old.Count; $i++) { if ($first -lt 0 -and $old[$i] -like '## *') { $first = $i }; if ($old[$i] -like '|*') { $lastRow = $i } }
$head = if ($first -gt 0) { $old[0..($first - 1)] } else { @('# Music credits', '', 'Every track below ships with the game.', '') }
$tail = if ($lastRow -ge 0 -and $lastRow -lt $old.Count - 1) { $old[($lastRow + 1)..($old.Count - 1)] } else { @() }
$tables = @()
foreach ($name in $lists.Keys) {
  $tables += "## $name", "", "| File | Title | Artist | Licence | Source |", "|---|---|---|---|---|"
  foreach ($t in $lists[$name]) { $tables += "| $($t.file) | $($t.title) | $($t.artist) | $($t.license) | $($t.url) |" }
  $tables += ""
}
$tables = $tables[0..($tables.Count - 2)] # the tail starts with its own blank line
[IO.File]::WriteAllText($cp, ((@($head) + $tables + @($tail)) -join "`n") + "`n", $utf8)
Write-Host "wrote $($tracks.Count) tracks to '$Playlist' in $Out\$folder (playlist.json, CREDITS.md)"
