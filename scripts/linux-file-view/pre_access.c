#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fanotify.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

/* Original bounded stock-kernel check. No product policy is implemented. */
#ifndef FAN_PRE_ACCESS
#define FAN_PRE_ACCESS 0x00100000
#endif
static const char sentinel[] = "synthetic-access-bytes";
static volatile sig_atomic_t stopping;
struct answer { int passed, error; };
static void interrupted(int number) { stopping = number; }

static bool transfer(int fd, void *bytes, size_t size, bool output) {
  size_t used = 0;
  while (used < size && !stopping) {
    struct pollfd ready = {.fd = fd, .events = output ? POLLOUT : POLLIN};
    int result = poll(&ready, 1, 2000);
    if (result < 0 && errno == EINTR) continue;
    if (result != 1 || !(ready.revents & ready.events)) return false;
    ssize_t amount = output ? write(fd, (char *)bytes + used, size - used)
                            : read(fd, (char *)bytes + used, size - used);
    if (amount < 0 && errno == EINTR) continue;
    if (amount <= 0) return false;
    used += (size_t)amount;
  }
  return used == size;
}

static void client(const char *path, const char *alias, int control, int results) {
  alarm(15);
  int held = open(path, O_RDONLY | O_CLOEXEC);
  int linked = open(alias, O_RDONLY | O_CLOEXEC);
  if (held < 0 || linked < 0) _exit(2);
  struct stat first, second;
  if (fstat(held, &first) || fstat(linked, &second) || first.st_dev != second.st_dev || first.st_ino != second.st_ino) _exit(2);
  for (;;) {
    char command;
    if (!transfer(control, &command, 1, false)) _exit(3);
    if (command == 'q') break;
    struct answer answer = {0};
    errno = 0;
    if (command == 'm' || command == 'M') {
      void *mapped = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, held, 0);
      answer.error = errno;
      answer.passed = command == 'M' ? mapped == MAP_FAILED && (errno == EACCES || errno == EPERM)
        : mapped != MAP_FAILED && !memcmp(mapped, sentinel, sizeof(sentinel) - 1);
      if (mapped != MAP_FAILED) munmap(mapped, 4096);
    } else {
      char bytes[64];
      bool deny = command == 'D' || command == 'L';
      ssize_t amount = pread(command == 'l' || command == 'L' ? linked : held, bytes, sizeof(bytes), 0);
      answer.error = errno;
      answer.passed = deny ? amount == -1 && (errno == EACCES || errno == EPERM)
        : amount == (ssize_t)sizeof(sentinel) - 1 && !memcmp(bytes, sentinel, sizeof(sentinel) - 1);
    }
    if (!transfer(results, &answer, sizeof(answer), true)) _exit(4);
  }
  close(held); close(linked); close(control); close(results);
  _exit(0);
}

static bool permission(int *group, pid_t child, unsigned response, bool abandon) {
  struct pollfd ready = {.fd = *group, .events = POLLIN};
  if (poll(&ready, 1, 2000) != 1) return false;
  char buffer[4096] __attribute__((aligned(8)));
  ssize_t length = read(*group, buffer, sizeof(buffer));
  if (length < (ssize_t)sizeof(struct fanotify_event_metadata)) return false;
  struct fanotify_event_metadata *event = (void *)buffer;
  bool valid = event->vers == FANOTIFY_METADATA_VERSION && event->event_len == (unsigned)length &&
    event->metadata_len >= sizeof(*event) && (event->mask & FAN_PRE_ACCESS) && event->pid == child && event->fd >= 0;
  if (!valid) {
    if (event->fd >= 0) close(event->fd);
    return false;
  }
  if (abandon) { close(*group); *group = -1; }
  else {
    struct fanotify_response answer = {.fd = event->fd, .response = response};
    valid = write(*group, &answer, sizeof(answer)) == (ssize_t)sizeof(answer);
  }
  close(event->fd);
  return valid;
}

