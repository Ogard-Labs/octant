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


def install_inode_generation_write(kernel: Path) -> None:
    path = kernel / "fs/ext4/ioctl.c"
    source = path.read_text()
    if "octant_metadata_" in source:
        raise ValueError("Inode generation admission already exists")
    start = source.index("\tcase EXT4_IOC_SETVERSION:\n")
    end = source.index("\tcase EXT4_IOC_GROUP_EXTEND:", start)
    operation = source[start:end]
    lock = "\t\tinode_lock(inode);"
    unlock = "\t\tinode_unlock(inode);"
    effect = "\t\terr = ext4_reserve_inode_write(handle, inode, &iloc);"
    if any(operation.count(anchor) != 1 for anchor in (lock, unlock, effect)):
        raise ValueError("Pinned inode generation lock/effect differs")
    # Preserve native ownership, checksum, mount-write and copyin refusals.
    # The nested scope ends before mount-write cleanup, including goto exits.
    operation = operation.replace(lock,
        "\t\t{\n\t\t\tstruct octant_metadata_scope admission\n"
        "\t\t\t\t__attribute__((cleanup(octant_metadata_end))) =\n"
        "\t\t\t\toctant_metadata_begin(filp->f_path.dentry, OCTANT_MEDIATION_WRITE);\n"
        "\t\t\terr = admission.error;\n\t\t\tif (err)\n\t\t\t\tgoto setversion_out;\n" + lock, 1)
    # A successful reservation owns iloc.bh until ext4_mark_iloc_dirty consumes
    # it. Refuse before reserving so a stale decision cannot leak that reference.
    operation = operation.replace(effect,
        "\t\terr = octant_metadata_check_write(filp->f_path.dentry);\n"
        "\t\tif (!err)\n\t" + effect, 1)
    operation = operation.replace(unlock, unlock + "\n\t\t}", 1)
    body_start = operation.index(lock)
    body_end = operation.index("\n\t\t}\nsetversion_out:", body_start)
    body = operation[body_start:body_end]
    body = "\n".join("\t" + line if line.startswith("\t") else line for line in body.split("\n"))
    operation = operation[:body_start] + body + operation[body_end:]
    source = source[:start] + operation + source[end:]
    path.write_text(include_bridge(source))


def install_seek_reads(kernel: Path) -> None:
    path = kernel / "fs/read_write.c"
    source = path.read_text()
    files_path = kernel / "fs/file.c"
    files = files_path.read_text()
    if "octant_seek_lock" in source or "octant_seek_lock" in files:
        raise ValueError("Seek read admission already exists")
    entry = "\tCLASS(fd_pos, f)(fd);"
    include = "#include <asm/unistd.h>\n"
    unlock = "void __f_unlock_pos(struct file *f)"
    entries = ("static off_t ksys_lseek(unsigned int fd, off_t offset, unsigned int whence)",
               "SYSCALL_DEFINE5(llseek, unsigned int, fd, unsigned long, offset_high,")
    if any(source.count(anchor) != 1 for anchor in entries) or source.count(include) != 1 or files.count(unlock) != 1:
        raise ValueError("Pinned native/compat seek or position entry differs")
    # Only the two seek syscalls use this cleanup class. fdget pins once;
    # their later lock stage retains the original fdput_pos semantics.
    source = source.replace(include, include + "\nDEFINE_CLASS(octant_seek, struct fd, fdput_pos(_T), fdget(fd), int fd)\n", 1)
    checked = "\tif (fd_empty(f))\n\t\treturn -EBADF;"
    preparation = """
	struct octant_metadata_scope admission
		__attribute__((cleanup(octant_metadata_end))) =
			octant_seek_begin(fd_file(f), whence);
	if (admission.error)
		return admission.error;
	int admission_error = octant_seek_lock(&f, admission.identity != 0);
	if (admission_error)
		return admission_error;
	if (admission.identity) {
		admission_error = octant_metadata_check_read(fd_file(f)->f_path.dentry);
		if (admission_error)
			return admission_error;
	}
"""
    for anchor in entries:
        start = source.index(anchor)
        end = source.index("\n}", start) + 2
        function = source[start:end]
        if function.count(entry) != 1 or function.count(checked) != 1:
            raise ValueError("Pinned seek reference/validation differs")
        function = function.replace(entry, "\tCLASS(octant_seek, f)(fd);", 1)
        function = function.replace(checked, checked + preparation, 1)
        source = source[:start] + function + source[end:]
    helper = """/* The seek syscall owns the READ scope through its filesystem effect.
 * Preparation happens before this lock; final comparison never performs IPC. */
int octant_seek_lock(struct fd *f, bool mediated)
{
	struct file *file = fd_file(*f);
	int error;
	if (!file)
		return -EBADF;
	if (!file_needs_f_pos_lock(file))
		return 0;
	if (mediated) {
		error = mutex_lock_killable(&file->f_pos_lock);
		if (error)
			return error;
	} else {
		mutex_lock(&file->f_pos_lock);
	}
	f->word |= FDPUT_POS_UNLOCK;
	return 0;
}

"""
    files = files.replace(unlock, helper + unlock, 1)
    path.write_text(include_bridge(source))
    files_path.write_text(include_bridge(files))


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


