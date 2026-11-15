# Install, start, update over, and uninstall the per-user Windows installer.
#
# Runs on a fresh hosted runner and owns everything it checks: it refuses to
# start if Octant's install folder, Start menu entry, Apps list entry, link
# registration or data folders already exist, and it stops only processes
# whose program lives in the install folder it created. The installer is the
# unsigned CI build; signing is proven only by the release workflow.
param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'

$octantProduct = 'Octant'
$octantLocal = [Environment]::GetFolderPath('LocalApplicationData')
$octantRoaming = [Environment]::GetFolderPath('ApplicationData')
$octantStartMenu = [Environment]::GetFolderPath('Programs')
$octantInstall = Join-Path $octantLocal "Programs\$octantProduct"
$octantExe = Join-Path $octantInstall "$octantProduct.exe"
$octantUninstaller = Join-Path $octantInstall "Uninstall $octantProduct.exe"
$octantShortcut = Join-Path $octantStartMenu "$octantProduct.lnk"
$octantUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.octant.desktop'
$octantMachineKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.octant.desktop'
$octantProtocolKey = 'HKCU:\Software\Classes\octant'
$octantDataFolders = @((Join-Path $octantLocal $octantProduct), (Join-Path $octantRoaming $octantProduct))
$octantInstaller = (Resolve-Path -LiteralPath $Installer).ProviderPath

function Write-Evidence([hashtable]$Fact) { Write-Output ($Fact | ConvertTo-Json -Compress) }

foreach ($octantPath in @($octantInstall, $octantShortcut, $octantUninstallKey, $octantMachineKey, $octantProtocolKey) + $octantDataFolders) {
  if (Test-Path -LiteralPath $octantPath) { throw "Refusing a pre-existing $octantPath" }
}

# The installer asks for no elevation: its manifest says asInvoker.
$octantBytes = [IO.File]::ReadAllBytes($octantInstaller)
$octantText = [Text.Encoding]::ASCII.GetString($octantBytes)
if (-not $octantText.Contains('level="asInvoker"')) { throw 'The installer manifest does not run as the invoking user' }
if ($octantText.Contains('level="requireAdministrator"') -or $octantText.Contains('level="highestAvailable"')) { throw 'The installer asks for elevation' }
Write-Evidence @{ installerRunsAsInvoker = $true }

function Invoke-OctantInstaller([string[]]$Arguments, [int]$TimeoutSeconds) {
  $process = Start-Process -FilePath $octantInstaller -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    throw 'The installer exceeded its deadline'
  }
  return $process.ExitCode
}

