# Native mediated-file-view feasibility

## Kernel admission implementation

`apps/server/native/linux-mediation/` contains an original, unshipped built-in
kernel admission core and its fixed-size UAPI. A context has at most 32 pending
requests, each with a two-second deadline. The actual kernel-held file supplies
device/inode/operation identity. A one-use enrollment descriptor binds a fresh
single-thread bootstrap's credentials after `no_new_privs`; existing shared
address spaces, shared descriptor tables and ring/AIO contexts refuse enrollment.
Later ordinary threads inherit the same immutable context. Ordinary future
shared anonymous memory and same-policy descriptor transfer remain usable.
SCM records retain the real sending credentials, including through duplicate
records and socket GC; native and compat receive paths compare that immutable
sender context with the receiver. Claimed SCM UID/PID fields and a file's
original opener cannot substitute for that authority. Foreign-policy transfers
refuse while same-policy transfer of an inherited ordinary descriptor remains
valid. Initial enrollment refuses inherited proc-data/pidfd and async contexts;
ordinary descriptors and private bootstrap control remain valid. A broker close or
unanswered deadline refuses both pending and subsequent admissions. Broker
reads, writes, status queries and enrollment minting are bound to the original
TGID and captured credentials, not possession of a forwarded descriptor. The
native negative check forwards that descriptor to a same-UID fork and requires
all four operations to refuse.
The metadata policy reader consumes the original structured rules rather than
the startup mount covers, retains exact account exceptions and live companions,
and indexes actual device/inode identity without opening content. Directory
names and canonical paths retain their original bytes, including invalid Linux
UTF-8 names; enumeration streams under finite metadata/depth/time budgets. Its
epoch comparison is optimistic and never substitutes for the kernel admission.
The candidate native relay now opens the device, creates one-use enrollment,
and closes all private descriptors before executing the owned command. Its
inherited FD 3 is a dedicated duplex control channel; provider stdio is never
used for policy. The separately owned TypeScript broker reads the original
structured policy and answers the kernel using the actual metadata epoch. It
bounds control buffers, pending work and lifetimes. A broker-principal-only
ioctl pins the actual proposed parent with `O_PATH`; at most two such FDs stay
private to the relay until answer/cleanup. The relay checks device/inode and
`STATX_MNT_ID_UNIQUE`; the owned policy process verifies the retained directory
and repeats the mount/identity query around classification. Guest strings are
never translated into host paths.

For unlink/rmdir/rename, the classifier re-runs the original structured policy
against a metadata-only proposed namespace, using actual parent identity and
copied byte names. It refuses loss of protection for still-existing objects,
including companion/ancestor and symlink-target changes; it preserves unrelated
public aliases, independent name rules and permitted moves. It performs no
actual mutation or content copy and retains no permanent protected-inode floor.
The kernel still performs the final operation/epoch check. The guest compiles
this actual broker and checks a late companion against an already-open
descriptor, hardlink and new mapping, ordinary/public-key contents, refused
marker/ancestor changes and permitted namespace operations. The actual policy workload and three ordinary unchanged Bubblewrap-builder
repetitions have native receipts in the PR. Production lifecycle integration,
remaining mutation/data routes and the complete matrix below are still missing.
Account exception forms are captured at enrollment; replacing an account path
with a symlink never transfers that exception to another sign-in.

The namespace candidate adds copied byte names, actual parent device/inode
identities, operation and flags to ABI 2. Unlink, rmdir and rename prepare their
bounded decision before parent inode locks. Their final LSM hook compares the
actual operation with a per-task token and the current epoch without waiting or
looking up paths under those locks. Same-policy threads have separate tokens;
foreign mutations invalidate a proposal rather than freezing outside writers.
The namespace-token guest cases use synthetic allow/deny decisions to check
this transport boundary. They remain distinct from the actual original-policy
broker guest cases above and cannot substitute for them. Neither suite proves
all namespace, filesystem, alias, syscall or runtime routes.

The guest boots from a private ext4 image assembled with `mke2fs -d`; it is
never mounted or installed on the runner. The kernel's initial initramfs
`rootfs` cannot be replaced by `pivot_root`, so it is not a suitable root for
measuring the unchanged Bubblewrap launch. The image contains only the owned
synthetic executables and their public loader/libraries. Ordinary policy and
runtime data lives on a private guest tmpfs. The filesystem-attribute fixture
instead uses the existing guest ext4 root and verifies its filesystem type;
it adds no mount or image.

