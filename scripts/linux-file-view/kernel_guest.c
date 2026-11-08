/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../../apps/server/native/linux-mediation/octant_mediation.h"

static const char content[] = "synthetic-kernel-admission";
static volatile sig_atomic_t interrupted;
struct thread_read { int file, passed; };
static void *read_on_thread(void *argument)
{
  struct thread_read *input = argument;
  char bytes[64];
  ssize_t count = pread(input->file, bytes, sizeof(bytes), 0);
  input->passed = count == (ssize_t)sizeof(content) - 1 && !memcmp(bytes, content, sizeof(content) - 1);
  return NULL;
}
static void alarmed(int number) { interrupted = number; }
static bool transfer(int fd, void *data, size_t length, bool output)
{
  struct pollfd readiness = { .fd = fd, .events = output ? POLLOUT : POLLIN };
  if (interrupted || poll(&readiness, 1, 3000) != 1 || !(readiness.revents & readiness.events)) return false;
  return (output ? write(fd, data, length) : read(fd, data, length)) == (ssize_t)length;
}

static bool send_descriptor(int socket, int file)
{
  char byte = 'F';
  struct iovec data = {.iov_base = &byte, .iov_len = 1};
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = {.msg_iov = &data, .msg_iovlen = 1,
    .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &file, sizeof(file));
  return sendmsg(socket, &message, MSG_NOSIGNAL) == 1;
}
static int receive_descriptor(int socket, bool *truncated)
{
  char byte = 0;
  struct iovec data = {.iov_base = &byte, .iov_len = 1};
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = {.msg_iov = &data, .msg_iovlen = 1,
    .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  if (recvmsg(socket, &message, MSG_CMSG_CLOEXEC) != 1 || byte != 'F') return -2;
  *truncated = (message.msg_flags & MSG_CTRUNC) != 0;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  int file = -1;
  if (header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS &&
      header->cmsg_len == CMSG_LEN(sizeof(int))) memcpy(&file, CMSG_DATA(header), sizeof(file));
  return file;
}
static bool same_policy_transfer(int inherited)
{
  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, sockets)) return false;
  pid_t peer = fork();
  if (!peer) { close(sockets[0]); _exit(send_descriptor(sockets[1], inherited) ? 0 : 1); }
  close(sockets[1]);
  if (peer < 0) { close(sockets[0]); return false; }
  // Reap the sender first: the queued record must retain the actual sending
  // credentials after that process has exited, without looking up its PID.
  int result = 0; pid_t joined;
  do { joined = waitpid(peer, &result, 0); } while (joined < 0 && errno == EINTR);
  bool truncated = false;
  int received = receive_descriptor(sockets[0], &truncated);
  char bytes[64];
  bool passed = received >= 0 && !truncated && pread(received, bytes, sizeof(bytes), 0) == sizeof(content) - 1;
  if (received >= 0) close(received);
  close(sockets[0]);
  return passed && joined == peer && WIFEXITED(result) && WEXITSTATUS(result) == 0;
}
static bool same_policy_shared_memory(void)
{
  int *page = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (page == MAP_FAILED) return false;
  *page = 42;
  pid_t peer = fork();
  if (!peer) { *page = 43; _exit(0); }
  int result = 0; pid_t joined = -1;
  if (peer > 0) do { joined = waitpid(peer, &result, 0); } while (joined < 0 && errno == EINTR);
  bool passed = peer > 0 && joined == peer && WIFEXITED(result) && WEXITSTATUS(result) == 0 && *page == 43;
  munmap(page, 4096);
  return passed;
}

