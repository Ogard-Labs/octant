param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
  [string]$Scope,
  [Parameter(Mandatory = $true)]
  [ValidateSet('directory-acl', 'process-query')]
  [string]$Mode,
  [int]$TargetProcessId = 0,
  [int]$ReaderProcessId = 0,
  [ValidatePattern('^win32:[0-9a-f]{16}$')]
  [string]$ReaderBirth
)
$ErrorActionPreference = 'Stop'
$octantRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Octant\runtime\$Scope"
$octantNode = Get-Item -LiteralPath $octantRoot -Force
if (-not $octantNode.PSIsContainer -or ($octantNode.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe owned fixture scope' }
$octantAcl = Get-Acl -LiteralPath $octantRoot
$octantUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($octantAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $octantUser.Value) { throw 'Fixture is not owned by this account' }
if ($Mode -eq 'directory-acl') {
  $octantWorld = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
  $octantRule = [Security.AccessControl.FileSystemAccessRule]::new($octantWorld, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.AccessControlType]::Allow)
  # Modify only this owned directory's DACL. Set-Acl can also persist audit
  # information and incorrectly require a privilege this reader must not have.
  $octantAccess = [Security.AccessControl.DirectorySecurity]::new($octantRoot, [Security.AccessControl.AccessControlSections]::Access)
  $octantAccess.AddAccessRule($octantRule)
  [IO.Directory]::SetAccessControl($octantRoot, $octantAccess)
  exit 0
}
# Only a child whose private native record matches its actual creation time
# can have its own process object's query permission changed by this fixture.
$octantHeader = [byte[]]::new(24)
$octantFile = [IO.File]::Open((Join-Path $octantRoot 'owner.bin'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try { if ($octantFile.Read($octantHeader, 0, 24) -ne 24) { throw 'Short owned fixture record' } } finally { $octantFile.Dispose() }
if ([Text.Encoding]::ASCII.GetString($octantHeader, 0, 8) -ne 'OCTOWN01' -or [BitConverter]::ToUInt32($octantHeader, 8) -ne $TargetProcessId -or $TargetProcessId -le 0) { throw 'Not the recorded owned child' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class OctantOwnedProcessFixture {
  [StructLayout(LayoutKind.Sequential)] public struct Time { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count; public uint Control; public Luid Identity; public uint Attributes; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out Time created, out Time exited, out Time kernel, out Time user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr handle, uint info, byte[] descriptor, uint size, out uint needed);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, byte[] descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid value);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool PrivilegeCheck(IntPtr token, ref Privilege privileges, out bool enabled);
  public static void InspectReader(uint readerPid, uint low, uint high, uint targetPid) {
    IntPtr reader = OpenProcess(0x1000, false, readerPid);
    if (reader == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Time created, exited, kernel, user;
      if (!GetProcessTimes(reader, out created, out exited, out kernel, out user) || created.Low != low || created.High != high) throw new InvalidOperationException("Owned reader birth changed");
      IntPtr token;
      if (!OpenProcessToken(reader, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      bool enabled;
      try {
        Luid debug;
        if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out debug)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Privilege requested = new Privilege { Count = 1, Control = 1, Identity = debug, Attributes = 2 };
        if (!PrivilegeCheck(token, ref requested, out enabled)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { CloseHandle(token); }
      IntPtr target = OpenProcess(0x00101000, false, targetPid);
      int error = target == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
      if (target != IntPtr.Zero) CloseHandle(target);
      Console.WriteLine("{\"ownedReaderDebugEnabled\":" + (enabled ? "true" : "false") + ",\"fixtureQueryError\":" + error + "}");
    } finally { CloseHandle(reader); }
  }
  public static void RefuseQuery(uint pid, uint low, uint high) {
    IntPtr process = OpenProcess(0x00040000 | 0x00020000 | 0x1000, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Time created, exited, kernel, user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || created.Low != low || created.High != high) throw new InvalidOperationException("Owned child birth changed");
      uint needed;
      GetKernelObjectSecurity(process, 4, null, 0, out needed);
      if (needed == 0 || needed > 65536) throw new InvalidOperationException("Invalid owned process security size");
      byte[] encoded = new byte[needed];
      if (!GetKernelObjectSecurity(process, 4, encoded, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      RawSecurityDescriptor descriptor = new RawSecurityDescriptor(encoded, 0);
      if (descriptor.DiscretionaryAcl == null) throw new InvalidOperationException("No owned process DACL");
      descriptor.DiscretionaryAcl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessDenied, 0x00101000, new SecurityIdentifier(WellKnownSidType.WorldSid, null), false, null));
      encoded = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(encoded, 0);
      if (!SetKernelObjectSecurity(process, 4, encoded)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(process); }
  }
}
'@
[OctantOwnedProcessFixture]::RefuseQuery([uint32]$TargetProcessId, [BitConverter]::ToUInt32($octantHeader, 12), [BitConverter]::ToUInt32($octantHeader, 16))
if ($ReaderProcessId -le 0 -or -not $ReaderBirth) { throw 'Owned reader identity missing' }
[OctantOwnedProcessFixture]::InspectReader([uint32]$ReaderProcessId, [Convert]::ToUInt32($ReaderBirth.Substring(14, 8), 16), [Convert]::ToUInt32($ReaderBirth.Substring(6, 8), 16), [uint32]$TargetProcessId)
