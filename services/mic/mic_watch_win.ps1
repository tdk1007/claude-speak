# Watch for an app starting to use the microphone (Windows 10/11), then exit.
#
# The speak mod runs this while it is reading aloud. Windows records which apps
# use the mic (the same list behind the taskbar's mic icon) under
# CapabilityAccessManager\ConsentStore\microphone: an app is recording while its
# LastUsedTimeStop is 0. Apps already recording when this starts (Discord, a
# call, SteamVR) are the baseline and are ignored; the first app that starts
# after that (Windows dictation Win+H, Claude's dictation, Wispr Flow, ...)
# prints "mic <app>" and exits, and the mod stops talking.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File mic_watch_win.ps1         # watch
#   powershell -NoProfile -ExecutionPolicy Bypass -File mic_watch_win.ps1 -List   # who records now
param([switch]$List)

$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged'
)

function Get-Recording {
  $now = @{}
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $p = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($null -ne $p.LastUsedTimeStart -and $p.LastUsedTimeStop -eq 0) {
        $now[$key.PSChildName.Replace('#', '\')] = $true
      }
    }
  }
  return $now
}

if ($List) { (Get-Recording).Keys; exit 0 }

$base = Get-Recording
Write-Output ("watching " + (($base.Keys | Sort-Object) -join ' '))
$seen = @{}
$deadline = (Get-Date).AddMinutes(30)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $now = Get-Recording
  $next = @{}
  foreach ($app in $now.Keys) {
    if ($base.ContainsKey($app)) { continue }
    $next[$app] = 1 + [int]$seen[$app]
    if ($next[$app] -ge 2) { Write-Output "mic $app"; exit 0 }
  }
  $seen = $next
  # An app that stopped counts as new if it starts again.
  foreach ($app in @($base.Keys)) { if (-not $now.ContainsKey($app)) { $base.Remove($app) } }
}