The next guest layer executes the unchanged production `buildBubblewrapLaunch`
output with network egress `none`, under the same native broker. It prepares the
normal startup covers before populating the synthetic protected files, then
publishes the companion during execution. This tests actual namespace/FD
composition rather than a reconstruction of Bubblewrap flags. Its result is
separate from the direct native broker cases and never implies complete parity.
The SCM controls also queue a foreign FD before enrollment and reap a same-policy
sender before receiving its queued FD; send-time credentials must survive both
transitions. The same actual Bubblewrap scenario runs three times to check
the previously observed UID-map timing failure; it is not a broader acceptance
matrix. The kernel delivers the oldest undelivered request identity rather than
reused array-slot order, preserving the broker's strict monotonic/replay guard.
A controlled native case holds the first admission, queues an older second
reader, then reuses the first slot for a third admission. Its actual IDs,
matching inode/operation decisions, successful reads, join and cleanup must pass.
Guest compilation uses the original uninstrumented kernel and broker. Earlier
exception-only observations remain diagnostic evidence in the PR; they do not
substitute for this ordinary run.

The parallel guest requires `CONFIG_SMP=y`, exactly two configured CPUs and an
actual two-online-CPU receipt. Earlier pthread receipts used a single online
CPU despite the QEMU `-smp 2` option, so they do not establish parallel-CPU
behavior. An unenrolled writer performs pivot-root, normal and bind remount, mount attributes,
propagation, create, unnamed temporary-file creation, empty-path link, rename
and bind-mount operations in its own disposable mount namespace. Each operation
must advance the epoch, refuse an already-pending stale allow, preserve a fresh
permitted read, and join both owned children before cleanup. The writer stays
alive until the parent reads its result so namespace destruction cannot hide
an absent mutation hook. These are operation-specific epoch controls, not a
complete filesystem/atomic-open or alias policy proof. Exact native results
remain required; no coverage bit is promoted by the added source.
The first two-CPU measurement found pivot-root, remount, mount attributes and
propagation completed without an epoch change, allowing the old pending
decision. Their actual entries now join the existing nonblocking scope;
fresh permitted reads and both normal/bind remount routes remain mandatory
controls. No userspace inspection or broker wait is added under VFS locks.

The next runtime layer runs the actual Bun and Node executables through that
same broker and unchanged production builder. It checks native async file I/O,
fsync, held descriptors, hardlink identity, rename, child spawn/join and an
inotify observation caused by the unconfined guest owner. The owner publishes
a companion only after the runtime has opened and read the synthetic private
file; subsequent held/alias reads and protected writes must refuse while public
content stays readable. Each runtime owns a 20-second deadline, its broker a
25-second maximum; the QEMU supervisor remains independently bounded. Runtime
versions and exit/join/cleanup receipts must be read from the actual run; added
source is not an executed pass. Public runtimes and loader dependencies are
copied only into the private 512-MiB guest image, never installed on a live host.
No provider credentials, requests, network services or accounts are involved.

