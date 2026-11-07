# Native mediated-file-view feasibility

## Kernel admission implementation

`apps/server/native/linux-mediation/` contains an original, unshipped built-in
kernel admission core and its fixed-size UAPI. A context has at most 32 pending
requests, each with a two-second deadline. The actual kernel-held file supplies
device/inode/operation identity. A one-use enrollment descriptor binds a fresh
single-thread bootstrap's credentials after `no_new_privs`; existing shared
address spaces, shared descriptor tables and ring/AIO contexts refuse enrollment.
Later ordinary threads inherit the same immutable context. A broker close or
unanswered deadline refuses both pending and subsequent admissions.
The metadata policy reader consumes the original structured rules rather than
the startup mount covers, retains exact account exceptions and live companions,
and indexes actual device/inode identity without opening content. Directory
names and canonical paths retain their original bytes, including invalid Linux
UTF-8 names; enumeration streams under finite metadata/depth/time budgets. Its
epoch comparison is optimistic and never substitutes for the kernel admission.
The reader still needs the owned broker/production launch integration below.

Dispatch `experiment=kernel-admission` to compile and boot a pinned Linux 6.18
guest under networkless QEMU TCG in the owned ephemeral runner. The upstream
archive has a fixed SHA-256, and only the original admission files enter its
security tree. No kernel is installed, loaded or distributed; the app's MIT
license is unchanged. The original kernel files are `GPL-2.0 OR MIT`, with
the syscall-note alternative for UAPI. The job has a twenty-minute bound,
the guest a forty-five-second outer bound, and the synthetic client finite IPC
and admission deadlines. Commands have independent timeout supervisors; retained
process groups are stopped on interruption or owner-command failure.

This is an implementation increment, not complete confinement. Its status query
reports `production_coverage: 0`; the host never calls it. Namespace begin/end
and final epoch comparison exist, but complete VFS mutation/pre-effect hooks,
the effective structured-policy broker, all file/alias/process routes, the real
production Bubblewrap launch and the complete native compatibility matrix are
still required. The initial guest check covers actual read/alias/new-mapping
admissions and fail-closed group loss only. Neither compilation nor a successful
guest-core result enables a provider or closes the production acceptance gap.

## Modern stock pre-access check

`pre_access.c` checks Linux 6.14+'s `FAN_PRE_ACCESS` before selecting a new
kernel component. It uses one private synthetic inode and its real hardlink,
with the mark installed before the child opens either descriptor. It measures
ordinary reads, alias reads and a warm-cache new mapping before and after an
outside `.pub` transition. It then closes the last notification-group descriptor
while a read is waiting for a decision, and checks a subsequent read separately.
An unanswered operation is not an admitted operation. This distinguishes actual
stock group-loss behavior from assumptions about killing a broker's children.

