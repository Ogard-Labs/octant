# Native Windows confinement measurements

This executable is an isolated, unshipped regression harness. It measures the
native AppContainer/LPAC and Job primitives against controlled fixture files.
It is not the production Windows launcher, credential broker, filesystem
mediator, or an approval to enable Work or Code.

On Windows with the SDK and MSVC installed:

```powershell
cmake -S scripts/windows-confinement -B "$env:TEMP/octant-confinement-build" -A x64
cmake --build "$env:TEMP/octant-confinement-build" --config Release
& "$env:TEMP/octant-confinement-build/Release/octant-windows-confinement.exe" "$env:TEMP/windows-confinement.json"
```

The hosted workflow uses an owned disposable Windows VM, no provider account,
and no real secrets. The process creates a unique AppContainer profile and a
private temporary tree with sentinel files. Only the fixture executable and
one read-only directory receive grants for that exact profile SID. ACL changes
never affect another folder or profile. A suspended child receives no network
capabilities and only two inherited control-event handles. The parent verifies
its actual AppContainer token and assigns its owned kill-on-close Job before
resuming it. The LPAC token-query result is recorded explicitly: some Windows
SDK/OS pairs reject that query with error 87. A separate ACL control compares
ordinary AppContainer access to an ALL APPLICATION PACKAGES grant against
the same access with LPAC opt-out. An unsupported token query is never described
as a successful one. Each operation has a bounded wait. Job handles are never
inherited. The descendant check retains process handles from the owned Job,
closes the Job, and waits for both processes to exit. The profile and fixture
tree are removed afterward. The workflow has a ten-minute outer deadline.

The result records each observed Win32 result separately from its expected
contract. It measures permitted existing and late-created files, ungranted
siblings, read-only writes, host reads, an owned loopback connection, and child
tree cleanup. Network setup failures and timeouts do not count as proof of an
access-denied network policy. An inherited directory grant is expected to
expose a later protected filename: that failed contract measurement identifies
the missing access-time filename policy, rather than silently accepting it.

Exit zero means the measurements ran and owned cleanup succeeded. Individual
failed contract measurements remain visible in the JSON and job summary. A
setup, compilation, execution, or cleanup failure exits nonzero. The result
always reports `productionReady: false`: even a future all-pass result would
not prove provider startup, scoped credentials, junction/short-name aliases,
handle recovery, host Full-access authority, or production filesystem policy.
No host implementation imports or packages this executable.

The primitives follow Microsoft's [AppContainer launch API](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
and [Job object limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).
The source is original fixture code, not an imported sandbox implementation.