static void workload(int enrollment, int commands, int results, int foreign)
{
  int held = open("/tmp/ordinary", O_RDONLY | O_CLOEXEC);
  int alias = open("/tmp/alias", O_RDONLY | O_CLOEXEC);
  int output = open("/tmp/ordinary", O_WRONLY | O_CLOEXEC);
  if (held < 0 || alias < 0 || output < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(2);
  close(enrollment);
  for (;;) {
    char command;
    if (!transfer(commands, &command, 1, false)) _exit(3);
    if (command == 'q') _exit(0);
    bool denied = command == 'D' || command == 'M' || command == 'X';
    int passed;
    errno = 0;
    if (command == 'c') {
      passed = same_policy_transfer(held);
    } else if (command == 'g') {
      passed = same_policy_shared_memory();
    } else if (command == 'n' || command == 'p') {
      bool truncated = false;
      int received = receive_descriptor(foreign, &truncated);
      passed = received == -1 && truncated;
      if (received >= 0) close(received);
    } else if (command == 'F') {
      passed = ftruncate(output, 0) == -1 && errno == EACCES;
    } else if (command == 'P') {
      passed = truncate("/tmp/ordinary", 0) == -1 && errno == EACCES;
    } else if (command == 'O') {
      int opened = open("/tmp/ordinary", O_TRUNC | O_WRONLY | O_CLOEXEC);
      passed = opened == -1 && errno == EACCES;
      if (opened >= 0) close(opened);
    } else if (command == 'a') {
      unsigned long context = 0;
      long ring = syscall(SYS_io_uring_setup, 1, NULL);
      int ring_error = errno;
      long aio = syscall(SYS_io_setup, 1, &context);
      passed = ring == -1 && ring_error == ENOSYS && aio == -1 && errno == ENOSYS;
    } else if (command == 't') {
      struct thread_read input = {.file = held};
      pthread_t thread;
      passed = pthread_create(&thread, NULL, read_on_thread, &input) == 0;
      if (passed) passed = pthread_join(thread, NULL) == 0 && input.passed;
    } else if (command == 'w') {
      passed = pwrite(output, content, sizeof(content) - 1, 0) == (ssize_t)sizeof(content) - 1;
    } else if (command == 'm' || command == 'M') {
      void *mapped = mmap(NULL, 4096, PROT_READ, MAP_PRIVATE, held, 0);
      passed = denied ? mapped == MAP_FAILED && errno == EACCES :
        mapped != MAP_FAILED && !memcmp(mapped, content, sizeof(content) - 1);
      if (mapped != MAP_FAILED) munmap(mapped, 4096);
    } else {
      char bytes[64];
      ssize_t count = pread(command == 'l' ? alias : held, bytes, sizeof(bytes), 0);
      passed = command == 'S' ? count == -1 && errno == EAGAIN :
        denied ? count == -1 && errno == EACCES :
          count == (ssize_t)sizeof(content) - 1 && !memcmp(bytes, content, sizeof(content) - 1);
    }
    if (!transfer(results, &passed, sizeof(passed), true)) _exit(4);
  }
}

static bool refuses_inherited_proc(int broker)
{
  int enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  if (enrollment < 0) return false;
  pid_t child = fork();
  if (!child) {
    close(broker);
    int memory = open("/proc/self/mem", O_RDONLY | O_CLOEXEC);
    if (memory < 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) _exit(1);
    errno = 0;
    if (ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0) != -1 || errno != EPERM) _exit(2);
    close(memory);
    /* Refusal must not consume enrollment or change the starting principal. */
    _exit(ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0) ? 3 : 0);
  }
  close(enrollment);
  if (child < 0) return false;
  int result; pid_t joined;
  do { joined = waitpid(child, &result, 0); } while (joined < 0 && errno == EINTR);
  return joined == child && WIFEXITED(result) && WEXITSTATUS(result) == 0;
}

