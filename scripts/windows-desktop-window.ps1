param([Parameter(Mandatory=$true)][int]$OwnedPid,
  [Parameter(Mandatory=$true)][string]$Executable,
  [string]$ExpectedBirth = '',
  [string]$CapturePath = '',
  [Parameter(Mandatory=$true)][ValidateSet('observe','close','host-only','exited','child-observe')][string]$Mode,
  [int]$ParentPid = 0, [string]$ParentExecutable = '', [string]$ParentBirth = '',
  [string]$ChildExecutable = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OctantDesktopWindow {
  public static string Birth;
  public static IntPtr Window;
  public static int Width, Height;
  delegate bool Visit(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  public static bool Run(int pid, string executable, string expectedBirth, bool close) {
    using (var process = Process.GetProcessById(pid)) {
      if (process.HasExited || !String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
      Birth = process.StartTime.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture);
      if (!String.IsNullOrEmpty(expectedBirth) && expectedBirth != Birth) throw new InvalidOperationException();
      if (close && String.IsNullOrEmpty(expectedBirth)) throw new InvalidOperationException();
      var candidates = new List<IntPtr>();
      EnumWindows((window, data) => {
        uint owner; Rect bounds;
        GetWindowThreadProcessId(window, out owner);
        if (owner == (uint)pid && IsWindowVisible(window) && GetWindowRect(window, out bounds) && bounds.right-bounds.left>100 && bounds.bottom-bounds.top>100) candidates.Add(window);
        return true;
      }, IntPtr.Zero);
      if (candidates.Count == 0) return false;
      if (candidates.Count != 1) throw new InvalidOperationException();
      Window = candidates[0]; Rect capture;
      if (!GetWindowRect(Window, out capture)) throw new InvalidOperationException();
      Width = capture.right-capture.left; Height = capture.bottom-capture.top;
      if (Width>4096 || Height>4096) throw new InvalidOperationException();
      if (close) {
        uint owner; GetWindowThreadProcessId(candidates[0], out owner);
        if (process.HasExited || owner != (uint)pid) throw new InvalidOperationException();
        IntPtr result;
        if (SendMessageTimeoutW(candidates[0], 0x0010, IntPtr.Zero, IntPtr.Zero, 0x0002, 1000, out result) == IntPtr.Zero) throw new InvalidOperationException();
      }
      return true;
    }
  }
  public static bool OriginalExited(int pid, string executable, string expectedBirth) {
    if (String.IsNullOrEmpty(expectedBirth)) throw new InvalidOperationException();
    try {
      using (var process = Process.GetProcessById(pid)) {
        if (process.HasExited || process.StartTime.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture) != expectedBirth) return true;
        if (!String.Equals(process.MainModule.FileName, executable, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        return false;
      }
    } catch (ArgumentException) { return true; }
  }
  public static bool Capture(IntPtr dc, int pid) {
    using (var process=Process.GetProcessById(pid)) {
      uint owner; GetWindowThreadProcessId(Window, out owner);
      if (process.HasExited || owner!=(uint)pid || process.StartTime.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture)!=Birth) throw new InvalidOperationException();
      return PrintWindow(Window, dc, 2);
    }
  }
}
'@
try {
  if ($Mode -eq 'exited') {
    $octantGone = [OctantDesktopWindow]::OriginalExited($OwnedPid, $Executable, $ExpectedBirth)
    [Console]::WriteLine((@{ originalExited=$octantGone } | ConvertTo-Json -Compress))
    exit 0
  }
  if ($Mode -eq 'host-only') {
    if ($ParentPid -le 0 -or -not $ParentExecutable -or -not $ParentBirth -or -not $ExpectedBirth) { throw 'Supply the owned launch ancestry' }
    [void][OctantDesktopWindow]::Run($OwnedPid, $Executable, $ExpectedBirth, $false)
    $octantServerInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnedPid"
    if ($null -eq $octantServerInfo -or $octantServerInfo.ParentProcessId -le 0) { throw 'Owned server ancestry unavailable' }
    $octantGuiPid = [int]$octantServerInfo.ParentProcessId
    $octantGuiInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$octantGuiPid"
    if ($null -eq $octantGuiInfo -or $octantGuiInfo.ParentProcessId -ne $ParentPid) { throw 'Owned GUI ancestry changed' }
    [void][OctantDesktopWindow]::Run($ParentPid, $ParentExecutable, $ParentBirth, $false)
    if ([OctantDesktopWindow]::Run($octantGuiPid, $Executable, '', $false)) { throw 'The host-only launch opened an ordinary window' }
    $octantGuiBirth = [OctantDesktopWindow]::Birth
    if ([UInt64]$octantGuiBirth -lt [UInt64]$ParentBirth -or [UInt64]$octantGuiBirth -gt [UInt64]$ExpectedBirth) { throw 'Owned process birth order changed' }
    [void][OctantDesktopWindow]::Run($OwnedPid, $Executable, $ExpectedBirth, $false)
    [void][OctantDesktopWindow]::Run($ParentPid, $ParentExecutable, $ParentBirth, $false)
    if ([OctantDesktopWindow]::Run($octantGuiPid, $Executable, $octantGuiBirth, $false)) { throw 'The host-only window state changed' }
    [Console]::WriteLine((@{ hostOnly=$true; pid=$octantGuiPid; birth=$octantGuiBirth } | ConvertTo-Json -Compress))
    exit 0
  }
  $octantObservedPid = $OwnedPid
  $octantObservedExecutable = $Executable
  $octantObservedBirth = $ExpectedBirth
  if ($Mode -eq 'child-observe') {
    if (-not $ExpectedBirth -or -not $ChildExecutable) { throw 'Supply the exact owned parent and child image' }
    [void][OctantDesktopWindow]::Run($OwnedPid, $Executable, $ExpectedBirth, $false)
    $octantChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$OwnedPid" -OperationTimeoutSec 2)
    if ($octantChildren.Count -gt 32) { throw 'Owned child observation exceeded its bound' }
    $octantMatches = @($octantChildren | Where-Object { [String]::Equals($_.ExecutablePath, $ChildExecutable, [StringComparison]::OrdinalIgnoreCase) })
    [void][OctantDesktopWindow]::Run($OwnedPid, $Executable, $ExpectedBirth, $false)
    if ($octantMatches.Count -eq 0) {
      [Console]::WriteLine('{"childObserved":false}')
      exit 0
    }
    if ($octantMatches.Count -ne 1) { throw 'Owned child observation is ambiguous' }
    $octantObservedPid = [int]$octantMatches[0].ProcessId
    $octantObservedExecutable = $ChildExecutable
    [void][OctantDesktopWindow]::Run($octantObservedPid, $ChildExecutable, '', $false)
    $octantObservedBirth = [OctantDesktopWindow]::Birth
    if ([UInt64]$octantObservedBirth -lt [UInt64]$ExpectedBirth) { throw 'Owned child birth precedes its parent' }
    $octantChildInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$octantObservedPid" -OperationTimeoutSec 2
    if ($null -eq $octantChildInfo -or $octantChildInfo.ParentProcessId -ne $OwnedPid) { throw 'Owned child ancestry changed' }
  }
  $renderedWelcome = $false
  $found = [OctantDesktopWindow]::Run($octantObservedPid, $octantObservedExecutable, $octantObservedBirth, $Mode -eq 'close')
  if ($found -and ($Mode -eq 'observe' -or $Mode -eq 'child-observe')) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $octantWindow = [OctantDesktopWindow]::Window
    $octantRoot = [Windows.Automation.AutomationElement]::FromHandle($octantWindow)
    if ($null -eq $octantRoot -or $octantRoot.Current.ProcessId -ne $octantObservedPid -or $octantRoot.Current.NativeWindowHandle -ne $octantWindow.ToInt32()) { throw 'Owned accessibility root refused' }
    foreach ($octantLabel in @('Welcome to Octant', 'Your first task')) {
      $octantName = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $octantLabel)
      $octantVisible = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsOffscreenProperty, $false)
      $octantCondition = [Windows.Automation.AndCondition]::new($octantName, $octantVisible)
      if ($null -ne $octantRoot.FindFirst([Windows.Automation.TreeScope]::Descendants, $octantCondition)) { $renderedWelcome = $true; break }
    }
    if (-not [OctantDesktopWindow]::Run($octantObservedPid, $octantObservedExecutable, [OctantDesktopWindow]::Birth, $false) -or [OctantDesktopWindow]::Window -ne $octantWindow) { throw 'Owned accessibility window changed' }
    if (-not $CapturePath) { throw 'Supply the owned capture path' }
    Add-Type -AssemblyName System.Drawing
    $octantBitmap = [Drawing.Bitmap]::new([OctantDesktopWindow]::Width, [OctantDesktopWindow]::Height)
    $octantGraphics = [Drawing.Graphics]::FromImage($octantBitmap)
    try {
      $octantDc = $octantGraphics.GetHdc()
      try { if (-not [OctantDesktopWindow]::Capture($octantDc, $octantObservedPid)) { throw 'Owned capture refused' } }
      finally { $octantGraphics.ReleaseHdc($octantDc) }
      $octantBitmap.Save($CapturePath, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $octantGraphics.Dispose(); $octantBitmap.Dispose() }
  }
  if ($Mode -eq 'child-observe') {
    [void][OctantDesktopWindow]::Run($octantObservedPid, $octantObservedExecutable, $octantObservedBirth, $false)
    [void][OctantDesktopWindow]::Run($OwnedPid, $Executable, $ExpectedBirth, $false)
    [Console]::WriteLine((@{ childObserved=$true; visibleOwnedWindow=$found } | ConvertTo-Json -Compress))
  } else {
    [Console]::WriteLine((@{ visibleOwnedWindow=$found; renderedWelcome=$renderedWelcome; birth=[OctantDesktopWindow]::Birth; closePosted=($found -and $Mode -eq 'close') } | ConvertTo-Json -Compress))
  }
} catch { [Console]::WriteLine('{"refused":true}'); exit 1 }