def install_creations(kernel: Path) -> None:
    path = kernel / "fs/namei.c"
    source = path.read_text()
    if "octant_creation_" in source:
        raise ValueError("Creation admission already exists")

    def replace(function: str, changes: dict[str, str]) -> None:
        nonlocal source
        declaration = re.search(
            rf"(?m)^(?:static\s+)?(?:int|struct dentry \*|const char \*)\s*{function}\([^;{{]*?\)\s*\{{", source)
        if declaration is None:
            raise ValueError(f"Pinned creation entry {function} differs")
        start = declaration.start()
        end = source.index("\n}", declaration.end())
        body = source[start:end]
        for anchor, replacement in changes.items():
            if body.count(anchor) != 1:
                raise ValueError(f"Pinned creation anchor differs in {function}")
            body = body.replace(anchor, replacement, 1)
        source = source[:start] + body + source[end:]

    scope = ("\n\tstruct octant_creation_scope octant_creation_admission\n"
             "\t\t__attribute__((cleanup(octant_creation_end))) = {};\n")
    # Keep exported start_creating_* signatures unchanged. Audited callers
    # carry a scope through the returned locked path.
    replace("filename_create", {
        "struct path *path, unsigned int lookup_flags)":
            "struct path *path, unsigned int lookup_flags,\n"
            "\t\t\t\t      const struct path *source_path,\n"
            "\t\t\t\t      struct octant_creation_scope *admission)",
        "\terror = filename_parentat(dfd, name, reval_flag, path, &last, &type);":
            "\tif (admission)\n\t\toctant_creation_end(admission);\n\n"
            "\terror = filename_parentat(dfd, name, reval_flag, path, &last, &type);",
        "\tinode_lock_nested(path->dentry->d_inode, I_MUTEX_PARENT);":
            "\tif (!error && admission) {\n"
            "\t\t*admission = octant_creation_begin(source_path ? OCTANT_MEDIATION_LINK :\n"
            "\t\t\tOCTANT_MEDIATION_CREATE, path, &last, source_path);\n"
            "\t\tif (admission->error) {\n\t\t\tmnt_drop_write(path->mnt);\n"
            "\t\t\tdentry = ERR_PTR(admission->error);\n\t\t\tgoto out;\n\t\t}\n\t}\n"
            "\tinode_lock_nested(path->dentry->d_inode, I_MUTEX_PARENT);",
    })
    wrapper = "filename_create(dfd, filename, path, lookup_flags);"
    if source.count(wrapper) != 2:
        raise ValueError("Pinned exported creation wrappers differ")
    source = source.replace(wrapper, "filename_create(dfd, filename, path, lookup_flags, NULL, NULL);")
    for function, call, argument, first in (
        ("do_mknodat", "filename_create(dfd, name, &path, lookup_flags)", "NULL", "struct mnt_idmap *idmap;"),
        ("do_mkdirat", "filename_create(dfd, name, &path, lookup_flags)", "NULL", "struct dentry *dentry;"),
        ("do_symlinkat", "filename_create(newdfd, to, &path, lookup_flags)", "NULL", "int error;"),
        ("do_linkat", "filename_create(newdfd, new, &new_path,\n\t\t\t\t\t(how & LOOKUP_REVAL))", "&old_path", "struct mnt_idmap *idmap;"),
    ):
        ending = "\tend_creating_path(&new_path, new_dentry);" if function == "do_linkat" else "\tend_creating_path(&path, dentry);"
        replace(function, {
            "{\n\t" + first: "{" + scope + "\t" + first,
            call: call[:-1] + ", " + argument + ", &octant_creation_admission)",
            ending: ending + "\n\toctant_creation_end(&octant_creation_admission);",
        })
    # Open's shared parent and copied final name are stable only after unlazy.
    # The preparation stays before its lock; both actual create paths consume.
    open_write = "\tif (open_flag & O_CREAT)\n\t\tinode_lock(dir->d_inode);"
    replace("open_last_lookups", {
        "{\n\tstruct dentry *dir": "{" + scope + "\tstruct dentry *dir",
        open_write: "\tif (got_write && (open_flag & O_CREAT)) {\n"
            "\t\toctant_creation_admission = octant_creation_begin(OCTANT_MEDIATION_CREATE,\n"
            "\t\t\t&nd->path, &nd->last, NULL);\n"
            "\t\tif (octant_creation_admission.error) {\n\t\t\tmnt_drop_write(nd->path.mnt);\n"
            "\t\t\treturn ERR_PTR(octant_creation_admission.error);\n\t\t}\n\t}\n" + open_write,
    })
    tmpcall = "\terror = vfs_tmpfile(mnt_idmap(path.mnt), &path, file, op->mode);"
    replace("do_tmpfile", {
        "{\n\tstruct path path;": "{" + scope + "\tstruct path path;",
        tmpcall: "\toctant_creation_admission = octant_creation_begin(OCTANT_MEDIATION_TMPFILE,\n"
            "\t\t&path, NULL, NULL);\n\terror = octant_creation_admission.error;\n"
            "\tif (error)\n\t\tgoto out2;\n" + tmpcall,
    })
    for function, effect in (
        ("vfs_create", "\terror = dir->i_op->create(idmap, dir, dentry, mode, want_excl);"),
        ("vfs_mkobj", "\terror = f(dentry, mode, arg);"),
        ("vfs_mknod", "\terror = dir->i_op->mknod(idmap, dir, dentry, mode, dev);"),
        ("vfs_symlink", "\terror = dir->i_op->symlink(idmap, dir, dentry, oldname);"),
    ):
        replace(function, {effect:
            "\terror = octant_creation_check(OCTANT_MEDIATION_CREATE, dir, dentry, NULL);\n"
            "\tif (error)\n\t\treturn error;\n" + effect})
    effect = "\tde = dir->i_op->mkdir(idmap, dir, dentry, mode);"
    replace("vfs_mkdir", {effect:
        "\terror = octant_creation_check(OCTANT_MEDIATION_CREATE, dir, dentry, NULL);\n"
        "\tif (error)\n\t\tgoto err;\n" + effect})
    effect = "\t\tif (!error)\n\t\t\terror = dir->i_op->link(old_dentry, dir, new_dentry);"
    replace("vfs_link", {effect:
        "\t\tif (!error)\n\t\t\terror = octant_creation_check(OCTANT_MEDIATION_LINK, dir, new_dentry, inode);\n" + effect})
    effect = "\terror = dir->i_op->tmpfile(idmap, dir, file, mode);"
    replace("vfs_tmpfile", {effect:
        "\terror = octant_creation_check(OCTANT_MEDIATION_TMPFILE, dir, NULL, NULL);\n"
        "\tif (error) {\n\t\tdput(child);\n\t\treturn error;\n\t}\n" + effect})
    effect = "\t\terror = dir_inode->i_op->create(idmap, dir_inode, dentry,"
    replace("lookup_open", {effect:
        "\t\terror = octant_creation_check(OCTANT_MEDIATION_CREATE, dir_inode, dentry, NULL);\n"
        "\t\tif (error)\n\t\t\tgoto out_dput;\n" + effect})
    effect = "\terror = dir->i_op->atomic_open(dir, dentry, file,"
    replace("atomic_open", {effect:
        "\tif (open_flag & O_CREAT) {\n"
        "\t\terror = octant_creation_check(OCTANT_MEDIATION_CREATE, dir, dentry, NULL);\n"
        "\t\tif (error) {\n\t\t\td_lookup_done(dentry);\n\t\t\tdput(dentry);\n"
        "\t\t\treturn ERR_PTR(error);\n\t\t}\n\t}\n" + effect})
    path.write_text(source if "#include <linux/octant_mediation_bridge.h>" in source else include_bridge(source))


