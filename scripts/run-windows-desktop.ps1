param([Parameter(Mandatory=$true)][string]$Launcher,
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$NightlyPackageDirectory = '')
$ErrorActionPreference = 'Stop'
$octantProfile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Octant/hosts/octant'
$octantProtocols = @{ 'octant' = [IO.Path]::GetFullPath((Join-Path $PackageDirectory 'Octant.exe')) }
$octantAdditionalRoots = @()
if ($NightlyPackageDirectory) {
  $octantProtocols['octant-nightly'] = [IO.Path]::GetFullPath((Join-Path $NightlyPackageDirectory 'Octant Nightly.exe'))
  $octantAdditionalRoots += Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Octant Nightly'
}
foreach ($octantScheme in $octantProtocols.Keys) {
  if (Test-Path -LiteralPath "HKCU:\Software\Classes\$octantScheme") { throw 'Refusing a pre-existing desktop protocol registration' }
}
foreach ($octantRoot in $octantAdditionalRoots) {
  if (Test-Path -LiteralPath $octantRoot) { throw 'Refusing a pre-existing client window store' }
}
if (Test-Path -LiteralPath $octantProfile) { throw 'Refusing a pre-existing Windows desktop profile' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'The owned desktop output directory already exists' }
[void](New-Item -ItemType Directory -Path $OutputDirectory)
$octantBun = (Get-Command bun).Source
$octantJoined = $true
try {
  $octantPhases = if ($NightlyPackageDirectory) { @('nightly') } else { @('owned', 'attached') }
  foreach ($octantPhase in $octantPhases) {
    $octantArguments = @('--profile-user-owner', $octantBun, 'scripts/smoke-windows-desktop.ts', $PackageDirectory, $octantPhase, $OutputDirectory)
    if ($NightlyPackageDirectory) { $octantArguments += $NightlyPackageDirectory }
    $octantResult = @(& $Launcher @octantArguments)
    $octantCode = $LASTEXITCODE
    $octantResult | Write-Output
    if (($octantResult -join "`n") -notmatch '"ownedJobJoined":true') { $octantJoined = $false }
    if ($octantCode -ne 0 -or -not $octantJoined) { throw 'The owned native desktop phase failed or did not join its job' }
  }
} finally {
  if (-not $octantJoined) { throw 'Refusing profile removal before owned processes joined' }
  foreach ($octantScheme in $octantProtocols.Keys) {
    $octantProtocol = "HKCU:\Software\Classes\$octantScheme"
    if (-not (Test-Path -LiteralPath $octantProtocol)) { continue }
    $octantExecutable = $octantProtocols[$octantScheme]
    $octantCommand = (Get-Item -LiteralPath "$octantProtocol\shell\open\command").GetValue('')
    $octantUnquoted = $octantExecutable + ' "%1"'
    $octantQuoted = '"' + $octantExecutable + '" "%1"'
    $octantExpected = @($octantUnquoted, $octantQuoted)
    if ($octantExpected -inotcontains $octantCommand) { throw 'Refusing removal of another protocol command' }
    Remove-Item -LiteralPath $octantProtocol -Recurse -Force
    if (Test-Path -LiteralPath $octantProtocol) { throw 'Owned protocol cleanup was not confirmed' }
  }
  $octantScopeFile = Join-Path $OutputDirectory 'scope.json'
  if (Test-Path -LiteralPath $octantScopeFile) {
    $octantScope = (Get-Content -LiteralPath $octantScopeFile -Raw | ConvertFrom-Json).scope
    if ($octantScope -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw 'Invalid owned desktop scope' }
    foreach ($octantOperation in @('remove', 'absent')) {
      $octantRequest = @{operation=$octantOperation; family='octant'; scope=$octantScope} | ConvertTo-Json -Compress
      $octantIdentity = $octantRequest | & pwsh -NoProfile -NonInteractive -File scripts/windows-host-identity-fixture.ps1
      if ($LASTEXITCODE -ne 0 -or ($octantIdentity -join '').Trim() -ne 'true') { throw 'Owned desktop identity cleanup failed' }
    }
    $octantRuntime = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Octant/runtime/$octantScope"
    foreach ($octantPath in (@($octantProfile, $octantRuntime) + $octantAdditionalRoots)) {
      if (Test-Path -LiteralPath $octantPath) {
        $octantRoot = Get-Item -LiteralPath $octantPath -Force
        if (-not $octantRoot.PSIsContainer -or ($octantRoot.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe owned cleanup root' }
        $octantOwner = (Get-Acl -LiteralPath $octantPath).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($octantOwner -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Owned cleanup root has another owner' }
        foreach ($octantEntry in @(Get-ChildItem -LiteralPath $octantPath -Recurse -Force)) {
          if ($octantEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup through an alias' }
        }
        Remove-Item -LiteralPath $octantPath -Recurse -Force
      }
      if (Test-Path -LiteralPath $octantPath) { throw 'Owned desktop path cleanup was not confirmed' }
    }
    Write-Output '{"ownedDesktopJobsJoined":true,"ownedProfileAndRuntimeAbsent":true,"ownedIdentityAbsent":true,"ownedProtocolRegistrationAbsent":true}'
  } elseif (Test-Path -LiteralPath $octantProfile) {
    throw 'Owned profile cleanup could not be authenticated without its scope receipt'
  }
}
