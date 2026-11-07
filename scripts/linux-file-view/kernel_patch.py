"""Install original nonblocking epoch hooks into the pinned disposable source."""

from pathlib import Path
import re
import shutil


def instrument(source: str, name: str, condition: str = "true") -> str:
    declaration = re.compile(
        rf"(?m)^(?:static\s+)?(?:inline\s+)?(?:int|void|long|struct dentry \*|struct file \*)\s*{name}\s*\([^;{{]*?\)\s*\{{"
    )
    matches = list(declaration.finditer(source))
    if len(matches) != 1:
        raise ValueError(f"Expected one pinned definition of {name}, found {len(matches)}")
    at = matches[0].end()
    return source[:at] + f"\n\toctant_namespace_scope({condition});\n" + source[at:]


def install_epochs(kernel: Path, native: Path) -> None:
    # Real unconfined writers use these same VFS entry points. These counters
    # describe in-flight mutations, not delayed filesystem-watch notifications.
    definitions = {
        "fs/namei.c": [
            "vfs_create", "vfs_mkobj", "vfs_tmpfile", "vfs_mkdir", "vfs_mknod",
            "vfs_symlink", "vfs_link", "vfs_unlink", "vfs_rmdir", "vfs_rename",
        ],
        "fs/namespace.c": [
            "commit_tree", "do_umount", "attach_recursive_mnt", "do_move_mount",
        ],
    }
    for relative, functions in definitions.items():
        path = kernel / relative
        source = path.read_text()
        if "octant_namespace_scope" in source:
            raise ValueError("Epoch hooks already exist; refusing an ambiguous patch")
        for name in functions:
            source = instrument(source, name)
        if relative == "fs/namei.c":
            source = instrument(source, "atomic_open", "(open_flag & O_CREAT) != 0")
            # The non-atomic negative-dentry path invokes i_op->create
            # directly; it does not pass through vfs_create.
            source = instrument(source, "lookup_open", "(op->open_flag & O_CREAT) != 0")
        first_line = source.index("\n") + 1
        source = source[:first_line] + '#include <linux/octant_mediation_bridge.h>\n' + source[first_line:]
        path.write_text(source)
    shutil.copyfile(native / "bridge.h", kernel / "include/linux/octant_mediation_bridge.h")
    # The modern static-call allocation counts configured LSMs explicitly.
    # Register this original component in that count; selecting CONFIG_LSM
    # alone otherwise leaves only the capability slot and skips initialization.
    count = kernel / "include/linux/lsm_count.h"
    source = count.read_text()
    anchor = "\t\tCAPABILITIES_ENABLED\t\\\n"
    if source.count(anchor) != 1:
        raise ValueError("Pinned LSM count anchor differs")
    source = source.replace(anchor, anchor + "\t\tOCTANT_MEDIATION_ENABLED\t\\\n", 1)
    marker = "#define MAX_LSM_COUNT\t\t\t\\\n"
    if source.count(marker) != 1:
        raise ValueError("Pinned LSM count definition differs")
    source = source.replace(marker,
        "#if IS_ENABLED(CONFIG_SECURITY_OCTANT_MEDIATION)\n"
        "#define OCTANT_MEDIATION_ENABLED 1,\n"
        "#else\n#define OCTANT_MEDIATION_ENABLED\n#endif\n\n" + marker, 1)
    count.write_text(source)
