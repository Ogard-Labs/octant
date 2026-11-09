param([ValidateSet('hold', 'unsafe', 'abandoned')][string]$Mode)
$ErrorActionPreference = 'Stop'
# This disposable fixture holds only the fixed mutex for the runner's own user.
# It never changes the token, account, vault data, or host security settings.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class OctantCredentialCoordination {
  [StructLayout(LayoutKind.Sequential)]
  struct Attributes { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint version, out IntPtr descriptor, IntPtr length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateMutexEx(ref Attributes attributes, string name, uint flags, uint access);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static void Run(string mode) {
    string sid;
    using (var identity = WindowsIdentity.GetCurrent()) {
      if (identity.User == null) throw new InvalidOperationException();
      sid = identity.User.Value;
    }
    string policy = "O:" + sid + "D:P(A;;0x001f0001;;;" + sid + ")(A;;0x001f0001;;;SY)";
    if (mode == "unsafe") policy += "(A;;0x001f0001;;;WD)";
    IntPtr descriptor;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptor(policy, 1, out descriptor, IntPtr.Zero))
      throw new InvalidOperationException();
    IntPtr handle;
    try {
      var attributes = new Attributes {length=Marshal.SizeOf(typeof(Attributes)), descriptor=descriptor, inherit=0};
      handle = CreateMutexEx(ref attributes, "Global\\Octant.credentials.v1." + sid, 0, 0x001f0001);
    } finally { LocalFree(descriptor); }
    if (handle == IntPtr.Zero) throw new InvalidOperationException();
    using (var mutex = new Mutex()) {
      var previous = mutex.SafeWaitHandle;
      mutex.SafeWaitHandle = new SafeWaitHandle(handle, true);
      previous.Dispose();
      bool held = false;
      try {
        if (mode == "hold") { held = mutex.WaitOne(1000); if (!held) throw new InvalidOperationException(); }
        if (mode == "abandoned") {
          // The main thread retains the handle after its owner thread dies.
          var owner = new Thread(() => { mutex.WaitOne(); });
          owner.IsBackground = true;
          owner.Start();
          if (!owner.Join(2000)) throw new InvalidOperationException();
        }
        Console.WriteLine("ready");
        Console.Out.Flush();
        if (!System.Threading.Tasks.Task.Run(() => Console.In.ReadLine()).Wait(20000)) throw new InvalidOperationException();
      } finally { if (held) mutex.ReleaseMutex(); }
    }
  }
}
'@
try { [OctantCredentialCoordination]::Run($Mode) }
catch { Write-Output 'fixture-failed'; exit 1 }