int main(void) {
  signal(SIGTERM, interrupted); signal(SIGINT, interrupted); signal(SIGALRM, interrupted);
  signal(SIGPIPE, SIG_IGN); alarm(18);
  char directory[] = "/tmp/octant-pre-access-XXXXXX";
  char path[256], alias[256], companion[256];
  int group = -1, commands[2] = {-1, -1}, answers[2] = {-1, -1}, failure = 0, measured = 0;
  pid_t child = -1;
  bool child_joined = false;
  struct stat owned;
  struct utsname kernel;
  if (!mkdtemp(directory) || stat(directory, &owned)) return 2;
  snprintf(path, sizeof(path), "%s/ordinary", directory);
  snprintf(alias, sizeof(alias), "%s/alias", directory);
  snprintf(companion, sizeof(companion), "%s/ordinary.pub", directory);
  int seed = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (seed < 0 || write(seed, sentinel, sizeof(sentinel) - 1) != (ssize_t)sizeof(sentinel) - 1) failure = errno ? errno : EIO;
  if (seed >= 0) close(seed);
  if (!failure && link(path, alias)) failure = errno;
  if (!failure) group = fanotify_init(FAN_CLASS_PRE_CONTENT | FAN_CLOEXEC | FAN_NONBLOCK, O_RDONLY | O_CLOEXEC);
  if (!failure && group < 0) failure = errno;
  if (!failure && fanotify_mark(group, FAN_MARK_ADD, FAN_PRE_ACCESS, AT_FDCWD, path)) failure = errno;
  if (!failure && (pipe2(commands, O_CLOEXEC) || pipe2(answers, O_CLOEXEC))) failure = errno;
  if (!failure) {
    child = fork();
    if (child == 0) {
      close(group); close(commands[1]); close(answers[0]);
      client(path, alias, commands[0], answers[1]);
    }
    if (child < 0) failure = errno;
    close(commands[0]); commands[0] = -1; close(answers[1]); answers[1] = -1;
  }
  const char operations[] = {'r', 'l', 'm', 'D', 'L', 'M', 'r', 'r'};
  bool passed[8] = {false};
  for (int step = 0; step < 8 && !failure && !stopping; step++) {
    if (step == 3) {
      int marker = open(companion, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
      if (marker < 0) { failure = errno; break; }
      close(marker);
    }
    char command = operations[step];
    if (!transfer(commands[1], &command, 1, true) ||
        (step < 7 && !permission(&group, child, step >= 3 ? FAN_DENY : FAN_ALLOW, step == 6))) {
      failure = EPROTO; break;
    }
    struct answer answer;
    if (!transfer(answers[0], &answer, sizeof(answer), false)) { failure = EPROTO; break; }
    passed[step] = answer.passed;
    measured++;
  }
  if (child > 0) {
    char quit = 'q';
    if (failure || stopping || !transfer(commands[1], &quit, 1, true)) kill(child, SIGKILL);
    int status = 0;
    pid_t joined;
    do { joined = waitpid(child, &status, 0); } while (joined < 0 && errno == EINTR);
    child_joined = joined == child;
    if (joined != child || !WIFEXITED(status) || WEXITSTATUS(status)) failure = failure ? failure : ECHILD;
  }
  if (group >= 0) close(group);
  for (int i = 0; i < 2; i++) { if (commands[i] >= 0) close(commands[i]); if (answers[i] >= 0) close(answers[i]); }
  struct stat retained;
  bool cleaned = !lstat(directory, &retained) && retained.st_dev == owned.st_dev && retained.st_ino == owned.st_ino;
  if (cleaned) { unlink(companion); unlink(alias); unlink(path); cleaned = rmdir(directory) == 0; }
  if (!cleaned) failure = failure ? failure : EBUSY;
  bool complete = !failure && !stopping && measured == 8;
  bool controls = true;
  for (int i = 0; i < 6; i++) controls = controls && passed[i];
  if (uname(&kernel)) strcpy(kernel.release, "unknown");
  printf("{\"status\":\"%s\",\"kernel\":\"%s\",\"productionReady\":false,\"errno\":%d,\"measured\":%d,\"readAliasAndWarmMmapControls\":%s,\"unansweredReadAllowedOnGroupClose\":%s,\"laterReadUngatedAfterClose\":%s,\"ownedChildJoined\":%s,\"cleaned\":%s}\n",
    complete && controls ? "measured-stock-pre-access" : "blocked-or-failed", kernel.release, failure, measured,
    controls ? "true" : "false", passed[6] ? "true" : "false", passed[7] ? "true" : "false", child_joined ? "true" : "false", cleaned ? "true" : "false");
  return complete && controls ? 0 : 1;
}