Dispatch `experiment=pre-access`. The original check has an eighteen-second
owner alarm, a fifteen-second child alarm, two-second IPC/event bounds, and a
twenty-five-second outer timeout. It needs `CAP_SYS_ADMIN` only inside the owned
ephemeral CI runner to create the pre-content group; no policy, kernel, boot,
mount or live-host configuration is changed. Missing kernel/filesystem support
fails the measurement. Passing controls is not production readiness: this does
not implement effective policy, namespace mutation ordering, complete aliases,
provider supervision or enforcement after broker death. The kernel's actual
[pre-access hooks](https://github.com/torvalds/linux/blob/v6.14/include/linux/fsnotify.h)
include new mappings; the older read-only-hook limitation is not inferred for
this modern API.

This executable fixture measures a FUSE-backed live view inside Bubblewrap.
It is never called by the host or packaged with the product. It is not an
implementation of the production secret policy and must not enable a provider.

The fixture checks protected paths created after a long-running runtime starts,
new permitted backing files, durable writes and rename, companion-derived
protection, already-open descriptors, synthetic account exceptions, aliases and
real file watches. Its policy names are disposable sentinels, not real user
credential locations. Only a newly created private temporary directory is used.

On an eligible disposable Linux host with FUSE, Bubblewrap and libfuse3 headers:

```sh
gcc -std=c11 -D_FILE_OFFSET_BITS=64 -Wall -Wextra -Werror \
  $(pkg-config fuse3 --cflags) scripts/linux-file-view/fixture.c \
  -o /tmp/octant-file-view $(pkg-config fuse3 --libs)
python3 scripts/linux-file-view/probe.py /tmp/octant-file-view /tmp/file-view-evidence.json
```

The hosted workflow installs the standard tooling only inside its ephemeral VM.
The runner has a ten-minute maximum; the probe has a two-minute deadline, each
client operation has a five-second limit, and cleanup stops only its retained
process identities and private mount. It verifies the mount is gone before
removing the backing fixture.

A successfully completed measurement exits zero even if a candidate fails a
contract measurement. Read each `passed` value and the explicit
`productionReady: false`, not the CI badge, as the result. A missing prerequisite,
unexecuted native test or unconfirmed cleanup exits nonzero. The reference
fixture deliberately refuses multiply linked files because it cannot establish
their complete alias set; ordinary hard-link compatibility is measured rather
than assumed. It does not forward backing-store watch events. Neither property
is acceptable as a completed production solution.

The next backend must consume the actual effective policy and preserve its exact
account exceptions, all relevant mounts and aliases, permitted file semantics,
postures, process/network boundaries and failure behavior. Passing these selected
fixture measurements alone cannot establish that broader contract. Native data
and current-source production checks are separate evidence.

The hosted job also records read-only prerequisites for a possible BPF-LSM
backend: active LSMs, available BTF, and kernel configuration. It does not load
a policy, install a kernel or change boot settings. A missing active BPF LSM
blocks further capability execution on that runner; this is not evidence that
a different backend enforces the policy. Even an eligible prerequisite result
still needs the dynamic companion/account and alias semantics proven natively.

## Syscall-entry admission counterexample

`syscall_admission.c` is a separate original x86-64/Linux experiment, not a
mediator. A parent traces its one owned child with exit-on-tracer-death enabled.
The child holds an ordinary permitted inode and prepares an SQPOLL ring, waking
its initially idle poller with a completed NOP before the transition. At an
observed syscall stop the parent creates the synthetic `.pub` companion. It
then refuses new direct `pread` and `mmap` requests on the held descriptor and
measures whether publishing an SQE reads that inode without another read or
`io_uring_enter` syscall. No bytes read or mapped before the transition need to
be forgotten. No kernel, boot, ACL, account or security setting is changed.

The client has a ten-second alarm, parent ownership is bounded to fifteen
seconds, and CI adds a twenty-second timeout and two-minute job maximum. The
parent reaps its retained child and removes only its identity-checked temporary
sentinel directory. Unsupported SQPOLL, tracing, control refusals or cleanup
produce a blocked result and nonzero exit, never a capability pass.

```sh
gcc -std=c11 -Wall -Wextra -Werror scripts/linux-file-view/syscall_admission.c \
  -o /tmp/octant-syscall-admission
timeout --kill-after=3s 20s /tmp/octant-syscall-admission
```

Dispatch this workflow with `experiment=syscall-admission` to run only this new
experiment without repeating the unchanged FUSE measurement. An observed
bypass rejects syscall-entry-only admission while arbitrary rings remain
available. It does not reject emulating/brokering asynchronous operations or
prove compatibility of refusing them. Whole-tree/thread supervision, path/FD
race prevention, syscall emulation, aliases and effective policy still need
their own implementation and evidence. See the primary
[SQPOLL contract](https://man7.org/linux/man-pages/man2/io_uring_setup.2.html)
and [ptrace lifecycle contract](https://man7.org/linux/man-pages/man2/ptrace.2.html).

## Asynchronous I/O refusal compatibility

`async_refusal.c` installs a process-owned, inherited seccomp filter solely for
compatibility measurement. It returns `EPERM` or `ENOSYS` for all three io_uring
syscalls and the Linux AIO context, submission, cancellation and completion
syscalls. No filesystem policy is implemented. `async_compatibility.py` measures
both errno choices against Bun 1.4.4, the runner's recorded Node version, the
Claude Agent SDK native executable 0.3.211 and Codex 0.164.0. The first two pins
match the repository's package manager and dependency; Codex is the documented
observed protocol revision, not a claim that every installed revision works.

The deterministic JavaScript fixture exercises real asynchronous file reads,
writes, fsync, held descriptors, hard-link inode identity, persistent rename,
child creation and a native watch event from a child writer. It also checks
Bun's file API and runs the native refusal check in a spawned descendant.
Provider executables only print version/help in Bubblewrap, with empty temporary
account/configuration directories and no inherited credentials. The launcher
also refuses socket creation, connect and send operations with `EACCES` for
these startup checks. A native child verifies those inherited refusals and that
only nonsocket standard descriptors were inherited. Python closes other FDs
before each launch. No provider request is made. If the standard network
namespace cannot start, only provider startup may retry with `--share-net` and
the process-owned socket refusals; that result does not establish production
network confinement. Without either capsule, provider checks remain blocked.
Deterministic Bun/Node file results outside the capsule are labelled separately.
The owned ephemeral Ubuntu job uses the existing desktop Linux CI setup:
`kernel.apparmor_restrict_unprivileged_userns=0` permits Bubblewrap's user
namespace in that disposable runner. It changes no persistent host, boot setting
or kernel component. Earlier attempts without this setup remain blocked
evidence, not production failures or passes. The original `--unshare-all`
capsule is tried first; only it establishes a network namespace measurement.

Dispatch `experiment=async-compatibility` for this experiment only. The Python
owner has a 90-second lifetime, each operation is bounded to ten seconds, the
outer timeout is 100 seconds and the job is limited to five minutes. Retained
process leaders are joined; timeout cleanup kills only the owned process group.
The private fixture is identity-checked before removal. Passing startup and
selected file checks does not prove authenticated provider behavior, a complete
syscall mediator or production readiness.

The compatibility job then runs `syscall_admission.c --native-admission`
under inherited `ENOSYS` refusal. One retained, stopped native client reads an
ordinary inode before a synchronous synthetic companion transition. The tracer
compares each new read/pread/mmap descriptor's device and inode through that
retained client's `/proc` entry, refuses the protected inode through held and
hardlink descriptors, refuses an unknown descriptor, and admits another inode's
read and mapping. This is a positive, single-client descriptor-admission
experiment outside Bubblewrap, with the same 15/20-second ownership bounds.
The original negative SQPOLL experiment remains separate.

The positive fixture has no untrusted pathname policy, shared FD table or peer
that can close/reuse its descriptors. A different tracer event stops this
fixture; it never detaches and allows an unknown lifecycle to continue. It
does not implement whole-thread/descendant supervision, descriptor transfer,
FD reuse, cross-process memory access, general path/inode policy, concurrent
outside mutations or a production mediator. Those obligations remain open;
this controlled fixture must not be wired into production.

## Concurrent descriptor admission

`concurrent_admission.c` measures the next controlled scheduling obligation,
under inherited asynchronous I/O refusal. A seized client starts a real pthread
sharing its FD table. In twenty rounds, the tracer parks every owned peer,
resolves the requested descriptor's device/inode, arms the peer's attempted
`dup2` swap from permitted to protected, and keeps the peer parked until the
admitted read exits. The allowed read must return permitted bytes; the later
swapped descriptor's read and mapping must be refused, while another native
inode's mapping remains usable. Freeze windows check that the swap counter
cannot advance between identity decision and kernel use.

The operation linearizes at the stable identity/protection decision after peers
are stopped. A previously admitted read may complete after a protection
transition; no earlier bytes/pages need to be erased. Non-file syscalls run
concurrently so that pthread waits, child waits and pipes can make progress.
The fixture exercises traced clone, fork, vfork and exec; it refuses
`CLONE_UNTRACED` and returns `ENOSYS` for clone3 rather than continuing a mutable
flags pointer. A separate phase kills the retained tracer after its child,
pthread and fork child are traced/stopped, then uses a task-local subreaper to
join the processes killed by inherited exit-on-tracer-death. No other task's
processes are stopped or signalled.

Dispatch `experiment=concurrent-admission`. Each tracer phase is bounded to
twelve seconds, the owner to thirty seconds, the outer timeout to thirty-five
seconds and the hosted job to two minutes. The native fixture contains only
synthetic files outside Bubblewrap and removes its identity-checked directory.
These selected concurrency/lifecycle cases do not implement a general tracer:
untrusted pathname memory, external mutation/alias linearization, FD transfer,
process-memory routes, all syscall variants, effective policy and production
integration remain open. Existing hardlink/watch/write compatibility evidence
is separate. No new kernel component or production enablement is claimed.
