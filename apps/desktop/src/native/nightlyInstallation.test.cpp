#define OCTANT_INSTALLATION_TEST
#include "nightlyInstallation.mm"
#include <cassert>
#include <fstream>
#include <iostream>
#include <thread>
using namespace octant::nightly_installation;

int main(int argc, char **argv) {
  assert(argc == 4);
  @autoreleasepool {
    const std::string root(argv[1]);
    Fd directory(open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
    assert(directory.value >= 0);
    auto owned = std::make_shared<State>();
    const auto deadline = Clock::now() + std::chrono::seconds(10);
    // The former lexical check accepted this pair, which resolves above root.
    assert(symlinkat(".", directory.value, "b") == 0);
    assert(symlinkat("b/../outside", directory.value, "a") == 0);
    assert(internal_link({bundle_name, "a"}, "b/../outside"));
    assert(!resolved_link_inside(directory.value, {bundle_name, "a"}, owned, 0, deadline));
    assert(unlinkat(directory.value, "a", 0) == 0);
    assert(unlinkat(directory.value, "b", 0) == 0);
    assert(mkdirat(directory.value, "Versions", 0700) == 0);
    assert(mkdirat(directory.value, "Versions/A", 0700) == 0);
    Fd content(openat(directory.value, "Versions/A/Framework", O_WRONLY | O_CREAT | O_EXCL, 0600));
    assert(content.value >= 0);
    assert(symlinkat("A", directory.value, "Versions/Current") == 0);
    assert(symlinkat("Versions/Current/Framework", directory.value, "Framework") == 0);
    assert(symlinkat("../A/Framework", directory.value, "Versions/A/Relative") == 0);
    for (const auto &path : {std::vector<std::string>{bundle_name, "Framework"}, {bundle_name, "Versions", "A", "Relative"}})
      assert(resolved_link_inside(directory.value, path, owned, 0, deadline));
    assert(remove_children(directory.value));
    const auto archive = [](const char *path) {
      std::ifstream input(path, std::ios::binary);
      return std::vector<uint8_t>(std::istreambuf_iterator<char>(input), {});
    };
    assert(extract_zip(archive(argv[2]), directory.value, owned, 0, deadline));
    struct stat metadata{};
    assert(fstatat(directory.value, "__MACOSX", &metadata, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT);
    assert(remove_children(directory.value));
    assert(!extract_zip(archive(argv[3]), directory.value, owned, 0, deadline));
    assert(remove_children(directory.value));
    assert(mkdirat(directory.value, "Contents", 0700) == 0);
    assert(mkdirat(directory.value, "Contents/MacOS", 0700) == 0);
    Fd binary(openat(directory.value, "Contents/MacOS/Octant Nightly", O_WRONLY | O_CREAT | O_EXCL, 0600));
    assert(binary.value >= 0);
    mach_header_64 header{};
    header.magic = MH_MAGIC_64; header.cputype = CPU_TYPE_ARM64; header.filetype = MH_EXECUTE;
    header.ncmds = 1; header.sizeofcmds = sizeof(build_version_command);
    build_version_command version{};
    version.cmd = LC_BUILD_VERSION; version.cmdsize = sizeof(version);
    version.platform = PLATFORM_MACOS; version.minos = 14 << 16;
    assert(write(binary.value, &header, sizeof(header)) == sizeof(header));
    assert(write(binary.value, &version, sizeof(version)) == sizeof(version));
    assert(compatible_executable(root));
    version.minos = 255 << 16;
    assert(pwrite(binary.value, &version, sizeof(version), sizeof(header)) == sizeof(version));
    assert(!compatible_executable(root));
    version.minos = 14 << 16; version.platform = PLATFORM_IOS;
    assert(pwrite(binary.value, &version, sizeof(version), sizeof(header)) == sizeof(version));
    assert(!compatible_executable(root));
    header.cputype = CPU_TYPE_X86_64;
    assert(pwrite(binary.value, &header, sizeof(header), 0) == sizeof(header));
    assert(!compatible_executable(root));
    assert(remove_children(directory.value));

    Stage stage;
    stage.parent.value = dup(directory.value);
    stage.parent_path = root;
    assert(fstat(stage.parent.value, &stage.parent_identity) == 0);
    stage.name = "stage";
    assert(mkdirat(directory.value, "stage", 0700) == 0);
    stage.directory.value = openat(directory.value, "stage", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    assert(fstat(stage.directory.value, &stage.identity) == 0);
    assert(mkdirat(stage.directory.value, bundle_name, 0700) == 0);
    assert(mkdirat(directory.value, bundle_name, 0700) == 0);
    struct stat existing{}, after{};
    assert(fstatat(directory.value, bundle_name, &existing, AT_SYMLINK_NOFOLLOW) == 0);
    assert(!publish_exclusive(stage) && errno == EEXIST);
    assert(fstatat(directory.value, bundle_name, &after, AT_SYMLINK_NOFOLLOW) == 0 && same_node(existing, after));
    assert(unlinkat(directory.value, bundle_name, AT_REMOVEDIR) == 0);
    assert(publish_exclusive(stage));
    // A directory acquisition failure must retain a recoverable owned name.
    assert(::close(stage.directory.value) == 0);
    stage.directory.value = -1;
    assert(discard(std::shared_ptr<Stage>(&stage, [](Stage *) {})));
    assert(remove_children(directory.value));

    // Actual pending callbacks remain owned even after the worker stops busy.
    owned->pending_jobs = 1;
    const auto failed = cleanup(owned, true);
    assert(failed.kind == "failed" && failed.reason == "deadline-exceeded");
    assert(owned->closed);
    owned->pending_jobs = 0;
    assert(cleanup(owned, true).kind == "closed");
    std::cout << "bounded archive, symlink, exclusive publish and actual drain checks passed\n";
  }
}
