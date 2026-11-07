"""Build only an owned networkless CI guest; never installs a host component."""

import hashlib
import io
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import urllib.request

KERNEL = "6.18"
DIGEST = "9106a4605da9e31ff17659d958782b815f9591ab308d03b0ee21aad6c7dced4b"


def run(*arguments, cwd=None, timeout=900, output=None):
    process = subprocess.Popen(arguments, cwd=cwd, stdout=output,
                               stderr=subprocess.STDOUT if output else None, start_new_session=True)
    try:
        result = process.wait(timeout=timeout)
    except BaseException:
        # This process group was created here; never stop a shared host tool.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=3)
        raise
    if result:
        raise subprocess.CalledProcessError(result, arguments)


def archive_entry(output, name, data, mode, number, device=(0, 0)):
    encoded = name.encode() + b"\0"
    fields = [number, mode, 0, 0, 1, 0, len(data), 0, 0, device[0], device[1], len(encoded), 0]
    output.write(b"070701" + b"".join(f"{field:08x}".encode() for field in fields))
    output.write(encoded)
    output.write(b"\0" * (-(110 + len(encoded)) % 4))
    output.write(data)
    output.write(b"\0" * (-len(data) % 4))


def main():
    if sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("The kernel build is restricted to the owned ephemeral Linux CI job.")
    repository = Path(__file__).resolve().parents[2]
    root = Path(os.environ["RUNNER_TEMP"]) / "octant-kernel-guest"
    root.mkdir(mode=0o700)
    with urllib.request.urlopen(f"https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-{KERNEL}.tar.xz", timeout=60) as response:
        archive = response.read(160 * 1024 * 1024 + 1)
    if len(archive) > 160 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != DIGEST:
        raise SystemExit("Pinned upstream kernel archive size or digest differs.")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:xz") as source:
        source.extractall(root, filter="data")
    kernel = root / f"linux-{KERNEL}"
    native = repository / "apps/server/native/linux-mediation"
    destination = kernel / "security/octant_mediation"
    destination.mkdir()
    for name in ("mediation.c", "octant_mediation.h", "bridge.h"):
        shutil.copyfile(native / name, destination / name)
    (destination / "Makefile").write_text("obj-y += mediation.o\n")
    with (kernel / "security/Makefile").open("a") as output:
        output.write("\nobj-$(CONFIG_SECURITY_OCTANT_MEDIATION) += octant_mediation/\n")
    with (kernel / "security/Kconfig").open("a") as output:
        output.write('\nconfig SECURITY_OCTANT_MEDIATION\n\tbool "Octant disposable admission bridge"\n\tdepends on SECURITY\n\tdefault n\n')
    run("make", "tinyconfig", cwd=kernel)
    for symbol in ("64BIT", "MULTIUSER", "PRINTK", "TTY", "SERIAL_8250", "SERIAL_8250_CONSOLE",
                   "BLK_DEV_INITRD", "BINFMT_ELF", "PROC_FS", "SYSFS", "TMPFS", "SHMEM",
                   "DEVTMPFS", "SECURITY", "SECURITY_OCTANT_MEDIATION", "IO_URING", "AIO",
                   "FUTEX", "PCI", "BLOCK", "ACPI"):
        run("scripts/config", "--enable", symbol, cwd=kernel, timeout=10)
    run("scripts/config", "--set-str", "LSM", "octant_mediation", cwd=kernel, timeout=10)
    run("make", "olddefconfig", cwd=kernel)
    run("make", "-j2", "bzImage", cwd=kernel)
    executable = root / "init"
    run("gcc", "-static", "-std=c11", "-Wall", "-Wextra", "-Werror",
        str(repository / "scripts/linux-file-view/kernel_guest.c"), "-o", str(executable), timeout=30)
    with (root / "initramfs.cpio").open("wb") as output:
        archive_entry(output, "dev", b"", 0o040755, 1)
        archive_entry(output, "dev/console", b"", 0o020600, 2, device=(5, 1))
        archive_entry(output, "init", executable.read_bytes(), 0o100755, 3)
        archive_entry(output, "TRAILER!!!", b"", 0, 4)
    with (root / "guest.log").open("wb") as output:
        run("timeout", "--kill-after=3s", "45s", "qemu-system-x86_64", "-machine", "accel=tcg",
            "-cpu", "max", "-m", "256M", "-smp", "2", "-nic", "none", "-nographic",
            "-no-reboot", "-kernel", str(kernel / "arch/x86/boot/bzImage"),
            "-initrd", str(root / "initramfs.cpio"), "-append", "console=ttyS0 panic=-1",
            timeout=50, cwd=root, output=output)
    log = (root / "guest.log").read_text(errors="replace")
    print(log[-20000:])
    if "OCTANT_KERNEL_EXIT 0" not in log or '"status":"measured-admission-core"' not in log:
        raise SystemExit("The guest admission core did not pass; no production proof is inferred.")


if __name__ == "__main__":
    main()
