#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int count, char **arguments)
{
  if (count != 5) return 2;
  const char *token = getenv("API_TOKEN");
  bool credential = token && !strcmp(token, "synthetic-recipient-only");
  int account = open(arguments[1], O_RDONLY);
  bool account_denied = account < 0;
  if (account >= 0) close(account);
  int outside = open(arguments[2], O_WRONLY | O_CREAT | O_TRUNC, 0600);
  bool outside_denied = outside < 0;
  if (outside >= 0) close(outside);
  int allowed = open(arguments[3], O_WRONLY | O_CREAT | O_EXCL, 0600);
  bool project_write = allowed >= 0 && write(allowed, "allowed", 7) == 7 && !fsync(allowed);
  if (allowed >= 0) close(allowed);
  int connection = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in target = { .sin_family = AF_INET,
    .sin_port = htons((unsigned short)strtoul(arguments[4], NULL, 10)),
    .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  bool direct_denied = connection < 0 || connect(connection, (struct sockaddr *)&target, sizeof(target)) < 0;
  if (connection >= 0) close(connection);
  printf("{\"credential\":%s,\"accountDenied\":%s,\"outsideDenied\":%s,\"projectWrite\":%s,\"directDenied\":%s}\n",
    credential ? "true" : "false", account_denied ? "true" : "false",
    outside_denied ? "true" : "false", project_write ? "true" : "false", direct_denied ? "true" : "false");
  return credential && account_denied && outside_denied && project_write && direct_denied ? 0 : 3;
}
