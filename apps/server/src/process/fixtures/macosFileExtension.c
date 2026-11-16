#include <dlfcn.h>
#include <fcntl.h>
#include <sandbox.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* Separate unconfined parent mutates a name only after the child consumes its
 * extension and proves an ordinary permitted write. Never log grant tokens. */
static int create(const char *directory, const char *name) {
  char path[8192];
  snprintf(path, sizeof(path), "%s/%s", directory, name);
  int fd = open(path, O_WRONLY | O_CREAT, 0600);
  if (fd < 0) return 0;
  close(fd); return 1;
}
int main(int argc, char **argv) {
  alarm(8);
  if (argc != 2) return 2;
  char original[4096], moved[4096];
  snprintf(original, sizeof(original), "%s/original", argv[1]);
  snprintf(moved, sizeof(moved), "%s/moved", argv[1]);
  if (mkdir(original, 0700)) return 3;
  void *library = dlopen("/usr/lib/libsandbox.1.dylib", RTLD_NOW);
  if (!library) return 5;
  char *(*issue)(const char *, const char *, unsigned int) = dlsym(library, "sandbox_extension_issue_file");
  long long (*consume)(const char *) = dlsym(library, "sandbox_extension_consume");
  if (!issue || !consume) return 6;
  char *token = issue("com.apple.app-sandbox.read-write", original, 0);
  if (!token) { puts("extension-unavailable"); return 0; }
  int ready[2], changed[2];
  if (pipe(ready) || pipe(changed)) return 7;
  pid_t child = fork();
  if (child < 0) return 8;
  if (!child) {
    alarm(7);
    close(ready[0]); close(changed[1]);
    char *error = NULL;
    const char *profile = "(version 1)(allow default)(deny file-write*)(allow file-write* (extension \"com.apple.app-sandbox.read-write\"))";
    if (sandbox_init(profile, 0, &error)) { if (error) sandbox_free_error(error); _exit(9); }
    if (consume(token) < 0) _exit(10);
    free(token);
    int positive = create(original, "positive");
    char byte = '1';
    if (write(ready[1], &byte, 1) != 1 || read(changed[0], &byte, 1) != 1) _exit(11);
    int authorized = create(moved, "allowed"), replacement = create(original, "denied");
    printf("ordinary-write=%d original-object=%d replacement-object=%d\n", positive, authorized, replacement);
    fflush(stdout); _exit(0);
  }
  close(ready[1]); close(changed[0]);
  char byte;
  if (read(ready[0], &byte, 1) != 1 || rename(original, moved) || mkdir(original, 0700) || write(changed[1], "1", 1) != 1) { kill(child, SIGKILL); return 12; }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 13;
  return WEXITSTATUS(status);
}