def install_unix_bind(kernel: Path) -> None:
    path = kernel / "fs/namei.c"
    source = path.read_text()
    anchor = "EXPORT_SYMBOL(end_creating_path);\n"
    if source.count(anchor) != 1 or "octant_start_creating_path" in source:
        raise ValueError("Pinned scoped socket creation wrappers differ")
    wrappers = r'''

struct dentry *octant_start_creating_path(int dfd, const char *pathname,
	struct path *parent, unsigned int flags, struct octant_creation_scope *scope)
{
	struct filename *filename = getname_kernel(pathname);
	struct dentry *dentry = filename_create(dfd, filename, parent, flags, NULL, scope);

	putname(filename);
	if (IS_ERR(dentry))
		octant_creation_end(scope);
	return dentry;
}
EXPORT_SYMBOL_GPL(octant_start_creating_path);

void octant_end_creating_path(const struct path *parent, struct dentry *dentry,
	struct octant_creation_scope *scope)
{
	end_creating_path(parent, dentry);
	octant_creation_end(scope);
}
EXPORT_SYMBOL_GPL(octant_end_creating_path);

/* Called with the parent locked and no socket bind mutex. The original path
 * keeps its mount write and dentry references until end_creating_path. */
int octant_unlink_created_socket(const struct path *parent, struct dentry *dentry)
{
	struct inode *dir = d_inode(parent->dentry);
	struct inode *created = d_inode(dentry);
	struct dentry *found;
	unsigned char bytes[256];
	struct qstr name;
	int error;

	if (!octant_mediation_restricted())
		return vfs_unlink(mnt_idmap(parent->mnt), dir, dentry, NULL);
	octant_namespace_discard();
	if (!created || !S_ISSOCK(created->i_mode) ||
	    dentry->d_parent != parent->dentry || !dentry->d_name.len ||
	    dentry->d_name.len >= sizeof(bytes))
		return -EACCES;
	name.len = dentry->d_name.len;
	memcpy(bytes, dentry->d_name.name, name.len);
	bytes[name.len] = 0;
	name.name = bytes;
	name.hash = full_name_hash(parent->dentry, bytes, name.len);
	ihold(created);
	inode_unlock(dir);
	error = octant_namespace_prepare_socket_unlink(parent, &name);
	inode_lock_nested(dir, I_MUTEX_PARENT);
	if (error)
		goto out;
	/* The unlocked policy wait permits replacement. Never delete that object,
	 * even when the saved dentry still names the original socket inode. */
	found = lookup_one_qstr_excl(&name, parent->dentry, LOOKUP_REVAL);
	if (IS_ERR(found)) {
		error = PTR_ERR(found);
		goto out;
	}
	error = -EACCES;
	if (found == dentry && d_inode(found) == created &&
	    found->d_parent == parent->dentry && found->d_name.len == name.len &&
	    !memcmp(found->d_name.name, bytes, name.len))
		error = vfs_unlink(mnt_idmap(parent->mnt), dir, found, NULL);
	dput(found);
out:
	octant_namespace_discard();
	iput(created);
	return error;
}
EXPORT_SYMBOL_GPL(octant_unlink_created_socket);
'''
    path.write_text(source.replace(anchor, anchor + wrappers, 1))

    path = kernel / "net/unix/af_unix.c"
    source = path.read_text()
    start = source.index("static int unix_bind_bsd(")
    end = source.index("\n}\n", start) + 2
    body = source[start:end]
    changes = {
        "\tstruct path parent;": "\tstruct path parent;\n\tstruct octant_creation_scope admission = {};",
        "start_creating_path(AT_FDCWD, addr->name->sun_path, &parent, 0)":
            "octant_start_creating_path(AT_FDCWD, addr->name->sun_path, &parent, 0, &admission)",
        "vfs_unlink(idmap, d_inode(parent.dentry), dentry, NULL);":
            "octant_unlink_created_socket(&parent, dentry);",
    }
    for original, replacement in changes.items():
        if body.count(original) != 1:
            raise ValueError("Pinned Unix socket creation entry differs")
        body = body.replace(original, replacement, 1)
    ending = "end_creating_path(&parent, dentry);"
    if body.count(ending) != 2:
        raise ValueError("Pinned Unix socket creation cleanup differs")
    body = body.replace(ending, "octant_end_creating_path(&parent, dentry, &admission);")
    path.write_text(include_bridge(source[:start] + body + source[end:]))


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
    install_seek_reads(kernel)
    install_inode_generation_write(kernel)
    install_creations(kernel)
    install_unix_bind(kernel)
