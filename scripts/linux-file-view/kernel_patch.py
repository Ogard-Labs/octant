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
        rf"(?m)^(?:(?:static\s+)?(?:inline\s+)?(?:int|void|long|struct dentry \*|struct file \*)\s*{name}\s*\([^;{{]*?\)|SYSCALL_DEFINE2\({name},[^;{{]*?\))\s*\{{"
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


def install_scm(kernel: Path) -> None:
    header = kernel / "include/net/scm.h"
    source = header.read_text()
    anchor = "\tstruct user_struct\t*user;"
    if source.count(anchor) != 1:
        raise ValueError("Pinned SCM ownership layout differs")
    header.write_text(source.replace(anchor, "\tconst struct cred\t*octant_sender;\n" + anchor, 1))
    path = kernel / "net/core/scm.c"
    source = path.read_text()
    changes = {
        "\t\tfpl->user = NULL;": "\t\tfpl->user = NULL;\n\t\tfpl->octant_sender = get_current_cred();",
        "\t\tfree_uid(fpl->user);": "\t\tfree_uid(fpl->user);\n\t\tput_cred(fpl->octant_sender);",
        "\t\tnew_fpl->user = get_uid(fpl->user);": "\t\tnew_fpl->user = get_uid(fpl->user);\n\t\tget_cred(new_fpl->octant_sender);",
    }
    for anchor, replacement in changes.items():
        if source.count(anchor) != 1:
            raise ValueError("Pinned SCM credential lifetime differs")
        source = source.replace(anchor, replacement, 1)
    path.write_text(source)
    # Native and compat receives share the same sender principal. A refusal
    # delivers no FD and retains normal MSG_CTRUNC semantics and GC cleanup.
    for relative in ("net/core/scm.c", "net/compat.c"):
        path = kernel / relative
        source = path.read_text()
        anchor = "\tint err = 0, i;"
        declaration = "void scm_detach_fds" + ("_compat" if relative.endswith("compat.c") else "")
        start = source.index(declaration)
        at = source.index(anchor, start) + len(anchor)
        source = source[:at] + "\n\tif (octant_mediation_receive_scm(scm->fp->octant_sender))\n\t\tfdmax = 0;\n" + source[at:]
        path.write_text(include_bridge(source))


def metadata_entry(source: str, name: str, dentry: str, operation: str) -> str:
    definition = re.compile(
        rf"(?m)^(?:static\s+)?(?:int|long|ssize_t)\s+{name}\s*\([^;{{]*?\)\s*\{{"
    )
    matches = list(definition.finditer(source))
    if len(matches) != 1:
        raise ValueError(f"Expected one pinned metadata entry {name}")
    at = matches[0].end()
    return source[:at] + f"\n\toctant_metadata_scope({dentry}, OCTANT_MEDIATION_{operation});\n" + source[at:]


def metadata_write_entry(source: str, name: str, changes: dict[str, str]) -> str:
    definition = re.compile(rf"(?m)^int {name}\([^;{{]*?\)\s*\{{")
    matches = list(definition.finditer(source))
    if len(matches) != 1:
        raise ValueError(f"Expected one pinned mutation entry {name}")
    start = matches[0].end()
    end = source.index("\n}", start)
    body = source[start:end]
    for anchor, replacement in changes.items():
        if body.count(anchor) != 1:
            raise ValueError(f"Pinned mutation anchor differs in {name}")
        body = body.replace(anchor, replacement, 1)
    return source[:start] + body + source[end:]


