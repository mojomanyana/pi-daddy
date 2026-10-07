/* Fresh unprivileged fixture: admit the leader before G, then leave a living thread after pthread_exit. */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void *live(void *unused) {
    (void)unused;
    for (;;) {
        if (write(STDOUT_FILENO, "thread_alive\n", 13) != 13) _exit(3);
        usleep(20000);
    }
    return NULL;
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    char pid[64];
    ssize_t count = readlink("/run/pi-daddy-cache-host-proc/self", pid, sizeof(pid) - 1);
    if (count <= 0 || count >= (ssize_t)sizeof(pid)) return 2;
    pid[count] = '\0';
    for (ssize_t i = 0; i < count; ++i) if (pid[i] < '0' || pid[i] > '9') return 2;
    signal(SIGTERM, SIG_IGN);
    alarm(10);
    printf("READY %s\n", pid);
    if (fflush(stdout) != 0) return 2;
    while (access(argv[1], F_OK) != 0) {
        if (errno != ENOENT) return 2;
        usleep(1000);
    }
    pthread_t thread;
    if (pthread_create(&thread, NULL, live, NULL) != 0) return 2;
    pthread_exit(NULL);
}
