param([Parameter(Mandatory=$true)][ValidateSet('Stable','Nightly','Cleanup')][string]$Mode,
  [string]$PackageDirectory = '')
$ErrorActionPreference = 'Stop'
$octantLocal = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $octantLocal) { throw 'The current user known folder is unavailable' }
$octantRoot = $env:OCTANT_WINDOWS_QA_ROOT
if ($Mode -eq 'Stable') {
  if ($octantRoot) { throw 'Refusing an inherited QA staging root' }
  $octantRoot = Join-Path $octantLocal ('OctantWindowsQa-' + [guid]::NewGuid().ToString('D'))
  if (Test-Path -LiteralPath $octantRoot) { throw 'Refusing an existing QA staging root' }
  [void](New-Item -ItemType Directory -Path $octantRoot)
  @{run=$env:GITHUB_RUN_ID; head=$env:GITHUB_SHA} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $octantRoot 'owner.json')
  "OCTANT_WINDOWS_QA_ROOT=$octantRoot" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
}
if (-not $octantRoot -or
    [IO.Path]::GetDirectoryName($octantRoot) -ine $octantLocal -or
    [IO.Path]::GetFileName($octantRoot) -cnotmatch '^OctantWindowsQa-[0-9a-f-]{36}$') {
  throw 'The QA staging root identity is invalid'
}
$octantRootItem = Get-Item -LiteralPath $octantRoot -Force
if (-not $octantRootItem.PSIsContainer -or ($octantRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe QA staging root' }
$octantReceipt = Get-Content -LiteralPath (Join-Path $octantRoot 'owner.json') -Raw | ConvertFrom-Json
if ($octantReceipt.run -cne $env:GITHUB_RUN_ID -or $octantReceipt.head -cne $env:GITHUB_SHA) { throw 'The QA root belongs to another run' }
if ($Mode -eq 'Cleanup') {
  $octantPrefix = $octantRoot + [IO.Path]::DirectorySeparatorChar
  foreach ($octantProcess in @(Get-CimInstance Win32_Process)) {
    if ($octantProcess.ExecutablePath -and $octantProcess.ExecutablePath.StartsWith($octantPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing package cleanup while an owned image is still running'
    }
  }
  foreach ($octantEntry in @(Get-ChildItem -LiteralPath $octantRoot -Recurse -Force)) {
    if ($octantEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing QA cleanup through an alias' }
  }
  Remove-Item -LiteralPath $octantRoot -Recurse -Force
  if (Test-Path -LiteralPath $octantRoot) { throw 'QA package cleanup was not confirmed' }
  Write-Output '{"ownedQaPackagesAbsent":true}'
  exit 0
}
$octantSource = (Resolve-Path -LiteralPath $PackageDirectory).ProviderPath
$octantDestination = Join-Path $octantRoot $Mode
if (Test-Path -LiteralPath $octantDestination) { throw 'Refusing a pre-existing staged package' }
foreach ($octantEntry in @(Get-Item -LiteralPath $octantSource) + @(Get-ChildItem -LiteralPath $octantSource -Recurse -Force)) {
  if ($octantEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a package alias' }
}
$octantArguments = '"{0}" "{1}" /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /XJ /NFL /NDL /NJH /NJS /NP' -f $octantSource, $octantDestination
$octantCopy = Start-Process -FilePath robocopy.exe -ArgumentList $octantArguments -NoNewWindow -PassThru
try {
  if (-not $octantCopy.WaitForExit(60000)) { throw 'Owned package copy exceeded its deadline' }
  if ($octantCopy.ExitCode -ge 8) { throw 'Owned package copy failed' }
} finally {
  try {
    if (-not $octantCopy.HasExited) {
      $octantCopy.Kill($true)
      if (-not $octantCopy.WaitForExit(5000)) { throw 'Owned package copy cleanup did not join' }
    }
  } finally { $octantCopy.Dispose() }
}
$octantClock = [Diagnostics.Stopwatch]::StartNew()
$octantFiles = @(Get-ChildItem -LiteralPath $octantSource -File -Recurse -Force)
$octantCopied = @(Get-ChildItem -LiteralPath $octantDestination -File -Recurse -Force)
if ($octantFiles.Count -ne $octantCopied.Count) { throw 'The staged package file count differs' }
foreach ($octantFile in $octantFiles) {
  if ($octantClock.Elapsed.TotalSeconds -gt 60) { throw 'Package content verification exceeded its deadline' }
  $octantRelative = [IO.Path]::GetRelativePath($octantSource, $octantFile.FullName)
  $octantTarget = Join-Path $octantDestination $octantRelative
  if ((Get-FileHash -LiteralPath $octantFile.FullName -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $octantTarget -Algorithm SHA256).Hash) {
    throw 'Staging changed normal package bytes'
  }
}
"OCTANT_WINDOWS_QA_$($Mode.ToUpperInvariant())=$octantDestination" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output ('{"unchangedNormalPackageStaged":true,"files":' + $octantFiles.Count + '}')