def install_metadata_writes(kernel: Path) -> None:
    # A delegation can consume its first decision and then retry after waiting.
    # End before that wait and prepare each fresh attempt before taking locks.
    declaration = ("\n\tstruct octant_metadata_scope octant_metadata_admission\n"
                   "\t\t__attribute__((cleanup(octant_metadata_end))) = {};\n")
    prepare = ("\toctant_metadata_admission = octant_metadata_begin(path->dentry, OCTANT_MEDIATION_WRITE);\n"
               "\terror = octant_metadata_admission.error;\n")
    unlock = "\tinode_unlock(inode);"
    end_attempt = unlock + "\n\toctant_metadata_end(&octant_metadata_admission);"
    path = kernel / "fs/open.c"
    source = path.read_text()
    if "octant_metadata_" in source:
        raise ValueError("Ordinary mutation preparation already exists")
    validation = "\tif (length < 0)\n\t\treturn -EINVAL;"
    notify = "\tret = notify_change(idmap, dentry, &newattrs, NULL);"
    source = metadata_write_entry(source, "do_truncate", {
        validation: validation + "\n\toctant_metadata_scope(dentry, OCTANT_MEDIATION_WRITE);",
        notify: "\tret = octant_metadata_check_write(dentry);\n\tif (!ret)\n\t" + notify,
    })
    notify = "\terror = notify_change(mnt_idmap(path->mnt), path->dentry,\n\t\t\t      &newattrs, &delegated_inode);"
    source = metadata_write_entry(source, "chmod_common", {
        "\n\tstruct inode *inode": declaration + "\tstruct inode *inode",
        "retry_deleg:\n": "retry_deleg:\n" + prepare + "\tif (error)\n\t\tgoto out_mnt_unlock;\n",
        notify: "\terror = octant_metadata_check_write(path->dentry);\n\tif (!error)\n\t" + notify,
        unlock: end_attempt,
    })
    lock = "\terror = inode_lock_killable(inode);"
    notify = "\tif (!error)\n\t\terror = notify_change(idmap, path->dentry, &newattrs,"
    source = metadata_write_entry(source, "chown_common", {
        "\n\tstruct mnt_idmap *idmap;": declaration + "\tstruct mnt_idmap *idmap;",
        lock: prepare + "\tif (error)\n\t\treturn error;\n" + lock,
        notify: "\tif (!error)\n\t\terror = octant_metadata_check_write(path->dentry);\n" + notify,
        unlock: end_attempt,
    })
    path.write_text(include_bridge(source))
    path = kernel / "fs/utimes.c"
    source = path.read_text()
    if "octant_metadata_" in source:
        raise ValueError("Timestamp preparation already exists")
    notify = "\terror = notify_change(mnt_idmap(path->mnt), path->dentry, &newattrs,\n\t\t\t      &delegated_inode);"
    source = metadata_write_entry(source, "vfs_utimes", {
        "\n\tint error;": declaration + "\tint error;",
        "retry_deleg:\n": "retry_deleg:\n" + prepare + "\tif (error)\n\t\tgoto out_mnt_unlock;\n",
        notify: "\terror = octant_metadata_check_write(path->dentry);\n\tif (!error)\n\t" + notify,
        unlock: end_attempt,
        "\tmnt_drop_write(path->mnt);": "out_mnt_unlock:\n\tmnt_drop_write(path->mnt);",
    })
    path.write_text(include_bridge(source))


def install_fileattr_writes(kernel: Path) -> None:
    path = kernel / "fs/file_attr.c"
    source = path.read_text()
    if "octant_metadata_" in source:
        raise ValueError("File attribute preparation already exists")
    call = "\t\t\terr = vfs_fileattr_set(idmap, dentry, &fa);"
    scoped = ("\t\t\t{\n\t\t\t\tstruct octant_metadata_scope admission\n"
              "\t\t\t\t\t__attribute__((cleanup(octant_metadata_end))) =\n"
              "\t\t\t\t\toctant_metadata_begin(dentry, OCTANT_MEDIATION_WRITE);\n"
              "\t\t\t\terr = admission.error;\n\t\t\t\tif (!err)\n\t\t" + call + "\n\t\t\t}")
    for name in ("ioctl_setflags", "ioctl_fssetxattr"):
        source = metadata_write_entry(source, name, {call: scoped})
    call = ("\t\terror = vfs_fileattr_set(mnt_idmap(filepath.mnt),\n"
            "\t\t\t\t\t filepath.dentry, &fa);")
    if source.count(call) != 1:
        raise ValueError("Pinned file_setattr call differs")
    scoped = ("\t\t{\n\t\t\tstruct octant_metadata_scope admission\n"
              "\t\t\t\t__attribute__((cleanup(octant_metadata_end))) =\n"
              "\t\t\t\toctant_metadata_begin(filepath.dentry, OCTANT_MEDIATION_WRITE);\n"
              "\t\t\terror = admission.error;\n\t\t\tif (!error)\n\t\t" +
              call.replace("\n", "\n\t\t") + "\n\t\t}")
    source = source.replace(call, scoped, 1)
    call = "\t\terr = inode->i_op->fileattr_set(idmap, dentry, fa);"
    source = metadata_write_entry(source, "vfs_fileattr_set", {
        call: "\t\terr = octant_metadata_check_write(dentry);\n\t\tif (err)\n\t\t\tgoto out;\n" + call,
    })
    # Callers hold the real file/path, but no inode lock. End their scope
    # before mount-write cleanup. The common/internal helper never waits.
    path.write_text(include_bridge(source))


