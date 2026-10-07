/* Unprivileged OS-only held symlink read. No walking, policy, source certificate,
 * capabilities, child processes or service. Immutable target readlinkat(fd,""),
 * never by-name readlink. READY gates identity admission; PINNED gates the read.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <sys/syscall.h>
#include <signal.h>
#include <unistd.h>
static int result;
static int emit(const char *bytes,size_t n) {
    ssize_t used; do { used=write(1,bytes,n); } while(used<0 && errno==EINTR);
    if(used!=(ssize_t)n) { result=74; return 0; } return 1;
}
static int fail(const char *reason,int error) {
    char line[128]; int n=snprintf(line,sizeof line,"S1 F %s %d\n",reason,error); result=78;
    if(n>0 && n<(int)sizeof line) (void)emit(line,(size_t)n);
    return 0;
}
static int integer(const char *text,uint64_t max,uint64_t *value) {
    if(!*text || (*text=='0' && text[1])) return 0;
    uint64_t number=0;
    for(;*text;text++) {
        if(*text<'0' || *text>'9') return 0;
        unsigned digit=(unsigned)(*text-'0');
        if(digit>max || number>(max-digit)/10) return 0;
        number=number*10+digit;
    }
    *value=number; return 1;
}
static int command(char expected) {
    char bytes[2]; size_t filled=0;
    while(filled<sizeof bytes) {
        ssize_t n=read(0,bytes+filled,sizeof bytes-filled);
        if(n<0) { if(errno==EINTR) continue; return fail("CONTROL",errno); }
        if(!n) return fail("CONTROL_EOF",0);
        filled+=(size_t)n;
    }
    return (bytes[0]==expected && bytes[1]=='\n') || fail("CONTROL",0);
}
static int credentials(void) {
    uid_t r,e,s; gid_t gr,ge,gs;
    if(getresuid(&r,&e,&s)!=0 || getresgid(&gr,&ge,&gs)!=0 || !r || r!=e || r!=s || gr!=ge || gr!=gs) return fail("CREDENTIALS",0);
    struct __user_cap_header_struct h={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
    struct __user_cap_data_struct c[2]; memset(c,0,sizeof c);
    if(syscall(SYS_capget,&h,c)!=0) return fail("CAPABILITIES",errno);
    for(int i=0;i<2;i++) if(c[i].effective || c[i].permitted || c[i].inheritable) return fail("CAPABILITIES",0);
    return prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)==0 || fail("NO_NEW_PRIVS",errno);
}
static int restrict_effects(void) {
#if !defined(__x86_64__)
#error Only measured Linux x64 held symlink build is supported
#endif
#define ALLOW(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,(n),0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    struct sock_filter code[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        ALLOW(SYS_read),ALLOW(SYS_write),ALLOW(SYS_close),ALLOW(SYS_readlinkat),ALLOW(SYS_exit),ALLOW(SYS_exit_group),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS)
    };
    struct sock_fprog program={.len=(unsigned short)(sizeof code/sizeof code[0]),.filter=code};
    return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program)==0 || fail("SECCOMP",errno);
#undef ALLOW
}
int main(int argc,char **argv) {
    uint64_t parent,fd,dev,ino,max; int pinned=-1;
    int flags=fcntl(1,F_GETFL);
    if(flags<0 || fcntl(1,F_SETFL,flags|O_NONBLOCK)<0) return 74;
    if(argc!=6 || !integer(argv[1],INT_MAX,&parent) || !parent || !integer(argv[2],INT_MAX,&fd) || fd<3 ||
       !integer(argv[3],UINT64_MAX,&dev) || !integer(argv[4],UINT64_MAX,&ino) || !integer(argv[5],4096,&max) || !max) {
        (void)fail("ARGUMENTS",0); goto done;
    }
    if(getppid()!=(pid_t)parent || prctl(PR_SET_PDEATHSIG,SIGKILL)!=0 || getppid()!=(pid_t)parent) { (void)fail("PARENT",0); goto done; }
    if(!emit("S1 READY\n",9) || !command('P') || !credentials()) goto done;
    if(close_range(3,UINT_MAX,0)!=0) { (void)fail("DESCRIPTORS",errno); goto done; }
    char path[64]; int n=snprintf(path,sizeof path,"/proc/%llu/fd/%llu",(unsigned long long)parent,(unsigned long long)fd);
    if(n<=0 || n>=(int)sizeof path) { (void)fail("INTERNAL",0); goto done; }
    pinned=open(path,O_PATH|O_CLOEXEC);
    if(pinned<0) { (void)fail("PIN",errno); goto done; }
    struct stat st;
    if(fstat(pinned,&st)!=0 || !S_ISLNK(st.st_mode) || (uint64_t)st.st_dev!=dev || (uint64_t)st.st_ino!=ino) { (void)fail("IDENTITY",0); goto done; }
    struct statfs fs;
    if(fstatfs(pinned,&fs)!=0 || (fs.f_type!=EXT4_SUPER_MAGIC && fs.f_type!=TMPFS_MAGIC)) { (void)fail("FILESYSTEM",0); goto done; }
    struct statx sx;
    if(statx(pinned,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,STATX_BASIC_STATS,&sx)!=0) { (void)fail("METADATA",errno); goto done; }
    if((sx.stx_attributes & STATX_ATTR_ENCRYPTED) || (fs.f_type==EXT4_SUPER_MAGIC && !(sx.stx_attributes_mask & STATX_ATTR_ENCRYPTED))) {
        (void)fail("ENCRYPTION",0); goto done;
    }
    if(!restrict_effects() || !emit("S1 PINNED\n",10) || !command('R')) goto done;
    unsigned char target[4097]; ssize_t got;
    do { got=readlinkat(pinned,"",(char*)target,(size_t)max+1); } while(got<0 && errno==EINTR);
    if(got<0) { (void)fail("READ",errno); goto done; }
    if(!got || got>(ssize_t)max) { (void)fail("TARGET_LIMIT",0); goto done; }
    char frame[8320]; n=snprintf(frame,sizeof frame,"S1 LINK %llu %llu ",(unsigned long long)dev,(unsigned long long)ino);
    if(n<=0 || n>=(int)sizeof frame) { (void)fail("INTERNAL",0); goto done; }
    for(ssize_t i=0;i<got;i++) {
        frame[n++]="0123456789abcdef"[target[i]>>4]; frame[n++]="0123456789abcdef"[target[i]&15];
    }
    frame[n++]='\n'; (void)emit(frame,(size_t)n);
done:
    if(pinned>=0) (void)close(pinned);
    _exit(result);
}
