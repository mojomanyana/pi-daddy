/* Linux OS primitive ONLY: readonly descriptor leases and lifetime. No cache,
 * graph, scheduler, eligibility, command execution, network or pathname API.
 * Statically linked for installation; the ONLY accepted capability is CAP_LEASE.
 * Parent descriptors are pinned O_PATH, identity/type checked BEFORE readonly
 * reopening, so descriptor reuse cannot retarget an admitted acquisition.
 * VALID is an instantaneous observation, not a complete input snapshot.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define LIMIT 8192
#define FRAME 192
#define BREAK_NS 250000000LL
struct held { int fd; uint64_t id; bool breaking; int64_t deadline; };
static struct held leases[LIMIT];
static int wakefd[2] = {-1,-1}, peerfd = -1, result, privileged;
static volatile sig_atomic_t pending, signal_seconds, signal_nanoseconds;
static uint64_t sequence;

static void release_slot(int i) {
    if (leases[i].fd >= 0) { (void)close(leases[i].fd); leases[i].fd = -1; }
}
static void cleanup(void) {
    for (int i=0; i<LIMIT; ++i) release_slot(i);
    if (wakefd[0]>=0) (void)close(wakefd[0]);
    if (wakefd[1]>=0) (void)close(wakefd[1]);
    if (peerfd>=0) (void)close(peerfd);
}
static bool emit(const char *fmt, ...) {
    char out[FRAME]; va_list args; va_start(args,fmt);
    int n=vsnprintf(out,sizeof out,fmt,args); va_end(args);
    if (n<=0 || n>=(int)sizeof out || write(1,out,(size_t)n)!=n) { result=74; return false; }
    return true;
}
static bool fatal(const char *why) { result=78; (void)emit("F ERROR %s\n",why); return false; }
static bool number(const char *text, uint64_t max, uint64_t *out) {
    if (!*text || (*text=='0' && text[1])) return false;
    uint64_t n=0;
    for (; *text; ++text) {
        if (*text<'0' || *text>'9') return false;
        unsigned digit=(unsigned)(*text-'0');
        if (digit>max || n>(max-digit)/10) return false;
        n=n*10+digit;
    }
    *out=n; return true;
}
static bool now_ns(int64_t *out) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC,&t)!=0 || t.tv_sec<0 || t.tv_sec>INT_MAX) return fatal("CLOCK");
    *out=(int64_t)t.tv_sec*1000000000LL+t.tv_nsec; return true;
}
static void sigio(int ignored) {
    (void)ignored; int saved=errno;
    if (!pending) {
        struct timespec t;
        if (clock_gettime(CLOCK_MONOTONIC,&t)==0 && t.tv_sec>=0 && t.tv_sec<=INT_MAX) {
            signal_seconds=(sig_atomic_t)t.tv_sec; signal_nanoseconds=(sig_atomic_t)t.tv_nsec; pending=1;
        } else pending=2;
    }
    char byte=1; ssize_t n=write(wakefd[1],&byte,1);
    if (n!=1 && !(n<0 && (errno==EAGAIN || errno==EINTR))) pending=3;
    errno=saved;
}
static bool scan(void) {
    sigset_t mask,old; sigemptyset(&mask); sigaddset(&mask,SIGIO);
    if (sigprocmask(SIG_BLOCK,&mask,&old)!=0) return fatal("SIGNAL_MASK");
    int event=pending;
    int64_t started=event==1?(int64_t)signal_seconds*1000000000LL+signal_nanoseconds:0;
    pending=0;
    if (sigprocmask(SIG_SETMASK,&old,NULL)!=0 || event>1) return fatal("SIGNAL");
    int64_t now; if (!now_ns(&now)) return false;
    for (int i=0; i<LIMIT; ++i) {
        struct held *h=&leases[i]; if (h->fd<0) continue;
        int state=fcntl(h->fd,F_GETLEASE), err=errno;
        if (state<0) {
            release_slot(i); if (!emit("E LOSS %llu GETLEASE %d\n",(unsigned long long)h->id,err)) return false;
            continue;
        }
        if (state!=F_RDLCK && !h->breaking) {
            h->breaking=true; h->deadline=(event==1?started:now)+BREAK_NS;
            if (!emit("E BREAK %llu\n",(unsigned long long)h->id)) return false;
        }
        if (h->breaking && now>=h->deadline) {
            release_slot(i); if (!emit("E LOSS %llu TIMEOUT 0\n",(unsigned long long)h->id)) return false;
        }
    }
    return true;
}
static int find(uint64_t id) {
    for (int i=0; i<LIMIT; ++i) if (leases[i].fd>=0 && leases[i].id==id) return i;
    return -1;
}
static bool refused(uint64_t seq,uint64_t id,const char *why,int err) {
    return emit("R %llu REFUSED %llu %s %d\n",(unsigned long long)seq,(unsigned long long)id,why,err);
}
static bool acquire(pid_t parent,uint64_t seq,uint64_t id,int key,uint64_t dev,uint64_t ino) {
    if (find(id)>=0) return refused(seq,id,"DUPLICATE",0);
    int slot; for (slot=0;slot<LIMIT && leases[slot].fd>=0;++slot) {}
    if (slot==LIMIT) return refused(seq,id,"LIMIT",0);
    char path[64];
    int n=snprintf(path,sizeof path,"/proc/%ld/fd/%d",(long)parent,key);
    if (n<=0 || n>=(int)sizeof path) return fatal("INTERNAL");
    int pinned=open(path,O_PATH|O_CLOEXEC);
    if (pinned<0) return refused(seq,id,"OPEN",errno);
    struct stat st; const char *why=NULL; int err=0;
    if (fstat(pinned,&st)!=0) { why="STAT"; err=errno; }
    else if (!S_ISREG(st.st_mode)) why="TYPE";
    else if ((uint64_t)st.st_dev!=dev || (uint64_t)st.st_ino!=ino) why="IDENTITY";
    else if (st.st_uid!=getuid() && !privileged) why="CAPABILITY";
    if (why) { (void)close(pinned); return refused(seq,id,why,err); }
    n=snprintf(path,sizeof path,"/proc/self/fd/%d",pinned);
    if (n<=0 || n>=(int)sizeof path) { (void)close(pinned); return fatal("INTERNAL"); }
    int fd=open(path,O_RDONLY|O_NONBLOCK|O_CLOEXEC); err=errno; (void)close(pinned);
    if (fd<0) return refused(seq,id,"READ",err);
    if (fstat(fd,&st)!=0) { why="STAT"; err=errno; }
    else if (!S_ISREG(st.st_mode) || (uint64_t)st.st_dev!=dev || (uint64_t)st.st_ino!=ino) why="IDENTITY";
    else if (st.st_uid!=getuid() && !privileged) why="CAPABILITY";
    else if (fcntl(fd,F_SETOWN,getpid())<0) { why="SETOWN"; err=errno; }
    else if (fcntl(fd,F_SETLEASE,F_RDLCK)<0) { why="LEASE"; err=errno; }
    if (why) { (void)close(fd); return refused(seq,id,why,err); }
    leases[slot]=(struct held){.fd=fd,.id=id};
    int state=fcntl(fd,F_GETLEASE);
    if (state!=F_RDLCK || pending) {
        err=state<0?errno:0; release_slot(slot); return refused(seq,id,"UNSTABLE",err);
    }
    return emit("R %llu ACQUIRED %llu %llu %llu\n",(unsigned long long)seq,(unsigned long long)id,
                (unsigned long long)dev,(unsigned long long)ino);
}
static bool command(char *text,pid_t parent) {
    char *p[8]; int count=1; p[0]=text;
    for (char *t=text;*t;++t) {
        if (*t==' ') {
            if (t==text || t[-1]=='\0' || !t[1] || t[1]==' ' || count==8) return fatal("PROTOCOL");
            *t='\0'; p[count++]=t+1;
        } else if (*t<33 || *t>126) return fatal("PROTOCOL");
    }
    uint64_t seq,id,fd=0,dev=0,ino=0;
    if (count<4 || strcmp(p[0],"L2") || !number(p[1],9007199254740991ULL,&seq) || seq!=sequence+1 ||
        !number(p[3],UINT64_MAX,&id) || !id) return fatal("PROTOCOL");
    sequence=seq;
    bool add=!strcmp(p[2],"ACQUIRE"), check=!strcmp(p[2],"CHECK"), release=!strcmp(p[2],"RELEASE");
    if (add) {
        if (count!=7 || !number(p[4],INT_MAX,&fd) || fd<3 || !number(p[5],UINT64_MAX,&dev) ||
            !number(p[6],UINT64_MAX,&ino)) return fatal("PROTOCOL");
        return acquire(parent,seq,id,(int)fd,dev,ino);
    }
    if ((!check && !release) || count!=4) return fatal("PROTOCOL");
    if (!scan()) return false;
    int slot=find(id);
    if (slot<0) return emit("R %llu INVALID %llu UNKNOWN\n",(unsigned long long)seq,(unsigned long long)id);
    if (release) {
        release_slot(slot); return emit("R %llu RELEASED %llu\n",(unsigned long long)seq,(unsigned long long)id);
    }
    if (leases[slot].breaking) return emit("R %llu INVALID %llu BREAKING\n",(unsigned long long)seq,(unsigned long long)id);
    return emit("R %llu VALID %llu\n",(unsigned long long)seq,(unsigned long long)id);
}
static bool proc_text(const char *path,char *text,size_t size) {
    int fd=open(path,O_RDONLY|O_NONBLOCK|O_CLOEXEC); if (fd<0) return false;
    ssize_t used=read(fd,text,size); int err=errno; (void)close(fd); errno=err;
    if (used<=0 || (size_t)used>=size) return false;
    text[used]='\0'; return true;
}
static bool peer_identity(pid_t pid,const char *ticks,const char *boot) {
    char text[4096],path[64];
    if (!proc_text("/proc/sys/kernel/random/boot_id",text,sizeof text)) return false;
    size_t length=strlen(text); if (length && text[length-1]=='\n') text[--length]='\0';
    if (strcmp(text,boot)) return false;
    (void)snprintf(path,sizeof path,"/proc/%ld",(long)pid);
    struct stat st; if (stat(path,&st)!=0 || st.st_uid!=getuid()) return false;
    (void)snprintf(path,sizeof path,"/proc/%ld/stat",(long)pid);
    if (!proc_text(path,text,sizeof text)) return false;
    char *end=strrchr(text,')'); if (!end || end[1]!=' ') return false;
    char *cursor=end+2,*save=NULL,*field=strtok_r(cursor," ", &save);
    if (!field || strlen(field)!=1 || !strchr("RSDTtIPWK",field[0])) return false;
    for (int i=1;i<=19;++i) { field=strtok_r(NULL," ",&save); if (!field) return false; }
    field[strcspn(field,"\n")]='\0'; return !strcmp(field,ticks);
}
static bool credentials(void) {
    uid_t real,effective,saved; gid_t rg,eg,sg;
    if (getresuid(&real,&effective,&saved)!=0 || getresgid(&rg,&eg,&sg)!=0 || !real ||
        real!=effective || real!=saved || rg!=eg || rg!=sg) return fatal("CREDENTIALS");
    struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
    struct __user_cap_data_struct data[2]; memset(data,0,sizeof data);
    if (syscall(SYS_capget,&header,data)!=0) return fatal("CAPABILITIES");
    uint32_t bit=1U<<CAP_LEASE;
    if (data[1].effective || data[1].permitted || data[0].inheritable || data[1].inheritable ||
        (data[0].effective!=0 && data[0].effective!=bit) || data[0].permitted!=data[0].effective)
        return fatal("CAPABILITIES");
    privileged=data[0].effective==bit;
    return prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)==0 || fatal("NO_NEW_PRIVS");
}
/* Kernel deny-list for effects this leaf must NEVER exercise, even after an ABI bug.
 * No exec, descendants, native networking or process-memory access. File opens still
 * need the strictly checked O_PATH/proc-descriptor protocol above; seccomp cannot
 * interpret path strings. CAP_LEASE grants neither extra read nor write permission.
 */