def install_fileattr_reads(kernel: Path) -> None:
    path = kernel / "fs/file_attr.c"
    source = path.read_text()
    if "octant_fileattr_get" in source:
        raise ValueError("File attribute read preparation already exists")
    call = "\terr = vfs_fileattr_get(file->f_path.dentry, &fa);"
    scoped = ("\t{\n\t\tstruct octant_metadata_scope admission\n"
              "\t\t\t__attribute__((cleanup(octant_metadata_end))) =\n"
              "\t\t\toctant_metadata_begin(file->f_path.dentry, OCTANT_MEDIATION_READ);\n"
              "\t\terr = admission.error;\n\t\tif (!err)\n\t\t" + call + "\n\t}")
    for name in ("ioctl_getflags", "ioctl_fsgetxattr"):
        source = metadata_write_entry(source, name, {call: scoped})
    call = "\terror = vfs_fileattr_get(filepath.dentry, &fa);"
    if source.count(call) != 1:
        raise ValueError("Pinned file_getattr call differs")
    scoped = ("\t{\n\t\tstruct octant_metadata_scope admission\n"
              "\t\t\t__attribute__((cleanup(octant_metadata_end))) =\n"
              "\t\t\toctant_metadata_begin(filepath.dentry, OCTANT_MEDIATION_READ);\n"
              "\t\terror = admission.error;\n\t\tif (!error)\n\t\t" + call + "\n\t}")
    source = source.replace(call, scoped, 1)
    call = "\treturn inode->i_op->fileattr_get(dentry, fa);"
    source = metadata_write_entry(source, "vfs_fileattr_get", {
        call: "\terror = inspecting_write ? octant_metadata_check_write_read(dentry) :\n"
              "\t\toctant_metadata_check_read(dentry);\n\tif (error)\n\t\treturn error;\n\n" + call,
    })
    declaration = "int vfs_fileattr_get(struct dentry *dentry, struct file_kattr *fa)"
    export = "EXPORT_SYMBOL(vfs_fileattr_get);"
    call = "\terr = vfs_fileattr_get(dentry, &old_ma);"
    if any(source.count(anchor) != 1 for anchor in (declaration, export, call)):
        raise ValueError("Pinned private file attribute getter differs")
    documentation = "/**\n * vfs_fileattr_get - retrieve miscellaneous file attributes\n"
    if source.count(documentation) != 1:
        raise ValueError("Pinned public getter documentation differs")
    start = source.index(documentation)
    end = source.index("*/\n", start) + 3
    if not source.startswith(declaration, end):
        raise ValueError("Pinned public getter documentation is not adjacent")
    documentation = source[start:end]
    source = source[:start] + source[end:]
    source = source.replace(declaration,
        "static int octant_fileattr_get(struct dentry *dentry, struct file_kattr *fa,\n"
        "\t\t\t       bool inspecting_write)", 1)
    source = source.replace(export, documentation + declaration + "\n{\n\treturn octant_fileattr_get(dentry, fa, false);\n}\n" + export, 1)
    source = source.replace(call, "\terr = octant_fileattr_get(dentry, &old_ma, true);", 1)
    # The exported getter always consumes READ. Only the setter's private
    # call inspects WRITE without consuming its final mutation decision.
    path.write_text(source)


def install_metadata(kernel: Path) -> None:
    # Scope the decision to this one actual syscall's pinned native object.
    # Read/write ACL dispatchers are included before any inode lock. Final
    # LSM callbacks only compare the token and never perform broker I/O.
    path = kernel / "fs/stat.c"
    source = path.read_text()
    if "octant_metadata_" in source:
        raise ValueError("Metadata preparation already exists")
    source = metadata_entry(source, "vfs_statx_path", "path->dentry", "READ")
    anchor = "\treturn vfs_getattr(&fd_file(f)->f_path, stat, STATX_BASIC_STATS, 0);"
    if source.count(anchor) != 1:
        raise ValueError("Pinned retained-fd stat entry differs")
    source = source.replace(anchor,
        "\toctant_metadata_scope(fd_file(f)->f_path.dentry, OCTANT_MEDIATION_READ);\n" + anchor, 1)
    anchor = "\t\terror = security_inode_readlink(path.dentry);"
    if source.count(anchor) != 1:
        raise ValueError("Pinned readlink admission differs")
    source = source.replace(anchor,
        "\t\tstruct octant_metadata_scope octant_metadata_admission\n"
        "\t\t\t__attribute__((cleanup(octant_metadata_end))) =\n"
        "\t\t\toctant_metadata_begin(path.dentry, OCTANT_MEDIATION_READ);\n"
        "\t\terror = octant_metadata_admission.error;\n"
        "\t\tif (!error)\n\t" + anchor, 1)
    path.write_text(include_bridge(source))
    path = kernel / "fs/xattr.c"
    source = path.read_text()
    if "octant_metadata_" in source:
        raise ValueError("Xattr preparation already exists")
    for name, dentry, operation in (
            ("do_getxattr", "d", "READ"), ("listxattr", "d", "READ"),
            ("do_setxattr", "dentry", "WRITE"), ("removexattr", "d", "WRITE")):
        source = metadata_entry(source, name, dentry, operation)
    path.write_text(include_bridge(source))


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
            # These routes change the live mount view without traversing the
            # attachment/removal functions above. Real outside-writer cases
            # accepted stale decisions until these entries joined the epoch.
            "do_change_type", "do_remount", "do_reconfigure_mnt",
            "do_mount_setattr", "pivot_root",
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
            rename = re.compile(r"(?m)^int vfs_rename\([^;{]*?\)\s*\{")
            matches = list(rename.finditer(source))
            if len(matches) != 1:
                raise ValueError("Pinned VFS rename entry differs")
            at = matches[0].end()
            # The epoch scope must begin first so the final comparison can
            # distinguish this exact mutation from simultaneous foreign work.
            anchor = "\n\toctant_namespace_scope(true);\n"
            if not source[at:].startswith(anchor):
                raise ValueError("Pinned VFS rename epoch entry differs")
            at += len(anchor)
            source = source[:at] + "\tif (octant_namespace_check_rename(rd))\n\t\treturn -EACCES;\n" + source[at:]
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
    install_scm(kernel)
    install_metadata(kernel)
    install_metadata_writes(kernel)
    install_fileattr_writes(kernel)
    install_fileattr_reads(kernel)
