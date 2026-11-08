param([Parameter(Mandatory=$true)][string]$Launcher,
  [Parameter(Mandatory=$true)][string]$PackageDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$NightlyPackageDirectory = '',
  [switch]$HostOnlyControl)
$ErrorActionPreference = 'Stop'
if ($HostOnlyControl -and $NightlyPackageDirectory) { throw 'The host-only diagnostic control does not run Nightly' }
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
$octantFailure = $null
$octantColdFailure = $false
$octantCleanupConfirmed = $false
try {
  $octantPhases = if ($HostOnlyControl) { @('host-only-control') } elseif ($NightlyPackageDirectory) { @('nightly', 'nightly-cold') } else { @('owned', 'attached') }
  foreach ($octantPhase in $octantPhases) {
    $octantArguments = @('--profile-user-owner', $octantBun, 'scripts/smoke-windows-desktop.ts', $PackageDirectory, $octantPhase, $OutputDirectory)
    if ($NightlyPackageDirectory) { $octantArguments += $NightlyPackageDirectory }
    $octantJoined = $false
    $octantResult = @(& $Launcher @octantArguments)
    $octantCode = $LASTEXITCODE
    $octantResult | Write-Output
    $octantJoined = ($octantResult -join "`n") -match '"ownedJobJoined":true'
    if ($octantCode -ne 0 -or -not $octantJoined) {
      $octantColdFailure = $octantPhase -eq 'nightly-cold'
      throw 'The owned native desktop phase failed or did not join its job'
    }
  }
} catch {
  $octantFailure = $_
} finally {
  if (-not $octantJoined) { throw 'Refusing profile removal before owned processes joined' }
  foreach ($octantScheme in $octantProtocols.Keys) {
    $octantProtocol = "HKCU:\Software\Classes\$octantScheme"
    if (-not (Test-Path -LiteralPath $octantProtocol)) { continue }
    $octantExecutable = $octantProtocols[$octantScheme]
    $octantCommand = [string](Get-Item -LiteralPath "$octantProtocol\shell\open\command").GetValue('')
    $octantPathSpellings = @($octantExecutable)
    if ($octantExecutable -match '^[A-Za-z]:\\') { $octantPathSpellings += '\\?\' + $octantExecutable }
    $octantExpected = @()
    $octantExpectedImageArgument = @()
    $octantQuotedUrlPattern = [regex]::Escape('"%1"')
    foreach ($octantPath in $octantPathSpellings) {
      foreach ($octantImage in @($octantPath, '"' + $octantPath + '"')) {
        $octantExpected += $octantImage + ' "%1"'
        $octantExpected += $octantImage + ' -- "%1"'
        # Electron may repeat its staged image as one explicit argument.
        foreach ($octantArgumentPath in $octantPathSpellings) {
          foreach ($octantArgumentImage in @($octantArgumentPath, '"' + $octantArgumentPath + '"')) {
            $octantExpectedImageArgument += '\A' + [regex]::Escape($octantImage) + '[ \t]+' + [regex]::Escape($octantArgumentImage) + '(?:[ \t]+--)?[ \t]+' + $octantQuotedUrlPattern + '\z'
            if ($octantImage.StartsWith('"') -and $octantImage.EndsWith('"')) {
              $octantExpectedImageArgument += '\A' + [regex]::Escape($octantImage) + [regex]::Escape($octantArgumentImage) + '[ \t]+' + $octantQuotedUrlPattern + '\z'
            }
          }
        }
      }
    }
    $octantTrimmedCommand = $octantCommand.Trim()
    $octantOwnedCommand = $octantExpected -icontains $octantTrimmedCommand
    if (-not $octantOwnedCommand) {
      $octantRegexOptions = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
      foreach ($octantPattern in $octantExpectedImageArgument) {
        if ([regex]::IsMatch($octantTrimmedCommand, $octantPattern, $octantRegexOptions)) {
          $octantOwnedCommand = $true
          break
        }
      }
    }
    if (-not $octantOwnedCommand) {
      foreach ($octantPath in $octantPathSpellings) {
        foreach ($octantImage in @($octantPath, '"' + $octantPath + '"')) {
          if (-not $octantTrimmedCommand.StartsWith($octantImage, [StringComparison]::OrdinalIgnoreCase)) { continue }
          $octantArguments = $octantTrimmedCommand.Substring($octantImage.Length)
          if (
            $octantArguments -match '^\s+"%1"\s*$' -or
            $octantArguments -match '^\s+--\s+"%1"\s*$'
          ) {
            $octantOwnedCommand = $true
            break
          }
          $octantArgumentTokens = [System.Collections.Generic.List[string]]::new()
          foreach ($octantArgumentMatch in [regex]::Matches($octantArguments, '"[^"]*"|\S+')) {
            [void]$octantArgumentTokens.Add([string]$octantArgumentMatch.Value)
          }
          if ($octantArgumentTokens.Count -eq 4) {
            $octantArgumentPathOne = [string]$octantArgumentTokens[0]
            $octantArgumentPathTwo = [string]$octantArgumentTokens[2]
            if ($octantArgumentPathOne.StartsWith('"') -and $octantArgumentPathOne.EndsWith('"')) {
              $octantArgumentPathOne = $octantArgumentPathOne.Substring(1, $octantArgumentPathOne.Length - 2)
            }
            if ($octantArgumentPathTwo.StartsWith('"') -and $octantArgumentPathTwo.EndsWith('"')) {
              $octantArgumentPathTwo = $octantArgumentPathTwo.Substring(1, $octantArgumentPathTwo.Length - 2)
            }
            $octantArgumentPathOneIsOwned = $false
            $octantArgumentPathTwoIsOwned = $false
            foreach ($octantArgumentPath in $octantPathSpellings) {
              if ([string]::Equals($octantArgumentPath, $octantArgumentPathOne, [StringComparison]::OrdinalIgnoreCase)) {
                $octantArgumentPathOneIsOwned = $true
              }
              if ([string]::Equals($octantArgumentPath, $octantArgumentPathTwo, [StringComparison]::OrdinalIgnoreCase)) {
                $octantArgumentPathTwoIsOwned = $true
              }
            }
            if (
              $octantArgumentPathOneIsOwned -and
              $octantArgumentTokens[1] -ceq '"%1"' -and
              $octantArgumentPathTwoIsOwned -and
              $octantArgumentTokens[3] -ceq '"%1"'
            ) {
              $octantOwnedCommand = $true
              break
            }
          }
        }
        if ($octantOwnedCommand) { break }
      }
    }
    if (-not $octantOwnedCommand) {
      $octantImageShape = 'other'
      $octantImageAtStart = $false
      $octantArgumentLayout = 'image-not-leading'
      $octantArgumentTokenShapes = @()
      $octantArgumentPathShapes = @()
      $octantArgumentPathKinds = @()
      $octantArgumentQuotedUrlMatches = @()
      $octantArgumentTokenCount = 0
      $octantExactStagedImageUrlSequence = $false
      $octantLeadingSeparatorKind = 'image-not-leading'
      $octantInternalSeparatorKinds = @()
      $octantTrimmedCommand = $octantCommand.Trim()
      $octantPackageAppRoot = [IO.Path]::GetFullPath((Join-Path $PackageDirectory 'resources/app'))
      $octantPackageAppEntry = [IO.Path]::GetFullPath((Join-Path $octantPackageAppRoot 'apps/desktop/dist/entry.mjs'))
      $octantPackageRoot = [IO.Path]::GetFullPath($PackageDirectory).TrimEnd([char]92, [char]47) + [IO.Path]::DirectorySeparatorChar
      foreach ($octantPath in $octantPathSpellings) {
        if ($octantCommand.IndexOf($octantPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $octantImageShape = if ($octantPath.StartsWith('\\?\')) { 'staged-namespaced' } else { 'staged-ordinary' }
        }
        foreach ($octantImage in @($octantPath, '"' + $octantPath + '"')) {
          if (-not $octantTrimmedCommand.StartsWith($octantImage, [StringComparison]::OrdinalIgnoreCase)) { continue }
          $octantImageAtStart = $true
          $octantArgumentTail = $octantTrimmedCommand.Substring($octantImage.Length)
          $octantLeadingSeparatorLength = $octantArgumentTail.Length - $octantArgumentTail.TrimStart().Length
          $octantLeadingSeparatorText = $octantArgumentTail.Substring(0, $octantLeadingSeparatorLength)
          $octantLeadingSeparatorKind = if ($octantLeadingSeparatorText.Length -eq 0) {
            'none'
          } elseif ($octantLeadingSeparatorText -match '^ +$') {
            'space'
          } elseif ($octantLeadingSeparatorText -match '^\t+$') {
            'tab'
          } elseif ($octantLeadingSeparatorText -match '^\s+$') {
            'other-whitespace'
          } else {
            'non-whitespace'
          }
          $octantArguments = $octantArgumentTail.Trim()
          $octantArgumentLayout = if ($octantArguments -eq '"%1"') {
            'url-only'
          } elseif ($octantArguments -match '^--\s+"%1"$') {
            'electron-url'
          } else {
            'extra-or-other-argument'
          }
          $octantDiagnosticTokens = [System.Collections.Generic.List[string]]::new()
          $octantDiagnosticMatches = [regex]::Matches($octantArguments, '"[^"]*"|\S+')
          foreach ($octantDiagnosticMatch in $octantDiagnosticMatches) {
            [void]$octantDiagnosticTokens.Add([string]$octantDiagnosticMatch.Value)
          }
          $octantArgumentTokenCount = $octantDiagnosticTokens.Count
          $octantInternalSeparatorKinds = @()
          for ($octantSeparatorIndex = 1; $octantSeparatorIndex -lt $octantDiagnosticMatches.Count; $octantSeparatorIndex++) {
            $octantPreviousMatch = $octantDiagnosticMatches[$octantSeparatorIndex - 1]
            $octantCurrentMatch = $octantDiagnosticMatches[$octantSeparatorIndex]
            $octantSeparatorStart = $octantPreviousMatch.Index + $octantPreviousMatch.Length
            $octantSeparatorText = $octantArguments.Substring($octantSeparatorStart, $octantCurrentMatch.Index - $octantSeparatorStart)
            $octantInternalSeparatorKind = if ($octantSeparatorText.Length -eq 0) {
              'none'
            } elseif ($octantSeparatorText -match '^ +$') {
              'space'
            } elseif ($octantSeparatorText -match '^\t+$') {
              'tab'
            } elseif ($octantSeparatorText -match '^\s+$') {
              'other-whitespace'
            } else {
              'non-whitespace'
            }
            $octantInternalSeparatorKinds += $octantInternalSeparatorKind
          }
          $octantArgumentQuotedUrlMatches = @($octantDiagnosticTokens | ForEach-Object {
            [string]::Equals([string]$_, '"%1"', [StringComparison]::Ordinal)
          })
          foreach ($octantToken in $octantDiagnosticTokens) {
            $octantUnquotedToken = $octantToken.Trim('"')
            $octantTokenShape = if ($octantToken -ceq '"%1"') {
              'quoted-url'
            } elseif ($octantUnquotedToken -ceq '--') {
              'electron-separator'
            } elseif ($octantUnquotedToken.Equals($octantPackageAppEntry, [StringComparison]::OrdinalIgnoreCase)) {
              'owned-app-entry'
            } elseif ($octantUnquotedToken.Equals($octantPackageAppRoot, [StringComparison]::OrdinalIgnoreCase)) {
              'owned-app-root'
            } elseif ($octantUnquotedToken -match '^--[A-Za-z0-9][A-Za-z0-9_-]*(?:=.*)?$') {
              'option'
            } elseif ($octantUnquotedToken -match '^[A-Za-z]:\\' -or $octantUnquotedToken.StartsWith('\\?\')) {
              $octantCandidatePath = $octantUnquotedToken
              if ($octantCandidatePath.StartsWith('\\?\')) { $octantCandidatePath = $octantCandidatePath.Substring(4) }
              $octantCandidatePath = [IO.Path]::GetFullPath($octantCandidatePath)
              if ($octantCandidatePath.StartsWith($octantPackageRoot, [StringComparison]::OrdinalIgnoreCase)) {
                if ($octantArgumentPathShapes.Count -lt 8) {
                  $octantArgumentPathShapes += [IO.Path]::GetRelativePath($octantPackageRoot, $octantCandidatePath)
                }
              } elseif ($octantArgumentPathShapes.Count -lt 8) {
                $octantArgumentPathShapes += 'outside-staged-package'
              }
              'path-argument'
            } elseif ($octantToken.StartsWith('"') -and $octantToken.EndsWith('"')) {
              'quoted-argument'
            } else {
              'other-argument'
            }
            if ($octantArgumentTokenShapes.Count -lt 8) { $octantArgumentTokenShapes += $octantTokenShape }
            if ($octantTokenShape -eq 'path-argument' -and $octantArgumentPathKinds.Count -lt 8) {
              $octantPathIsExactStagedImage = $false
              foreach ($octantPathSpelling in $octantPathSpellings) {
                if ([string]::Equals($octantPathSpelling, $octantUnquotedToken, [StringComparison]::OrdinalIgnoreCase)) {
                  $octantPathIsExactStagedImage = $true
                  break
                }
              }
              $octantPathKind = if ($octantPathIsExactStagedImage) { 'staged-executable' } else { 'other-path' }
              $octantArgumentPathKinds += $octantPathKind
            }
          }
          $octantArgumentTokenCount = $octantArgumentTokenShapes.Count
          $octantExactStagedImageUrlSequence =
            $octantArgumentPathKinds.Count -eq 1 -and
            $octantArgumentPathKinds[0] -eq 'staged-executable' -and
            (
              ($octantDiagnosticTokens.Count -eq 2 -and $octantDiagnosticTokens[1] -ceq '"%1"') -or
              ($octantDiagnosticTokens.Count -eq 3 -and $octantDiagnosticTokens[1] -ceq '--' -and $octantDiagnosticTokens[2] -ceq '"%1"')
            )
          break
        }
        if ($octantImageAtStart) { break }
      }
      $octantArgumentShape = if ($octantCommand.EndsWith('"%1"', [StringComparison]::OrdinalIgnoreCase)) { 'quoted-url' } else { 'other' }
      $octantSeparator = $octantCommand.Contains(' -- ')
      Write-Output (@{
        protocolCleanup = 'refused'
        executable = $octantImageShape
        executableAtStart = $octantImageAtStart
        argumentLayout = $octantArgumentLayout
        argumentTokenShapes = $octantArgumentTokenShapes
        argumentPathShapes = $octantArgumentPathShapes
        argumentPathKinds = $octantArgumentPathKinds
        argumentQuotedUrlMatches = $octantArgumentQuotedUrlMatches
        argumentTokenCount = $octantArgumentTokenCount
        exactStagedImageUrlSequence = $octantExactStagedImageUrlSequence
        imageQuoted = $octantImage.StartsWith('"') -and $octantImage.EndsWith('"')
        imageToArgumentsSeparator = $octantLeadingSeparatorKind
        argumentInternalSeparators = $octantInternalSeparatorKinds
        commandHadOuterWhitespace = $octantCommand -cne $octantCommand.Trim()
        argument = $octantArgumentShape
        electronSeparator = $octantSeparator
      } | ConvertTo-Json -Compress)
      throw 'Refusing removal of another protocol command'
    }
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
    $octantCleanupConfirmed = $true
  } elseif (Test-Path -LiteralPath $octantProfile) {
    throw 'Owned profile cleanup could not be authenticated without its scope receipt'
  }
}
if ($null -ne $octantFailure) {
  # A separate fresh-profile comparison can retain early stderr that the
  # production no-inherited-handle launch cannot. It never clears the failure.
  if ($octantColdFailure -and $octantJoined -and $octantCleanupConfirmed -and -not $HostOnlyControl) {
    try {
      & $PSCommandPath -Launcher $Launcher -PackageDirectory $PackageDirectory -OutputDirectory (Join-Path $OutputDirectory 'host-only-control') -HostOnlyControl
    } catch {
      Write-Output '{"hostOnlyDiagnosticControl":"failed"}'
    }
  }
  throw $octantFailure
}
