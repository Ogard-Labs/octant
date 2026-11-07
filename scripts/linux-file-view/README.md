# Native mediated-file-view feasibility

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
Provider executables only print version/help in a Bubblewrap network namespace,
with empty temporary account/configuration directories and no inherited
credentials. No provider request is made. If the standard Bubblewrap capsule
cannot start, provider checks remain blocked; deterministic Bun/Node results
are separately labelled as outside the capsule. No AppArmor, sysctl, boot or
other host security setting is changed by this job.

Dispatch `experiment=async-compatibility` for this experiment only. The Python
owner has a 90-second lifetime, each operation is bounded to ten seconds, the
outer timeout is 100 seconds and the job is limited to five minutes. Retained
process leaders are joined; timeout cleanup kills only the owned process group.
The private fixture is identity-checked before removal. Passing startup and
selected file checks does not prove authenticated provider behavior, a complete
syscall mediator or production readiness.
