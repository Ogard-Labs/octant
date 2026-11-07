"""Install original nonblocking epoch hooks into the pinned disposable source."""

from pathlib import Path
import re
import shutil


def include_bridge(source: str) -> str:
    # Some upstream files start with a multiline license comment, so inserting
    # after their first newline would leave the declaration inside that comment.
    anchor = re.search(r"(?m)^#include ", source)
    if anchor is None:
        raise ValueError("Pinned source has no include block")
    at = anchor.start()
    return source[:at] + '#include <linux/octant_mediation_bridge.h>\n' + source[at:]


def instrument(source: str, name: str, condition: str = "true") -> str:
    declaration = re.compile(
        rf"(?m)^(?:static\s+)?(?:inline\s+)?(?:int|void|long|struct dentry \*|struct file \*)\s*{name}\s*\([^;{{]*?\)\s*\{{"
    )
    matches = list(declaration.finditer(source))
    if len(matches) != 1:
        raise ValueError(f"Expected one pinned definition of {name}, found {len(matches)}")
    at = matches[0].end()
    return source[:at] + f"\n\toctant_namespace_scope({condition});\n" + source[at:]



def instrument_namespace_preparation(source: str) -> str:
    # These preparation calls run after copied names and parent paths resolve,
    # before the VFS takes parent inode locks. The final LSM hook only compares
    # the actual operation with the per-task token; it performs no lookup/IPC.
    preparations = {
        "do_unlinkat": (
            "retry_deleg:\n\tinode_lock_nested(path.dentry->d_inode, I_MUTEX_PARENT);",
            "retry_deleg:\n\terror = octant_namespace_prepare(OCTANT_MEDIATION_UNLINK, &path, &last, NULL, NULL, 0);\n"
            "\tif (error) {\n\t\tmnt_drop_write(path.mnt);\n\t\tgoto exit2;\n\t}\n"
            "\tinode_lock_nested(path.dentry->d_inode, I_MUTEX_PARENT);",
        ),
        "do_rmdir": (
            "\tinode_lock_nested(path.dentry->d_inode, I_MUTEX_PARENT);",
            "\terror = octant_namespace_prepare(OCTANT_MEDIATION_RMDIR, &path, &last, NULL, NULL, 0);\n"
            "\tif (error) {\n\t\tmnt_drop_write(path.mnt);\n\t\tgoto exit2;\n\t}\n"
            "\tinode_lock_nested(path.dentry->d_inode, I_MUTEX_PARENT);",
        ),
        "do_renameat2": (
            "retry_deleg:\n\ttrap = lock_rename(new_path.dentry, old_path.dentry);",
            "retry_deleg:\n\terror = octant_namespace_prepare(OCTANT_MEDIATION_RENAME, &old_path, &old_last,\n"
            "\t\t&new_path, &new_last, flags);\n\tif (error)\n\t\tgoto exit_lock_rename;\n"
            "\ttrap = lock_rename(new_path.dentry, old_path.dentry);",
        ),
    }
    for function, (anchor, replacement) in preparations.items():
        declaration = re.search(rf"(?m)^int {function}\([^;{{]*?\)\s*\{{", source)
        if declaration is None:
            raise ValueError(f"Pinned preparation definition {function} differs")
        # Next top-level closing brace is the end of this function, so an
        # identical lock site in another syscall cannot receive this patch.
        end = source.index("\n}", declaration.end())
        body = source[declaration.end():end]
        if body.count(anchor) != 1:
            raise ValueError(f"Pinned pre-lock anchor for {function} differs")
        source = source[:declaration.end()] + body.replace(anchor, replacement, 1) + source[end:]
    return source


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
            source = instrument_namespace_preparation(source)
        path.write_text(include_bridge(source))
    shutil.copyfile(native / "bridge.h", kernel / "include/linux/octant_mediation_bridge.h")
    shutil.copyfile(native / "octant_mediation.h", kernel / "include/uapi/linux/octant_mediation.h")
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
    aio = kernel / "fs/aio.c"
    source = aio.read_text()
    definition = re.compile(r"(?m)^static struct kioctx \*ioctx_alloc\([^;{]*?\)\s*\{")
    matches = list(definition.finditer(source))
    if len(matches) != 1:
        raise ValueError("Pinned native and compat AIO allocation definition differs")
    at = matches[0].end()
    source = source[:at] + "\n\tif (octant_mediation_restricted())\n\t\treturn ERR_PTR(-ENOSYS);\n" + source[at:]
    aio.write_text(include_bridge(source))
