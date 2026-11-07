#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Compatibility measurement only: this is not a filesystem policy. */
static const int calls[] = {
  SYS_io_uring_setup, SYS_io_uring_enter, SYS_io_uring_register,
  SYS_io_setup, SYS_io_submit, SYS_io_cancel, SYS_io_getevents,
  SYS_io_pgetevents, SYS_io_destroy,
};

int main(int count, char **arguments) {
  if (count == 2 && (strcmp(arguments[1], "check-network") == 0 ||
      strcmp(arguments[1], "check-network-child") == 0)) {
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return 1;
    unsigned unexpected = 0, refused = 0;
    struct dirent *entry;
    while ((entry = readdir(directory))) {
      if (entry->d_name[0] == '.') continue;
      int descriptor = atoi(entry->d_name);
      struct stat identity;
      if (descriptor != dirfd(directory) &&
          (descriptor > 2 || fstat(descriptor, &identity) || S_ISSOCK(identity.st_mode))) unexpected++;
    }
    closedir(directory);
    const int network[] = {SYS_socket, SYS_connect, SYS_sendto, SYS_sendmsg, SYS_sendmmsg};
    for (unsigned i = 0; i < sizeof(network) / sizeof(network[0]); i++) {
      errno = 0;
      if (syscall(network[i], AF_INET, 0, 0, 0, 0, 0) == -1 && errno == EACCES) refused++;
    }
    bool descendant = strcmp(arguments[1], "check-network-child") == 0;
    if (!descendant) {
      pid_t child = fork();
      if (child == 0) { execl(arguments[0], arguments[0], "check-network-child", NULL); _exit(2); }
      int status;
      descendant = child > 0 && waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    }
    printf("{\"networkRefusals\":%u,\"unexpectedInheritedDescriptors\":%u,\"descendantPassed\":%s}\n",
      refused, unexpected, descendant ? "true" : "false");
    return refused == 5 && unexpected == 0 && descendant ? 0 : 1;
  }
  if (count == 3 && strcmp(arguments[1], "check") == 0) {
    int expected = atoi(arguments[2]);
    unsigned refused = 0;
    for (unsigned i = 0; i < sizeof(calls) / sizeof(calls[0]); i++) {
      errno = 0;
      if (syscall(calls[i], 0, 0, 0, 0, 0, 0) == -1 && errno == expected) refused++;
    }
    printf("{\"refused\":%u,\"expected\":%zu,\"errno\":%d}\n", refused,
      sizeof(calls) / sizeof(calls[0]), expected);
    return refused == sizeof(calls) / sizeof(calls[0]) ? 0 : 1;
  }
  if (count < 4 || (strcmp(arguments[1], "EPERM") && strcmp(arguments[1], "ENOSYS"))) return 2;
#if !defined(__x86_64__)
  fputs("This bounded compatibility fixture requires x86_64 Linux.\n", stderr);
  return 2;
#else
  int refusal = strcmp(arguments[1], "EPERM") == 0 ? EPERM : ENOSYS;
  bool no_network = strcmp(arguments[2], "--no-network") == 0;
  int command = no_network ? 3 : 2;
  if (count <= command) return 2;
  struct sock_filter filter[48];
  unsigned used = 0;
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
  filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1);
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | refusal);
  for (unsigned i = 0; i < sizeof(calls) / sizeof(calls[0]); i++) {
    filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, calls[i], 0, 1);
    filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | refusal);
  }
  if (no_network) {
    const int network[] = {SYS_socket, SYS_connect, SYS_sendto, SYS_sendmsg, SYS_sendmmsg};
    for (unsigned i = 0; i < sizeof(network) / sizeof(network[0]); i++) {
      filter[used++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, network[i], 0, 1);
      filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES);
    }
  }
  filter[used++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog program = { .len = used, .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) {
    perror("compatibility seccomp");
    return 2;
  }
  execvp(arguments[command], &arguments[command]);
  perror("compatibility exec");
  return 2;
#endif
}