function Get-OctantProcesses {
  $prefix = $octantInstall + [IO.Path]::DirectorySeparatorChar
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-OctantProcesses {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ($true) {
    $running = Get-OctantProcesses
    if ($running.Count -eq 0) { return }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Installed Octant processes did not stop' }
    foreach ($process in $running) {
      # Only processes running a program from the install folder this script
      # created; never by name.
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
  }
}

function Start-OctantFromStartMenu {
  Start-Process -FilePath $octantShortcut
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($process in Get-OctantProcesses) {
      $window = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
      if ($window -and $window.MainWindowHandle -ne [IntPtr]::Zero -and $window.MainWindowTitle) {
        return $window.MainWindowTitle
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'The installed app showed no window within 90 seconds'
}

function Assert-Installed {
  foreach ($path in @($octantExe, $octantUninstaller, $octantShortcut, (Join-Path $octantInstall 'resources\app\package.json'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "The install is missing $path" }
  }
  $key = Get-ItemProperty -LiteralPath $octantUninstallKey
  if ($key.DisplayName -cne $octantProduct) { throw 'The Apps list entry has the wrong name' }
  if ($key.UninstallString -cne ('"' + $octantUninstaller + '"')) { throw 'The Apps list entry runs another uninstaller' }
  if ($key.QuietUninstallString -cne ('"' + $octantUninstaller + '" /S')) { throw 'The quiet uninstall entry is wrong' }
  if ($key.InstallLocation -cne $octantInstall) { throw 'The Apps list entry names another folder' }
  if (Test-Path -LiteralPath $octantMachineKey) { throw 'The per-user installer wrote a machine-wide entry' }
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($octantShortcut)
  if ($link.TargetPath -ine $octantExe) { throw 'The Start menu entry starts another program' }
}

try {
  # First install, silently, for this user only.
  $code = Invoke-OctantInstaller @('/S') 300
  if ($code -ne 0) { throw "The silent install exited $code" }
  Assert-Installed
  Write-Evidence @{ installedPerUser = $octantInstall }

  # Start it the way a person would and wait for its window.
  $title = Start-OctantFromStartMenu
  if (-not (Test-Path -LiteralPath (Join-Path $octantLocal "$octantProduct\hosts\octant"))) {
    throw 'The installed app started without creating its host profile'
  }
  Write-Evidence @{ installedAppStarted = $true; windowTitle = $title }

  # An update while the app runs waits for it, then refuses and leaves the
  # installed copy untouched.
  $before = (Get-FileHash -LiteralPath $octantExe -Algorithm SHA256).Hash
  $code = Invoke-OctantInstaller @('/S') 180
  if ($code -ne 3) { throw "An install over the running app exited $code, not the busy refusal" }
  if ((Get-OctantProcesses).Count -eq 0) { throw 'The refused install stopped the running app' }
  if ((Get-FileHash -LiteralPath $octantExe -Algorithm SHA256).Hash -cne $before) { throw 'The refused install changed the app' }
  Write-Evidence @{ installOverRunningAppRefused = $true }
  Stop-OctantProcesses

  # Installing again once it has stopped replaces it through its own uninstaller.
  $code = Invoke-OctantInstaller @('/S') 300
  if ($code -ne 0) { throw "Installing over the stopped app exited $code" }
  Assert-Installed
  Write-Evidence @{ reinstalledOverPreviousVersion = $true }

  # A file the person put in the install folder is not the installer's to remove.
  $octantNote = Join-Path $octantInstall 'kept-by-person.txt'
  Set-Content -LiteralPath $octantNote -Value 'not installed by Octant'

  Start-Process -FilePath $octantUninstaller -ArgumentList @('/S') -Wait
  # The uninstaller copies itself out of the folder and runs from there.
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ((Test-Path -LiteralPath $octantExe) -or (Test-Path -LiteralPath $octantUninstallKey)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'The uninstall did not finish within 120 seconds' }
    Start-Sleep -Milliseconds 500
  }
  foreach ($path in @($octantUninstaller, $octantShortcut, $octantUninstallKey, $octantProtocolKey)) {
    if (Test-Path -LiteralPath $path) { throw "The uninstall left $path" }
  }
  $runKey = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  if ($runKey) {
    foreach ($property in $runKey.PSObject.Properties) {
      if ([string]$property.Value -like "*$octantExe*") { throw 'The uninstall left a login item for the removed app' }
    }
  }
  $left = @(Get-ChildItem -LiteralPath $octantInstall -Recurse -Force)
  if ($left.Count -ne 1 -or $left[0].FullName -ne $octantNote) {
    throw ('The uninstall left installed files: ' + (($left | ForEach-Object FullName) -join ', '))
  }
  foreach ($folder in $octantDataFolders) {
    if (-not (Test-Path -LiteralPath $folder)) { throw "The uninstall removed the person's data at $folder" }
  }
  Write-Evidence @{ uninstalledCleanly = $true; personFileKept = $true; dataKept = $true }
} finally {
  Stop-OctantProcesses
  if (Test-Path -LiteralPath $octantUninstallKey) {
    Start-Process -FilePath $octantUninstaller -ArgumentList @('/S') -Wait -ErrorAction SilentlyContinue
  }
  # Everything below was created by this run on a runner that had none of it.
  foreach ($path in @($octantInstall) + $octantDataFolders) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  foreach ($key in @($octantUninstallKey, $octantProtocolKey)) {
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
  }
  if (Test-Path -LiteralPath $octantShortcut) { Remove-Item -LiteralPath $octantShortcut -Force }
}
Write-Evidence @{ ownedInstallerStateAbsent = $true }