static bool restrict_effects(void) {
#if defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported cache lease architecture
#endif
#define DENY_SYSCALL(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(n),0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS)
    struct sock_filter filter[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,EXPECTED_ARCH,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
        /* x32 has the same audit arch but different syscall numbers: do not let it bypass denials. */
        BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000U,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
        DENY_SYSCALL(SYS_clone), DENY_SYSCALL(SYS_clone3),
#ifdef SYS_fork
        DENY_SYSCALL(SYS_fork), DENY_SYSCALL(SYS_vfork),
#endif
        DENY_SYSCALL(SYS_execve), DENY_SYSCALL(SYS_execveat),
        DENY_SYSCALL(SYS_socket), DENY_SYSCALL(SYS_socketpair),
        DENY_SYSCALL(SYS_connect), DENY_SYSCALL(SYS_bind), DENY_SYSCALL(SYS_listen),
        DENY_SYSCALL(SYS_io_uring_setup), DENY_SYSCALL(SYS_io_uring_enter), DENY_SYSCALL(SYS_io_uring_register),
        DENY_SYSCALL(SYS_ptrace), DENY_SYSCALL(SYS_process_vm_readv), DENY_SYSCALL(SYS_process_vm_writev),
        DENY_SYSCALL(SYS_fchmod), DENY_SYSCALL(SYS_fchown), DENY_SYSCALL(SYS_ftruncate),
        DENY_SYSCALL(SYS_unlinkat), DENY_SYSCALL(SYS_renameat), DENY_SYSCALL(SYS_renameat2),
        DENY_SYSCALL(SYS_mkdirat), DENY_SYSCALL(SYS_linkat), DENY_SYSCALL(SYS_symlinkat),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program={.len=(unsigned short)(sizeof filter/sizeof filter[0]),.filter=filter};
    return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)==0 || fatal("SECCOMP");
#undef DENY_SYSCALL
#undef EXPECTED_ARCH
}
int main(int argc,char **argv) {
    for (int i=0;i<LIMIT;++i) leases[i].fd=-1;
    int flags=fcntl(1,F_GETFL);
    if (flags<0 || fcntl(1,F_SETFL,flags|O_NONBLOCK)<0) return 74;
    signal(SIGPIPE,SIG_IGN);
    uint64_t parentn,peern,ticksn;
    if (argc!=5 || !number(argv[1],INT_MAX,&parentn) || !parentn || !number(argv[2],INT_MAX,&peern) || !peern ||
        !number(argv[3],UINT64_MAX,&ticksn) || strlen(argv[4])!=36) { (void)fatal("ARGUMENTS"); goto out; }
    pid_t parent=(pid_t)parentn,peer=(pid_t)peern;
    if (getppid()!=parent) { (void)fatal("PARENT"); goto out; }
    if (prctl(PR_SET_PDEATHSIG,SIGKILL)!=0) { (void)fatal("PDEATHSIG"); goto out; }
    if (getppid()!=parent) { (void)fatal("PARENT"); goto out; }
    if (!credentials()) goto out;
    if (close_range(3,UINT_MAX,0)!=0 || pipe2(wakefd,O_CLOEXEC|O_NONBLOCK)!=0) { (void)fatal("DESCRIPTORS"); goto out; }
    if (!peer_identity(peer,argv[3],argv[4])) { (void)fatal("PEER_IDENTITY"); goto out; }
    peerfd=(int)syscall(SYS_pidfd_open,peer,0);
    if (peerfd<0 || !peer_identity(peer,argv[3],argv[4])) { (void)fatal("PEER_IDENTITY"); goto out; }
    if (!restrict_effects()) goto out;
    struct sigaction action; memset(&action,0,sizeof action); action.sa_handler=sigio; sigemptyset(&action.sa_mask);
    if (sigaction(SIGIO,&action,NULL)!=0) { (void)fatal("SIGNAL"); goto out; }
    if (!emit("READY 2 %ld %ld %d %d %d 250\n",(long)parent,(long)getuid(),privileged,LIMIT,FRAME)) goto out;
    char frame[FRAME]; size_t used=0; int64_t nextscan=0;
    for (;;) {
        int64_t now; if (!now_ns(&now)) break;
        if (pending || now>=nextscan) { if (!scan()) break; nextscan=now+1000000000LL; }
        int timeout=50;
        for (int i=0;i<LIMIT;++i) if (leases[i].fd>=0 && leases[i].breaking) {
            int64_t left=leases[i].deadline-now;
            if (left<=0) { if (!scan()) goto out; timeout=0; break; }
            int ms=(int)((left+999999)/1000000); if (ms<timeout) timeout=ms;
        }
        struct pollfd polls[3]={{.fd=0,.events=POLLIN},{.fd=wakefd[0],.events=POLLIN},{.fd=peerfd,.events=POLLIN}};
        int rc=poll(polls,3,timeout);
        if (rc<0) { if (errno==EINTR) continue; (void)fatal("POLL"); break; }
        if (polls[2].revents) { (void)fatal("PEER_GONE"); break; }
        if (polls[1].revents & POLLIN) {
            char drain[64]; ssize_t n=read(wakefd[0],drain,sizeof drain);
            if (!n || (n<0 && errno!=EAGAIN && errno!=EINTR)) { (void)fatal("WAKE_READ"); break; }
        }
        if (pending && !scan()) break;
        if (polls[0].revents & (POLLERR|POLLNVAL)) { (void)fatal("STDIN"); break; }
        if (!(polls[0].revents & (POLLIN|POLLHUP))) continue;
        char byte; ssize_t n=read(0,&byte,1);
        if (n<0) { if (errno==EINTR || errno==EAGAIN) continue; (void)fatal("READ"); break; }
        if (!n) { if (used) (void)fatal("TRUNCATED"); break; }
        if (byte=='\n') { frame[used]='\0'; if (!command(frame,parent)) break; used=0; }
        else {
            if (used==FRAME-1 || byte<32 || byte>126) { (void)fatal("FRAME"); break; }
            frame[used++]=byte;
        }
    }
out:
    cleanup(); return result;
}
