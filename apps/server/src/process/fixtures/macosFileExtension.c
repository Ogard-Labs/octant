#include <dlfcn.h>
#include <fcntl.h>
#include <sandbox.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Native capability probe: does a file extension issued from a held directory
 * descriptor follow its object across replacement, rather than grant its name? */
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char original[4096], moved[4096], path[4096], fdpath[64];
  snprintf(original, sizeof(original), "%s/original", argv[1]);
  snprintf(moved, sizeof(moved), "%s/moved", argv[1]);
  if (mkdir(original, 0700)) return 3;
  int root = open(original, O_RDONLY | O_DIRECTORY);
  if (root < 0) return 4;
  void *library = dlopen("/usr/lib/libsandbox.1.dylib", RTLD_NOW);
  if (!library) return 5;
  char *(*issue)(const char *, const char *, unsigned int) = dlsym(library, "sandbox_extension_issue_file");
  long long (*consume)(const char *) = dlsym(library, "sandbox_extension_consume");
  if (!issue || !consume) return 6;
  snprintf(fdpath, sizeof(fdpath), "/dev/fd/%d", root);
  char *token = issue("com.octant.test.write", fdpath, 0);
  if (!token) { puts("extension-unavailable"); return 0; }
  if (rename(original, moved) || mkdir(original, 0700)) return 7;
  char *error = NULL;
  const char *profile = "(version 1)(allow default)(deny file-write*)(allow file-write* (extension \"com.octant.test.write\"))";
  if (sandbox_init(profile, 0, &error)) { if (error) sandbox_free_error(error); return 8; }
  if (consume(token) < 0) return 9;
  free(token);
  close(root);
  snprintf(path, sizeof(path), "%s/allowed", moved);
  int authorized = open(path, O_WRONLY | O_CREAT, 0600);
  if (authorized >= 0) close(authorized);
  snprintf(path, sizeof(path), "%s/denied", original);
  int replaced = open(path, O_WRONLY | O_CREAT, 0600);
  if (replaced >= 0) close(replaced);
  printf("original-object=%d replacement-object=%d\n", authorized >= 0, replaced >= 0);
  return 0;
}
