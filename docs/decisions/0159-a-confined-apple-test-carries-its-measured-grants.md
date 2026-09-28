# 0159. A confined Apple test carries its measured grants

**Status:** Accepted

## Context

0009 denies by default and 0133 scoped an exception for discovery reads that
open named literal nodes. A `xcodebuild test` launch confined by that profile
failed far past either refusal named when it was scoped out: denial log
iteration on a host whose unconfined run passes in under a minute measured
eight refusal layers, each fatal or fatal-equivalent in turn.

- The destination reports an empty supported-platform list because the run
  cannot read `~/Library/Developer/Xcode/SDKToSimulatorIndexMapping.plist`
  (NSCocoaErrorDomain 257, POSIX 1). This is the 0133 class and is granted as
  a literal node, not a subpath.
- `IOPMAssertionCreateWithName` returns `-536870199` and the test action
  aborts: the run holds a no-idle-sleep assertion with powerd for its whole
  duration and cannot live without `mach-lookup` on
  `com.apple.PowerManagement.control`.
- The test session's unix socket lives beneath
  `/private/var/tmp/com.apple.launchd.<per-boot-session>`; denied the stat,
  the runner reports "no file was found at that path" and never connects.
  The session suffix is minted per boot, so only a regex names the family.
- `xcodebuild` allocates its own pseudo-terminal pair for the runner;
  denied `pseudo-tty` plus `file-write*`/`file-ioctl` on `/dev/ptmx` and
  `/dev/ttys<N>`, the run ends with "Pseudo Terminal Setup Error. ErrorCode: 7".
- Denied `job-creation`, the launch reports it could not launch the runner.
- The session reaches the simulator's `testmanagerd` control endpoint;
  denied `mach-lookup com.apple.testmanagerd.control` the run hangs.
- The spawned DTServiceHub helpers coordinate the runner through
  `mach-lookup com.apple.dt.instruments.dtarbiter.xpc` and
  `com.apple.dt.instruments.dtsecurity.xpc`; denied either, the test runner
  hangs "before establishing connection" until the session times out.
- The session terminates a stale copy of the target app before installing
  and again at teardown with signals aimed at processes it did not fork —
  `signal (target children)` and `signal (target self)` already granted do
  not cover it. Denied `signal`, the old instance survives and subsequent
  sessions hang at "Testing started".

None of these is a discovery read: they name XPC service endpoints, a
device-node family, process-job primitives, and inter-process signals, and
each failed as a measured refusal, not speculation. Granting any one of them
alone — including the 0133-class read — does not unblock the run; that was
measured directly.

## Decision

`xcodebuild test` launches remain confined, and the action splits into two
launches so the grant reaches only the phase that needs it:
`build-for-testing` runs under the ordinary profile — proven sufficient by
the `build` action, and it keeps the project's Run Script phases away from
the widened reach — while `test-without-building` carries a closed set of
per-launch grants attached through `extraRules`, never added to the shared
profile default:

- literal `file-read*` on the SDK-to-simulator index plist (0133 class)
- literal `file-read-metadata` on `/private`, `/private/var`, and
  `/private/var/tmp` — the ancestors the launchd session socket's resolved
  path needs to be reachable (0133 class)
- `file-read* file-write*` over the regex
  `^/private/var/tmp/com\.apple\.launchd\.[^/]+(/.*)?$` — the per-boot
  launchd session family and nothing outside it
- `mach-lookup` on the four measured global names above, each named
  literally
- `pseudo-tty`, plus `file-write*`/`file-ioctl` on `/dev/ptmx` and the
  `/dev/ttys<N>` family, because the launch allocates the pair itself
- `job-creation` for the runner's session job
- `signal`, untargeted, because the session's signals land on simulator-
  spawned processes that are neither self nor children of the launch

Each allowance is granted at the weakest measured spelling that unblocks
the run and is recorded here. Build-for-testing, build, run, discovery, and
every other Apple launch carry none of them.

## Consequences

- `test` joins the confined smoke end to end; it is no longer scoped out.
- The grant surface is per-launch: a future xcodebuild change that needs
  more of the host fails as a new measured refusal and takes its own record
  per 0133 rather than silently widening this set.
- `signal` is the broadest grant here — untargeted signalling of the whole
  user session. It is admitted because the measured alternative is a hung
  session, and because the signal-bearing launch still cannot read the
  user's files, open the network, or leave its bound root.
- Xcode's `IDETestProgressNotification` distributed-notification post stays
  denied on purpose: the denial is cosmetic to a CLI run, and re-allowing it
  would open the broadcast channel with no caller that needs it.

## Related

- 0009 Sandbox confinement, approvals, and Plan mode
- 0133 Confined discovery reads open named nodes, never trees