static int measure(void)
{
  signal(SIGALRM, alarmed); alarm(25);
  int seed = open("/tmp/ordinary", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
  if (seed < 0 || write(seed, content, sizeof(content) - 1) != (ssize_t)sizeof(content) - 1) return 1;
  close(seed);
  if (link("/tmp/ordinary", "/tmp/alias")) return 2;
  struct stat inode;
  if (stat("/tmp/ordinary", &inode)) return 3;
  int broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  if (broker < 0) { printf("OCTANT_KERNEL_DEVICE_ERRNO %d\n", errno); return 4; }
  struct octant_mediation_status status;
  if (ioctl(broker, OCTANT_MEDIATION_STATUS, &status) || status.abi != OCTANT_MEDIATION_ABI ||
      status.production_coverage != 0) { close(broker); return 5; }
  if (!refuses_inherited_proc(broker)) { close(broker); return 9; }
  int enrollment = ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  int commands[2], answers[2], foreign[2];
  if (enrollment < 0 || pipe2(commands, O_CLOEXEC) || pipe2(answers, O_CLOEXEC) ||
      socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, foreign)) { close(broker); return 6; }
  // Queue an actual foreign record before the receiver enrolls. The later
  // receiver context cannot retroactively turn that sender into its peer.
  int queued = open("/tmp/ordinary", O_RDONLY | O_CLOEXEC);
  if (queued < 0 || !send_descriptor(foreign[0], queued)) return 10;
  close(queued);
  pid_t child = fork();
  if (child == 0) {
    struct octant_mediation_status forwarded;
    struct octant_mediation_request request;
    struct octant_mediation_answer answer = {0};
    errno = 0;
    if (ioctl(broker, OCTANT_MEDIATION_STATUS, &forwarded) != -1 || errno != EPERM) _exit(40);
    errno = 0;
    if (read(broker, &request, sizeof(request)) != -1 || errno != EPERM) _exit(41);
    errno = 0;
    if (write(broker, &answer, sizeof(answer)) != -1 || errno != EPERM) _exit(42);
    errno = 0;
    if (ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0) != -1 || errno != EPERM) _exit(43);
    struct octant_mediation_parent parent = {0};
    errno = 0;
    if (ioctl(broker, OCTANT_MEDIATION_PARENT_FD, &parent) != -1 || errno != EPERM) _exit(44);
    close(broker); close(commands[1]); close(answers[0]); close(foreign[0]);
    workload(enrollment, commands[0], answers[1], foreign[1]);
  }
  close(enrollment); close(commands[0]); close(answers[1]); close(foreign[1]);
  if (child < 0) { close(broker); close(commands[1]); close(answers[0]); return 7; }
  const char operations[] = {'r', 'l', 'm', 't', 'c', 'g', 'n', 'p', 'w', 'a', 'S', 'D', 'M', 'F', 'P', 'O', 'X', 'X'};
  bool passed = true;
  unsigned measured = 0;
  unsigned long long previous = 0;
  for (unsigned i = 0; i < sizeof(operations) && passed; i++) {
    char command = operations[i];
    if (command == 'p') {
      int file = open("/proc/self/mem", O_RDONLY | O_CLOEXEC);
      passed = file >= 0 && send_descriptor(foreign[0], file);
      if (file >= 0) close(file);
    }
    passed = passed && transfer(commands[1], &command, 1, true);
    if (passed && command != 'a' && command != 'g' && command != 'n' && command != 'p' && broker >= 0) {
      struct octant_mediation_request request;
      passed = transfer(broker, &request, sizeof(request), false) &&
        request.request_id > previous && request.reserved == 0 &&
        request.inode == (unsigned long long)inode.st_ino &&
        request.device_major == major(inode.st_dev) && request.device_minor == minor(inode.st_dev) &&
        request.operation == (command == 'm' || command == 'M' ? OCTANT_MEDIATION_MAP :
          command == 'w' || command == 'F' || command == 'P' || command == 'O' ?
            OCTANT_MEDIATION_WRITE : OCTANT_MEDIATION_READ);
      if (!passed) break;
      printf("OCTANT_KERNEL_STEP %u operation=%u epoch=%llu\n", i,
        request.operation, (unsigned long long)request.namespace_epoch);
      previous = request.request_id;
      if (command == 'X') { close(broker); broker = -1; }
      else {
        if (command == 'S') {
          int marker = open("/tmp/ordinary.pub", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
          if (marker < 0) { passed = false; break; }
          close(marker);
          struct octant_mediation_status changed = {0};
          passed = !ioctl(broker, OCTANT_MEDIATION_STATUS, &changed) &&
            changed.namespace_epoch > request.namespace_epoch && changed.active_mutations == 0;
          printf("OCTANT_KERNEL_MUTATION before=%llu after=%llu active=%u\n",
            (unsigned long long)request.namespace_epoch,
            (unsigned long long)changed.namespace_epoch, changed.active_mutations);
          if (!passed) break;
        }
        struct octant_mediation_answer answer = {
          .request_id = request.request_id,
          .namespace_epoch = request.namespace_epoch,
          .allow = command == 'r' || command == 'l' || command == 'm' || command == 't' || command == 'c' || command == 'w' || command == 'S',
        };
        passed = write(broker, &answer, sizeof(answer)) == sizeof(answer);
      }
    }
    int answer = 0;
    passed = passed && transfer(answers[0], &answer, sizeof(answer), false) && answer == 1;
    measured++;
  }
  char quit = 'q';
  if (!passed || !transfer(commands[1], &quit, 1, true)) kill(child, SIGKILL);
  int exit = 0;
  pid_t joined;
  do { joined = waitpid(child, &exit, 0); } while (joined < 0 && errno == EINTR);
  bool reaped = joined == child;
  passed = passed && reaped && WIFEXITED(exit) && WEXITSTATUS(exit) == 0;
  close(commands[1]); close(answers[0]); close(foreign[0]); if (broker >= 0) close(broker);
  bool cleaned = !unlink("/tmp/ordinary.pub") && !unlink("/tmp/alias") && !unlink("/tmp/ordinary");
  printf("OCTANT_KERNEL_EVIDENCE {\"status\":\"%s\",\"productionReady\":false,\"measurements\":%u,\"inheritedProcRefused\":true,\"pendingAndNewReadDeniedOnBrokerClose\":%s,\"ownedChildJoined\":%s,\"cleaned\":%s}\n",
    passed && cleaned ? "measured-admission-core" : "failed", measured,
    passed ? "true" : "false", reaped ? "true" : "false", cleaned ? "true" : "false");
  return passed && cleaned ? 0 : 8;
}

