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
