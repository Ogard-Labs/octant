# Start the installed app and wait until it shows a window and has created its
# host profile. Run under the owned-job launcher
# (`octant-windows-desktop-owner.exe --profile-user-owner`), which gives this
# script and the app a token whose default owner is the user: the hosted
# runner's own token is elevated with Administrators as default owner, and the
# native profile rightly refuses to create a profile for it. The launcher's
# kill-on-close job ends the app when this script returns.
param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$octantProfile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Octant\hosts\octant'
$octantApp = Start-Process -FilePath $Executable -PassThru
$octantDeadline = [DateTime]::UtcNow.AddSeconds(60)
$octantTitle = ''
while ([DateTime]::UtcNow -lt $octantDeadline) {
  if ($octantApp.HasExited) { throw "The installed app exited with $($octantApp.ExitCode) before it started" }
  $octantApp.Refresh()
  if ($octantApp.MainWindowHandle -ne [IntPtr]::Zero) { $octantTitle = $octantApp.MainWindowTitle }
  if ($octantTitle -and (Test-Path -LiteralPath $octantProfile)) {
    Write-Output (@{ installedAppStarted = $true; windowTitle = $octantTitle; hostProfileCreated = $true } | ConvertTo-Json -Compress)
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
$octantSeen = @(Get-ChildItem -LiteralPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Octant') -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object FullName)
throw ("The installed app did not start within 60 seconds; window '" + $octantTitle + "', created: " + ($octantSeen -join ', '))