An actual run reached a Bun controller abort during DFG-to-FTL tier-up before
the Node workload started. A bounded default-JIT control now runs the same
compiled controller's real metadata classifier without enrollment, first on the
stock runner and then in the guest. The other guest controller processes use
`BUN_JSC_useFTLJIT=0` only as a diagnostic isolation step. This is the unstable
debugging option described by the pinned
[Bun runtime source](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/jsc/lib.rs)
and [JSC option list](https://github.com/oven-sh/WebKit/blob/32dc1b0f51d51d8e0f8cba3398db9cadfd09dc73/Source/JavaScriptCore/runtime/OptionsList.h).
The controller deletes it before spawning the native relay. Both measured stock
Bun/Node payloads assert that no `BUN_JSC_*` variable exists and report that check.
No production launch, kernel hook, authority, timeout or workload executable is
changed. If the independent default controls do not reproduce the abort, its
underlying runtime/kernel interaction remains unknown; mitigation is not proof
of a corrected cause or production eligibility.

The guest-only crash collector retains its fixed controller/probe targets,
pidfd identity checks, three-second and 128-KiB bounds. After confirming the
signal notes it may read only the numeric `NT_FILE` entries, stopping before
all filenames and memory segments. Optional pipe reads have at most 250 ms
and require a further 250-ms publication reserve within the same total bound.
A unique fault-address mapping is compared
through numeric `map_files` metadata with a bounded inventory of already-copied
guest modules, whose ELF identities and executable file offsets are attested
at build time. Missing, ambiguous or inaccessible mappings remain unknown;
they neither erase valid signal evidence nor imply a runtime or library cause.
The existing genuine probe must prove its actual backing-object identity.
This reader extension still requires native execution and enables no capability.

Metadata coverage requires the link inode as well as its followed target:
even a dangling protected symlink has link text and metadata. The policy's
metadata port therefore distinguishes `lstat` from `stat`, including in proposed
namespaces, while retaining exact account exceptions and byte names. The native
workload checks late protected stat/readlink/xattr reads, listing, writes and
removal, plus the ACL dispatch and ordinary/public positive controls. A separate
unconfined, two-second owner check verifies private attributes and mode unchanged
after the enrolled command exits. The guest explicitly requires tmpfs xattrs and
tmpfs/ext4 ACL support rather than treating an unsupported operation as refusal.
Kernel guards for these cases are unfinished until the actual red/fix/native
result is recorded; this collector and fixture source enables no capability.
The candidate uses a private per-task, per-operation scope prepared at the
actual pinned user entrypoints. Cleanup clears unused decisions on every return;
nesting and counter wrap refuse, child state is zeroed and exec clears it. The
final metadata/xattr/ACL LSM callbacks compare and consume the exact native
identity, operation, live context and epoch under short locks only. They never
perform broker I/O under inode locks. Readlink retains its normal path/name
cleanup, and xattr scopes begin before either ACL or generic dispatch. Unknown
unprepared internal paths refuse rather than sharing a preceding operation's
allow. Native runtime/public-positive proof remains required for this increment.

The next bounded metadata-write controls require held/path chmod, chown using
the current uid/gid, and timestamp changes to refuse on the protected synthetic
key. A public positive performs the same six operations and checks actual mode,
owner and timestamp state. Before publishing the companion, the workload saves
its synthetic inode's metadata after the initial admitted read and xattr seed.
The independent owner compares identity, mode, uid/gid, atime/mtime/ctime and
private xattrs after the command exits, including a failing command. This source
establishes a RED measurement against the preceding unchanged guards; the new
pre-lock/final-check correction still requires actual native proof. It enables
no production capability.

That correction prepares at the pinned ordinary `do_truncate`, `chmod_common`,
`chown_common` and `vfs_utimes` entries, before inode locks. A kernel-private,
comparison-only final write check runs immediately before `notify_change`.
The three delegation loops end before waiting and prepare a fresh decision for
each retry; automatic cleanup handles early exits, and mount-write cleanup stays
balanced. There is no new global `inode_setattr` hook or extra ACL consumption.
Write-induced privilege clearing may already hold inode locks; its pre-lock
lifetime, filesystem ioctls and stacked mutation routes remain unfinished. A
global guard without those lifetimes would break legitimate public writes or
cause blocking under locks. Existing public ACL/truncate and real runtime proof
must still pass, and production coverage remains zero.

Ordinary filesystem-attribute GET and SET entries prepare separate READ and
WRITE scopes using their held file/path before the shared VFS operation. Read
scopes end before copyout; write scopes end before mount-write release. The
exported getter consumes only the exact prepared READ. Only the setter's
private internal getter can inspect its prepared WRITE without consuming it;
the final setter consumes that decision immediately before the filesystem
callback. Both comparisons retain native checks and match the current task,
context, inode and epoch without broker I/O under inode locks. Ordinary reads
cannot select the private inspection purpose or borrow WRITE authority.
The ext4 fixture requires late-protected GET refusal with unchanged output,
NODUMP SET refusal with independently unchanged flags/metadata, and permitted
public toggle/readback/restoration and writes. This covers the audited ordinary
entries, not all attribute/ioctl routes, internal calls, stacked filesystems or
kernel credential overrides; those lifetimes and policy semantics remain
unproved. Production coverage remains zero.

The regular-file `FIONREAD`/`FIOQSIZE` correction uses the existing READ
admission from native and conditional compat ioctl hooks before copying size
or allocation metadata. Its fixture requires a readable baseline before the
companion, later EACCES with output sentinels unchanged, public observations,
and pipe/socket positives. Scoped native controls pass; compat execution remains
unproved. Other ioctls and credential-override/stacked
semantics remain outside this bounded correction with production coverage zero.

The regular-file `FS_IOC_FIEMAP` entry also prepares READ admission before its
filesystem callback or output. Its controls require a permitted baseline,
late-protected refusal with unchanged output, and a public positive. For
`SEEK_END`, `SEEK_DATA` and `SEEK_HOLE`, the two seek syscall entries pin the
original descriptor and prepare before the position lock. They preserve the
original lock/release behavior and perform only a current-epoch comparison
after acquiring the lock; no broker IPC occurs there. A held-reply control
requires another process to move the same file position before reply release.
A stale-epoch waiter must refuse without changing that position.

A scoped disposable native run passed these FIEMAP, public/output and seek
pre-lock/stale-epoch controls. Full integrated execution remains unproved.
Compat execution, complete namespace authority through the filesystem effect,
other ioctl routes and stacked filesystems remain outside that evidence;
production coverage stays zero.

The candidate `prepareLinuxMediationSession` port owns its trusted policy worker,
native relay and held command identities. The worker invokes the unchanged
shared Bubblewrap builder with the host's exact protected-file setup and a
separately supplied command environment. Device ABI/status and a structured
policy snapshot precede fork; exec waits for the actual command's durable
PID/birth receipt. All private control uses FD3, separately from bounded,
backpressured stdin/stdout/stderr. The existing canonical owner-only receipt
root is covered through the builder's real additional read/write denials.

The worker's private channel uses standard child-process JSON IPC: one typed
configuration, `L` to request launch, `E` to release the held command and `X`
to cancel, with bounded ready/command/result replies. A send returning false
means accepted backpressure; callbacks report transport failure, and no message
is replayed. Owner disconnect retires admission. The native relay retains its
separate binary FD3 channel; neither control channel becomes command stdio.
Healthy completion requires actual child EXIT plus payload EOF and IPC
disconnect; a channel or kill error never counts as EXIT. Existing caller and
cleanup deadlines remain in force. Integrated native Linux acceptance passes
the session transport scenarios; the working host IPC check alone is not
capsule proof.

Preparation and execution share a caller deadline of at most the candidate's
existing 180 seconds; normal output drains until EOF or that deadline. Input
past EOF refuses, and an accepted write that loses its pipe reports uncertainty
without replay. Caller cancellation or owner-channel EOF closes admission
before owned process cleanup. The host bounds cleanup to four seconds and
retains uncertainty for unconfirmed identities/groups rather than treating a
relay exit or closed pipe as complete descendant proof. The added guest session
cases require readiness before effects, pre-launch cancellation, real early
exit, deadline/cancellation, duplex pressure, private receipt masking and actual
owner death. PID1 separately joins the deliberately orphaned worker.

The native relay becomes a subreaper before forking and retains its direct
leader without reaping until the original process-group signals are sent.
After closing admission, cleanup uses the existing 300-ms grace and reaps its
own children and adopted descendants within two seconds. Only `ECHILD` plus
the direct leader's status proves that join; expiry or an escaped live child
returns a distinct private failure. No unrelated process is signalled.
The worker reports cleanup certainty separately from the command result.
Even during cancellation, the session requires that validated terminal
acknowledgement, actual worker exit, IPC disconnect and owned retirement before
reporting confirmed cleanup. Missing acknowledgements remain uncertain, and
late messages cannot admit a new command or release execution. Integrated native
acceptance passes all seven scenarios and the exact one-worker orphan join;
the earlier twelve-orphan failure remains the regression baseline.

The unchanged session scenarios run after the three ordinary capsules and
before the Bun/Node controllers, retaining the exact one-worker orphan join.
Both runtime checks remain mandatory, followed by a separate bounded PID1 reap
requiring zero leftovers and `ECHILD`. A later controller failure still fails
the complete run; earlier session evidence does not waive that failure.

The runtime-expiry case uses the existing ten-second scenario budget so the
owned worker can finish preparation and prove the command has launched before
expiry. Preparation still counts toward that same caller deadline.
The complete session suite and both subsequent default runtime controls pass
at the recorded acceptance snapshot, including the final zero-leftover join.
Earlier intermittent controller crashes are not explained by that pass. This
port remains unselected, the device is root-only, and complete policy/data
routes, eligible-host lifecycle and controller reliability remain unfinished
with production coverage zero.

The inode-query increment admits regular-file generation and block-size reads
before output and compares generation writes under the ext4 inode lock before
reserving the inode buffer. An admitted reservation therefore still reaches its
native release path. Its earlier scoped native evidence preserves permitted
generation changes and protected state; compat execution remains unproved.
The integrated creation fixture adds protected-name and source-link negatives,
native existing-target errors, permitted creations, hardlink identity and
anonymous temporary-file linking. These are new acceptance assertions, not
implemented CREATE/LINK admission or an executed passing result.

Dispatch `experiment=kernel-admission` to compile and boot a pinned Linux 6.18
guest under networkless QEMU TCG in the owned ephemeral runner. The upstream
archive has a fixed SHA-256, and only the original admission files enter its
security tree. No kernel is installed, loaded or distributed; the app's MIT
license is unchanged. The original kernel files are `GPL-2.0 OR MIT`, with
the syscall-note alternative for UAPI. The job has a twenty-minute bound,
the guest a 150-second outer bound, and the synthetic client finite IPC
and admission deadlines. Commands have independent timeout supervisors; retained
process groups are stopped on interruption or owner-command failure.

This is an implementation increment, not complete confinement. Its status query
reports `production_coverage: 0`; the host never calls it. Namespace begin/end
and final epoch comparison exist, but complete VFS mutation/pre-effect hooks,
all file/alias/process routes, shared production lifecycle integration and the
complete native compatibility matrix are still required. The actual structured
policy broker and basic unchanged-builder composition have separate native
receipts; they do not establish the missing routes. The admission guest check adds actual same-policy inherited-FD transfer,
foreign ordinary/proc-memory FD refusal, and future shared-memory controls to
the earlier fourteen read/alias/new-mapping, same-policy thread, write/truncate,
async-fallback and group-loss cases. A separate enrollment control refuses an
inherited proc-memory FD, then succeeds after it is closed. The
additional namespace cases check copied identities/names, refused and allowed
mutations, outside same-parent progress while a proposal waits, stale replies,
and pending/new mutation refusal after broker loss. Their exact-head hosted
result must be read separately; a newly added case is not an executed pass. Neither compilation nor a successful
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
  -o /tmp/octant-file-view $(pkg-config fuse3 --libs) -lrt
python3 scripts/linux-file-view/probe.py /tmp/octant-file-view /tmp/file-view-evidence.json
```

The hosted workflow installs the standard tooling only inside its ephemeral VM.
The runner has a ten-minute maximum; the probe has a two-minute deadline, each
client operation has a five-second limit, and cleanup stops only its retained
process identities and private mount. It verifies the mount is gone before
removing the backing fixture.

The native helper requires the launcher's PID captured before exec and a private
fixture lifetime of 1–120 seconds. It checks the parent before and after arming
`PR_SET_PDEATHSIG(SIGKILL)` and again before mounting. A separate monotonic timer
delivers `SIGKILL` at the lifetime limit; neither Python cleanup nor FUSE signal
handlers control it. Before opening backing or FUSE descriptors, the fixture
captures its own stable process handle and forks a mount-retirement child. That
child acknowledges its independent timer before the fixture can mount. It
waits for the exact fixture to exit, then runs the fixed `fusermount3 -uz`
command against its private mount. It retains and waits that unmount process,
kills it after two seconds if needed, and has its own independent monotonic
lifetime bound. The unmount process also has a three-second alarm that survives
exec, bounding it even if its supervisor dies after a setuid exec clears its
parent-death signal. This replaces `auto_unmount`: native owner-loss and deadline
measurements on libfuse 3.14.0-5build1 joined the helper and its descendants but
still observed the mount present. The exact internal reason was not measured.
These use the documented
[parent-death signal](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html),
[native timer](https://man7.org/linux/man-pages/man2/timer_create.2.html),
[stable process handle](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
and [FUSE unmount](https://github.com/libfuse/libfuse/blob/fuse-3.14.0/doc/mount.fuse3.8)
boundaries.

Before the unchanged 17 file measurements, three mandatory lifecycle checks kill
an owner after mounting, kill it while its child is still waiting before exec,
and let a two-second native lifetime expire while the owner remains alive. The
short lifetime exercises the independent deadline without waiting two minutes.
Each check requires the actual helper wait status, automatic mount removal and
joined mount-retirement descendants before fallback cleanup. The task-local
subreaper remains enabled through the ordinary measurements to join their FUSE
descendants too, then restores its prior setting. Test owners and their pre-exec
children have independent finite alarms; owners also bind to the probe's PID.
A lifecycle failure or unconfirmed descendant cleanup fails the job. Its
`lifecycleMeasurements` are separate from the 17 compatibility observations.

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