static bool named(const struct octant_mediation_name *name, const struct stat *parent, const char *leaf)
{
  return name->parent_inode == (unsigned long long)parent->st_ino &&
    name->device_major == major(parent->st_dev) && name->device_minor == minor(parent->st_dev) &&
    name->length == strlen(leaf) && !name->reserved && !memcmp(name->bytes, leaf, name->length);
}

/* Synthetic decisions below test the real pre-lock transport and final token,
 * not the still-unintegrated structured-policy broker. */
static int namespace_measure(void)
{
  const char *files[] = {"key", "key.pub", "folder.pub", "public.pub", "stale.pub", "live"};
  if (mkdir("/tmp/ns", 0700) || mkdir("/tmp/ns/folder", 0700) ||
      mkdir("/tmp/ns/unrelated", 0700) || mkdir("/tmp/ns/empty", 0700)) return 21;
  for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); i++) {
    char path[80]; snprintf(path, sizeof(path), "/tmp/ns/%s", files[i]);
    int file = open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (file < 0 || write(file, content, sizeof(content) - 1) != sizeof(content) - 1) return 22;
    close(file);
  }
  if (link("/tmp/ns/public.pub", "/tmp/ns/alias.pub")) return 23;
  struct stat parent;
  if (stat("/tmp/ns", &parent)) return 24;
  int broker = open("/dev/octant_mediation", O_RDWR | O_CLOEXEC | O_NONBLOCK);
  int enrollment = broker < 0 ? -1 : ioctl(broker, OCTANT_MEDIATION_ENROLL_FD, 0);
  int results[2];
  if (enrollment < 0 || pipe2(results, O_CLOEXEC)) return 25;
  pid_t child = fork();
  if (!child) {
    close(broker); close(results[0]);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || ioctl(enrollment, OCTANT_MEDIATION_ENROLL, 0)) _exit(26);
    close(enrollment);
    for (unsigned i = 0; i < 9; i++) {
      int result;
      errno = 0;
      switch (i) {
      case 0: result = unlink("/tmp/ns/key.pub"); break;
      case 1: result = rename("/tmp/ns/key.pub", "/tmp/ns/moved.pub"); break;
      case 2: result = rename("/tmp/ns/folder", "/tmp/ns/moved-folder"); break;
      case 3: result = unlink("/tmp/ns/alias.pub"); break;
      case 4: result = rename("/tmp/ns/unrelated", "/tmp/ns/moved-unrelated"); break;
      case 5: result = rmdir("/tmp/ns/empty"); break;
      case 6: result = unlink("/tmp/ns/stale.pub"); break;
      case 7: result = unlink("/tmp/ns/key.pub"); break;
      default: result = rename("/tmp/ns/folder", "/tmp/ns/moved-folder"); break;
      }
      int passed = i >= 3 && i <= 5 ? result == 0 :
        result == -1 && errno == (i == 6 ? EAGAIN : EACCES);
      if (!transfer(results[1], &passed, sizeof(passed), true) || !passed) _exit(27);
    }
    _exit(0);
  }
  close(enrollment); close(results[1]);
  if (child < 0) { close(results[0]); close(broker); return 28; }
  const char *source[] = {"key.pub", "key.pub", "folder", "alias.pub", "unrelated", "empty", "stale.pub", "key.pub"};
  const char *destination[] = {NULL, "moved.pub", "moved-folder", NULL, "moved-unrelated", NULL, NULL, NULL};
  bool passed = true;
  unsigned measured = 0;
  for (unsigned i = 0; i < 9 && passed; i++) {
    if (i < 8) {
      struct octant_mediation_request request;
      passed = transfer(broker, &request, sizeof(request), false) && !request.flags && !request.padding &&
        named(&request.source, &parent, source[i]) && request.operation ==
        (destination[i] ? OCTANT_MEDIATION_RENAME : i == 5 ? OCTANT_MEDIATION_RMDIR : OCTANT_MEDIATION_UNLINK);
      if (passed && destination[i]) passed = named(&request.destination, &parent, destination[i]);
      if (passed && i == 6) {
        /* Same-parent external rename must finish while the broker waits:
         * there is no parent inode lock held across this policy decision. */
        passed = rename("/tmp/ns/live", "/tmp/ns/live-moved") == 0;
      }
      if (passed && i == 7) { close(broker); broker = -1; }
      else if (passed) {
        struct octant_mediation_answer answer = {.request_id = request.request_id,
          .namespace_epoch = request.namespace_epoch, .allow = i >= 3 && i <= 6};
        passed = write(broker, &answer, sizeof(answer)) == sizeof(answer);
      }
    }
    int result = 0;
    passed = passed && transfer(results[0], &result, sizeof(result), false) && result == 1;
    printf("OCTANT_KERNEL_NAMESPACE_STEP %u passed=%u\n", i, passed);
    measured++;
  }
  if (!passed) kill(child, SIGKILL);
  int exit = 0; pid_t joined;
  do { joined = waitpid(child, &exit, 0); } while (joined < 0 && errno == EINTR);
  bool reaped = joined == child;
  passed = passed && reaped && WIFEXITED(exit) && WEXITSTATUS(exit) == 0;
  close(results[0]); if (broker >= 0) close(broker);
  bool controls = access("/tmp/ns/key", F_OK) == 0 && access("/tmp/ns/key.pub", F_OK) == 0 &&
    access("/tmp/ns/folder", F_OK) == 0 && access("/tmp/ns/public.pub", F_OK) == 0 &&
    access("/tmp/ns/moved-unrelated", F_OK) == 0 && access("/tmp/ns/stale.pub", F_OK) == 0;
  for (unsigned i = 0; i < sizeof(files) / sizeof(files[0]); i++) {
    char path[80]; snprintf(path, sizeof(path), "/tmp/ns/%s", files[i]); unlink(path);
  }
  unlink("/tmp/ns/live-moved"); unlink("/tmp/ns/alias.pub");
  rmdir("/tmp/ns/folder"); rmdir("/tmp/ns/unrelated"); rmdir("/tmp/ns/moved-unrelated"); rmdir("/tmp/ns/empty");
  bool cleaned = rmdir("/tmp/ns") == 0;
  printf("OCTANT_KERNEL_NAMESPACE {\"status\":\"%s\",\"measurements\":%u,\"productionReady\":false,\"ownedChildJoined\":%s,\"cleaned\":%s}\n",
    passed && controls && cleaned ? "measured-namespace-token" : "failed", measured, reaped ? "true" : "false", cleaned ? "true" : "false");
  return passed && controls && cleaned ? 0 : 29;
}

