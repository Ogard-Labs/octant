# Fetch the pinned NSIS release for this job and point OCTANT_MAKENSIS at it.
#
# The hosted Windows images carry no NSIS, so CI and the release workflow
# download one exact zip and refuse it unless its SHA-256 matches. The hash was
# taken from the file and its MD5 matched the one SourceForge lists for it.
$ErrorActionPreference = 'Stop'
$octantNsisVersion = '3.11'
$octantNsisSha256 = 'C7D27F780DDB6CFFB4730138CD1591E841F4B7EDB155856901CDF5F214394FA1'
$octantNsisUrl = "https://downloads.sourceforge.net/project/nsis/NSIS%203/$octantNsisVersion/nsis-$octantNsisVersion.zip"
$octantNsisRoot = Join-Path $env:RUNNER_TEMP "octant-nsis-$octantNsisVersion"
if (Test-Path -LiteralPath $octantNsisRoot) { throw 'Refusing a pre-existing NSIS folder' }
[void](New-Item -ItemType Directory -Path $octantNsisRoot)
$octantNsisZip = Join-Path $octantNsisRoot 'nsis.zip'
$octantAttempt = 0
while ($true) {
  $octantAttempt += 1
  try {
    Invoke-WebRequest -Uri $octantNsisUrl -OutFile $octantNsisZip -UserAgent 'curl/8' -MaximumRedirection 10
    break
  } catch {
    # SourceForge redirects to a mirror, and a mirror is sometimes slow to answer.
    if ($octantAttempt -ge 3) { throw }
    Start-Sleep -Seconds (5 * $octantAttempt)
  }
}
$octantActual = (Get-FileHash -LiteralPath $octantNsisZip -Algorithm SHA256).Hash
if ($octantActual -cne $octantNsisSha256) { throw "NSIS download hash $octantActual is not the pinned one" }
Expand-Archive -LiteralPath $octantNsisZip -DestinationPath $octantNsisRoot
$octantMakensis = Join-Path $octantNsisRoot "nsis-$octantNsisVersion/makensis.exe"
if (-not (Test-Path -LiteralPath $octantMakensis)) { throw 'The NSIS archive has no makensis' }
& $octantMakensis -VERSION
if ($LASTEXITCODE -ne 0) { throw 'makensis did not run' }
"OCTANT_MAKENSIS=$octantMakensis" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
