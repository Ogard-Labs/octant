param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('octant', 'nightly-test-data')]
  [string]$Profile,
  [Parameter(Mandatory = $true)]
  [ValidateSet('inspect', 'unsafe', 'restore', 'prepare-data')]
  [string]$Mode
)
$ErrorActionPreference = 'Stop'
$octantRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Octant\hosts\$Profile"
$octantNode = Get-Item -LiteralPath $octantRoot -Force
if (-not $octantNode.PSIsContainer -or ($octantNode.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe owned profile fixture' }
$octantUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
$octantAcl = [Security.AccessControl.DirectorySecurity]::new($octantRoot, [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
if ($octantAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $octantUser.Value) { throw 'Profile fixture has another owner' }
if ($Mode -eq 'prepare-data') {
  $octantData = Join-Path $octantRoot 'data'
  if (Test-Path -LiteralPath $octantData) { throw 'Owned replacement must be absent before creation' }
  $octantPrivate = [Security.AccessControl.DirectorySecurity]::new()
  $octantPrivate.SetOwner($octantUser)
  $octantPrivate.SetAccessRuleProtection($true, $false)
  foreach ($octantSid in @($octantUser, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $octantPrivate.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($octantSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  [void][IO.Directory]::CreateDirectory($octantData, $octantPrivate)
  $octantMade = Get-Item -LiteralPath $octantData -Force
  if (-not $octantMade.PSIsContainer -or ($octantMade.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe owned replacement fixture' }
  $octantVerified = [Security.AccessControl.DirectorySecurity]::new($octantData, [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner)
  $octantVerifiedRules = @($octantVerified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $octantVerified.AreAccessRulesProtected -or $octantVerified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $octantUser.Value -or $octantVerifiedRules.Count -ne 2) { throw 'Replacement is not privately user-owned' }
  $octantVerifiedSids = @()
  foreach ($octantRule in $octantVerifiedRules) {
    if ($octantRule.IsInherited -or $octantRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $octantRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or [int]$octantRule.InheritanceFlags -ne 3 -or [int]$octantRule.PropagationFlags -ne 0) { throw 'Unexpected replacement grant' }
    $octantVerifiedSids += $octantRule.IdentityReference.Value
  }
  if ($octantVerifiedSids -notcontains $octantUser.Value -or $octantVerifiedSids -notcontains 'S-1-5-18') { throw 'Replacement grants another principal' }
  Write-Output '{"ownedReplacementHasExactPrivateOwnerAndDacl":true}'
  exit 0
}
if ($Mode -eq 'inspect') {
  foreach ($octantPath in @((Join-Path $octantRoot 'data\proof'), (Join-Path $octantRoot 'data\proof\written.txt'))) {
    $octantEntry = Get-Item -LiteralPath $octantPath -Force
    if ($octantEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Aliased owned descendant' }
    if ($octantEntry.PSIsContainer) { $octantAccess = [Security.AccessControl.DirectorySecurity]::new($octantPath, [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner) }
    else { $octantAccess = [Security.AccessControl.FileSecurity]::new($octantPath, [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner) }
    $octantRules = @($octantAccess.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $octantOwner = $octantAccess.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $octantDiagnostic = @{
      descendantKind = $(if ($octantEntry.PSIsContainer) { 'directory' } else { 'file' })
      ownerSid = $octantOwner
      userSid = $octantUser.Value
      protectedDacl = $octantAccess.AreAccessRulesProtected
      ruleCount = $octantRules.Count
      rules = @($octantRules | Select-Object -First 8 | ForEach-Object { @{
        sid = $_.IdentityReference.Value
        inherited = $_.IsInherited
        rights = [int64]$_.FileSystemRights
        inheritance = [int]$_.InheritanceFlags
        propagation = [int]$_.PropagationFlags
        access = [int]$_.AccessControlType
      } })
    }
    Write-Output ($octantDiagnostic | ConvertTo-Json -Depth 4 -Compress)
    if ($octantAccess.AreAccessRulesProtected -or $octantAccess.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $octantUser.Value -or $octantRules.Count -ne 2) { throw 'Descendant did not inherit only private access' }
    $octantIdentities = @()
    foreach ($octantRule in $octantRules) {
      if (-not $octantRule.IsInherited -or $octantRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $octantRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected descendant grant' }
      $octantIdentities += $octantRule.IdentityReference.Value
    }
    if ($octantIdentities -notcontains $octantUser.Value -or $octantIdentities -notcontains 'S-1-5-18') { throw 'Descendant grants another account' }
  }
  Write-Output '{"ordinaryDescendantsInheritOnlyUserAndSystem":true}'
  exit 0
}
$octantAccess = [Security.AccessControl.DirectorySecurity]::new($octantRoot, [Security.AccessControl.AccessControlSections]::Access)
if ($Mode -eq 'unsafe') {
  $octantWorld = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $octantAccess.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($octantWorld, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.AccessControlType]::Allow))
} else {
  foreach ($octantRule in @($octantAccess.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { [void]$octantAccess.RemoveAccessRuleSpecific($octantRule) }
  $octantAccess.SetAccessRuleProtection($true, $false)
  foreach ($octantSid in @($octantUser, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $octantAccess.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($octantSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
}
[IO.Directory]::SetAccessControl($octantRoot, $octantAccess)