static int policy_measure(bool capsule)
{
  pid_t child = fork();
  if (!child) {
    char *arguments[] = {"/policy-broker", capsule ? "--bubblewrap" : NULL, NULL};
    char *environment[] = {"HOME=/tmp", "PATH=/", "LANG=C", NULL};
    execve(arguments[0], arguments, environment);
    _exit(31);
  }
  if (child < 0) return 32;
  int result; pid_t joined;
  do { joined = waitpid(child, &result, 0); } while (joined < 0 && errno == EINTR);
  return joined == child && WIFEXITED(result) && WEXITSTATUS(result) == 0 ? 0 : 33;
}

int main(void)
{
  mkdir("/dev", 0755); mkdir("/proc", 0755); mkdir("/tmp", 0700);
  if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) || mount("proc", "/proc", "proc", 0, NULL) ||
      mount("tmpfs", "/tmp", "tmpfs", 0, "size=1m")) {
    puts("OCTANT_KERNEL_FAILURE guest mounts unavailable");
  } else {
    int result = measure();
    if (!result) result = namespace_measure();
    if (!result) result = policy_measure(false);
    if (!result) result = policy_measure(true);
    printf("OCTANT_KERNEL_EXIT %d\n", result);
  }
  fflush(stdout);
  reboot(RB_POWER_OFF);
  return 1;
}
