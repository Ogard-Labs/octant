$ErrorActionPreference = 'Stop'
# Unshipped QA only: fresh synthetic identity namespaces supplied over stdin.
# The sole imported value is the public test vector 00..1f, never a real key.
$request = [Console]::In.ReadLine() | ConvertFrom-Json
$names = ($request.PSObject.Properties.Name | Sort-Object) -join ','
if ($names -ne 'family,operation,scope' -or
    $request.family -notin @('octant', 'octant-nightly-test-data') -or
    $request.operation -notin @('seed', 'corrupt', 'remove', 'absent') -or
    $request.scope -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OctantIdentityFixture {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Credential {
    public uint flags, type;
    public string target, comment;
    public long written;
    public uint size;
    public IntPtr blob;
    public uint persist, attributeCount;
    public IntPtr attributes;
    public string alias, user;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredWriteW(ref Credential value, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr result);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
  static void Wipe(IntPtr value, uint size) {
    for (uint i=0; i<size; i++) Marshal.WriteByte(value, (int)i, 0);
  }
  public static bool Run(string operation, string family, string scope) {
    string target = "Octant/desktop-host-identity/v1/" + family + "/" + scope + "/host-identity";
    if (operation == "seed" || operation == "corrupt") {
      uint size = operation == "seed" ? 32u : 31u;
      IntPtr bytes = Marshal.AllocHGlobal((int)size);
      try {
        for (uint i=0; i<size; i++) Marshal.WriteByte(bytes, (int)i, (byte)i);
        var credential = new Credential {type=1, target=target, size=size, blob=bytes, persist=2};
        if (!CredWriteW(ref credential, 0)) throw new InvalidOperationException();
        return true;
      } finally { Wipe(bytes, size); Marshal.FreeHGlobal(bytes); }
    }
    if (operation == "remove") {
      if (!CredDeleteW(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new InvalidOperationException();
      return true;
    }
    IntPtr found;
    if (!CredReadW(target, 1, 0, out found)) {
      if (Marshal.GetLastWin32Error() != 1168) throw new InvalidOperationException();
      return true;
    }
    try { var value = (Credential)Marshal.PtrToStructure(found, typeof(Credential)); Wipe(value.blob, value.size); }
    finally { CredFree(found); }
    return false;
  }
}
'@
try {
  $result = [OctantIdentityFixture]::Run($request.operation, $request.family, $request.scope)
  if ($result) { [Console]::WriteLine('true') } else { [Console]::WriteLine('false') }
} catch { [Console]::WriteLine('fixture-failed'); exit 1 }
