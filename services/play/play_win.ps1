# Plays a reading's WAV clips in order on Windows, in one process so there is no
# start-up gap between clips. The mod starts this as soon as a reading begins,
# naming every clip file; each clip is played once "<clip>.ready" appears (the
# mod writes it after the voice made the clip) and skipped on "<clip>.skip".
# Stopping the reading kills this process.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File play_win.ps1 a.wav b.wav ...
$player = New-Object System.Media.SoundPlayer
$i = 0
foreach ($clip in $args) {
  $waited = 0
  while (-not (Test-Path "$clip.ready") -and -not (Test-Path "$clip.skip")) {
    Start-Sleep -Milliseconds 50
    $waited += 50
    if ($waited -gt 120000) { exit 2 }  # the voice stalled; give up rather than hang
  }
  if (Test-Path "$clip.ready") {
    Write-Output "playing $i"
    $player.SoundLocation = $clip
    $player.PlaySync()
  } else {
    Write-Output "skipped $i"
  }
  $i++
}
Write-Output "done"
