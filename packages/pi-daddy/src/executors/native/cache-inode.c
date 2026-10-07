/* OS-only, UNPRIVILEGED fixed-inode observation. No source certification,
 * content reads, cache policy, command/path API, runtime watch additions or rearm.
 * Calling-parent numeric descriptors are O_PATH pinned and identity checked, then
 * reopened readonly for files/directories; symlink pins stay O_PATH so dangling
 * targets are never followed. Watch admission may refuse. No installed CAP_LEASE use.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <sys/inotify.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#define OBJECTS 4096
#define FRAME 640
#define DRAIN_BYTES 262144
#define MASK (IN_ATTRIB|IN_MODIFY|IN_CREATE|IN_DELETE|IN_MOVED_FROM|IN_MOVED_TO|IN_MOVE_SELF|IN_DELETE_SELF)
static int notify=-1, held[OBJECTS], result;
static uint64_t sequence;
static bool emit(const char *format,...) {
    char line[FRAME]; va_list args; va_start(args,format);
    int n=vsnprintf(line,sizeof line,format,args); va_end(args);
    if(n<=0 || n>=(int)sizeof line) { result=74; return false; }
    ssize_t used; do { used=write(1,line,(size_t)n); } while(used<0 && errno==EINTR);
    if(used!=n) { result=74; return false; }
    return true;
}
static bool fail(const char *reason,int error) { result=78; (void)emit("I1 F %s %d\n",reason,error); return false; }
static bool integer(const char *text,uint64_t max,uint64_t *value) {
    if(!*text || (*text=='0' && text[1])) return false;
    uint64_t number=0;
    for(;*text;text++) { if(*text<'0' || *text>'9') return false; unsigned d=(unsigned)(*text-'0'); if(d>max || number>(max-d)/10) return false; number=number*10+d; }
    *value=number; return true;
}
static bool credentials(void) {
    uid_t r,e,s; gid_t gr,ge,gs;
    if(getresuid(&r,&e,&s)!=0 || getresgid(&gr,&ge,&gs)!=0 || !r || r!=e || r!=s || gr!=ge || gr!=gs) return fail("CREDENTIALS",0);
    struct __user_cap_header_struct h={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
    struct __user_cap_data_struct c[2]; memset(c,0,sizeof c);
    if(syscall(SYS_capget,&h,c)!=0) return fail("CAPABILITIES",errno);
    for(int i=0;i<2;i++) if(c[i].effective || c[i].permitted || c[i].inheritable) return fail("CAPABILITIES",0);
    return prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)==0 || fail("NO_NEW_PRIVS",errno);
}
static bool restrict_effects(void) {
#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#else
#error Only measured Linux x64 observer build is supported
#endif
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(n),0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS)
    struct sock_filter code[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K,0x40000000U,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        DENY(SYS_clone),DENY(SYS_clone3),DENY(SYS_fork),DENY(SYS_vfork),DENY(SYS_execve),DENY(SYS_execveat),
        DENY(SYS_socket),DENY(SYS_socketpair),DENY(SYS_connect),DENY(SYS_bind),DENY(SYS_listen),
        DENY(SYS_io_uring_setup),DENY(SYS_io_uring_enter),DENY(SYS_io_uring_register),
        DENY(SYS_ptrace),DENY(SYS_process_vm_readv),DENY(SYS_process_vm_writev),
        DENY(SYS_fchmod),DENY(SYS_fchown),DENY(SYS_ftruncate),DENY(SYS_unlinkat),DENY(SYS_renameat),DENY(SYS_renameat2),
        DENY(SYS_mkdirat),DENY(SYS_linkat),DENY(SYS_symlinkat),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program={.len=(unsigned short)(sizeof code/sizeof code[0]),.filter=code};
    return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)==0 || fail("SECCOMP",errno);
#undef DENY
#undef ARCH
}
static bool arm(pid_t parent,int index,char *spec) {
    if(strlen(spec)>=192) return fail("ARGUMENTS",0);
    char copy[192]; memcpy(copy,spec,strlen(spec)+1);
    char *fields[4]={copy}; int count=1;
    for(char *p=copy;*p;p++) if(*p==':') { if(count==4 || !p[1]) return fail("ARGUMENTS",0); *p=0; fields[count++]=p+1; }
    uint64_t key,dev,ino,kind;
    if(count!=4 || !integer(fields[0],INT_MAX,&key) || key<3 || !integer(fields[1],UINT64_MAX,&dev) ||
       !integer(fields[2],UINT64_MAX,&ino) || !integer(fields[3],3,&kind) || !kind) return fail("ARGUMENTS",0);
    char path[64]; int n=snprintf(path,sizeof path,"/proc/%ld/fd/%llu",(long)parent,(unsigned long long)key);
    if(n<=0 || n>=(int)sizeof path) return fail("INTERNAL",0);
    int pinned=open(path,O_PATH|O_CLOEXEC); if(pinned<0) return fail("PIN",errno);
    struct stat st;
    bool matches=fstat(pinned,&st)==0 && (uint64_t)st.st_dev==dev && (uint64_t)st.st_ino==ino &&
        ((kind==1 && S_ISREG(st.st_mode)) || (kind==2 && S_ISDIR(st.st_mode)) || (kind==3 && S_ISLNK(st.st_mode)));
    if(!matches) { (void)close(pinned); return fail("IDENTITY",0); }
    int fd=pinned;
    if(kind!=3) {
        n=snprintf(path,sizeof path,"/proc/self/fd/%d",pinned);
        if(n<=0 || n>=(int)sizeof path) { (void)close(pinned); return fail("INTERNAL",0); }
        fd=open(path,O_RDONLY|O_NONBLOCK|O_CLOEXEC); int error=errno; (void)close(pinned);
        if(fd<0) return fail("READ",error);
    }
    held[index]=fd;
    if(fstat(fd,&st)!=0 || (uint64_t)st.st_dev!=dev || (uint64_t)st.st_ino!=ino ||
       ((kind==1 && !S_ISREG(st.st_mode)) || (kind==2 && !S_ISDIR(st.st_mode)) || (kind==3 && !S_ISLNK(st.st_mode)))) return fail("IDENTITY",0);
    n=snprintf(path,sizeof path,"/proc/self/fd/%d",fd); if(n<=0 || n>=(int)sizeof path) return fail("INTERNAL",0);
    /* Default follow resolves procfs's magic fd link to the HELD inode. IN_DONT_FOLLOW
     * would instead watch the procfs link. No original pathname or target lookup here. */
    int wd=inotify_add_watch(notify,path,MASK); if(wd<0) return fail("WATCH",errno);
    return emit("I1 W %d %d %llu %llu %s\n",index,wd,(unsigned long long)dev,(unsigned long long)ino,
                kind==1?"file":kind==2?"directory":"symlink");
}
static bool drain(void) {
    union { char bytes[65536]; struct inotify_event alignment; } data;
    size_t total=0; struct timespec started,now;
    if(clock_gettime(CLOCK_MONOTONIC,&started)!=0) return fail("CLOCK",errno);
    for(;;) {
        ssize_t used=read(notify,data.bytes,sizeof data.bytes);
        if(used<0) { if(errno==EINTR) continue; if(errno==EAGAIN) return true; return fail("READ",errno); }
        if(!used) return fail("EOF",0);
        total+=(size_t)used; if(total>DRAIN_BYTES) return fail("DRAIN_LIMIT",0);
        size_t offset=0;
        while(offset<(size_t)used) {
            if((size_t)used-offset<sizeof(struct inotify_event)) return fail("EVENT",0);
            struct inotify_event event; memcpy(&event,data.bytes+offset,sizeof event);
            if(event.len>256 || event.len%sizeof event || sizeof event+event.len>(size_t)used-offset) return fail("EVENT",0);
            char hex[511]; size_t length=0;
            const unsigned char *name=(const unsigned char*)data.bytes+offset+sizeof event;
            while(length<event.len && name[length]) length++;
            if(length>255 || (event.len && length==event.len)) return fail("EVENT",0);
            for(size_t i=length;i<event.len;i++) if(name[i]) return fail("EVENT",0);
            for(size_t i=0;i<length;i++) { if(name[i]=='/') return fail("EVENT",0); hex[2*i]="0123456789abcdef"[name[i]>>4]; hex[2*i+1]="0123456789abcdef"[name[i]&15]; }
            hex[2*length]=0;
            if(!emit("I1 E %d %u %u %s\n",event.wd,event.mask,event.cookie,length?hex:"-")) return false;
            offset+=sizeof event+event.len;
        }
        if(clock_gettime(CLOCK_MONOTONIC,&now)!=0) return fail("CLOCK",errno);
        int64_t elapsed=(now.tv_sec-started.tv_sec)*1000000000LL+now.tv_nsec-started.tv_nsec;
        if(elapsed>100000000LL) return fail("DRAIN_TIME",0);
    }
}
static bool command(char *line) {
    if(strncmp(line,"I1 D ",5)) return fail("PROTOCOL",0);
    uint64_t seq; if(!integer(line+5,9007199254740991ULL,&seq) || !seq || seq!=sequence+1) return fail("PROTOCOL",0);
    sequence=seq;
    return drain() && emit("I1 D %llu\n",(unsigned long long)seq);
}
int main(int argc,char **argv) {
    for(int i=0;i<OBJECTS;i++) held[i]=-1;
    uint64_t parent;
    int flags=fcntl(1,F_GETFL); if(flags<0 || fcntl(1,F_SETFL,flags|O_NONBLOCK)<0) return 74;
    if(argc<3 || argc>OBJECTS+2 || !integer(argv[1],INT_MAX,&parent) || !parent) { (void)fail("ARGUMENTS",0); goto done; }
    if(getppid()!=(pid_t)parent || prctl(PR_SET_PDEATHSIG,SIGKILL)!=0 || getppid()!=(pid_t)parent) { (void)fail("PARENT",0); goto done; }
    if(!credentials()) goto done;
    if(close_range(3,UINT_MAX,0)!=0) { (void)fail("DESCRIPTORS",errno); goto done; }
    notify=inotify_init1(IN_NONBLOCK|IN_CLOEXEC); if(notify<0) { (void)fail("INIT",errno); goto done; }
    if(!restrict_effects() || !emit("I1 READY %d\n",argc-2)) goto done;
    for(int i=2;i<argc;i++) if(!arm((pid_t)parent,i-2,argv[i])) goto done;
    if(!drain() || !emit("I1 ARMED\n")) goto done;
    flags=fcntl(0,F_GETFL); if(flags<0 || fcntl(0,F_SETFL,flags|O_NONBLOCK)<0) { (void)fail("STDIN",errno); goto done; }
    char line[64]; size_t filled=0;
    for(;;) {
        struct pollfd fds[2]={{.fd=0,.events=POLLIN},{.fd=notify,.events=POLLIN}};
        int n=poll(fds,2,-1);
        if(n<0) { if(errno==EINTR) continue; (void)fail("POLL",errno); break; }
        if(fds[1].revents & (POLLERR|POLLHUP|POLLNVAL)) { (void)fail("POLL",0); break; }
        if((fds[1].revents & POLLIN) && !drain()) break;
        if(fds[0].revents & (POLLERR|POLLNVAL)) { (void)fail("STDIN",0); break; }
        if(!(fds[0].revents & (POLLIN|POLLHUP))) continue;
        for(;;) {
            char byte; ssize_t got=read(0,&byte,1);
            if(got<0) { if(errno==EINTR) continue; if(errno==EAGAIN) break; (void)fail("STDIN",errno); goto done; }
            if(!got) { if(filled) (void)fail("TRUNCATED",0); goto done; }
            if(byte=='\n') { line[filled]=0; if(!command(line)) goto done; filled=0; }
            else { if(byte<32 || byte>126 || filled==sizeof line-1) { (void)fail("FRAME",0); goto done; } line[filled++]=byte; }
        }
    }
done:
    for(int i=0;i<OBJECTS;i++) if(held[i]>=0) (void)close(held[i]);
    if(notify>=0) (void)close(notify);
    return result;
}
