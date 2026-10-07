/* TEST ONLY OS fixture. Executed in a fresh unprivileged user+mount namespace
 * inside the existing lifetime-owned PID namespace. Only the fixture-created
 * tmpfs is reconfigured. No host mounts, installed capabilities, or cache policy.
 * Raw poll/read/statvfs evidence is not a coherent/current-source certificate.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>
#define BASE "/run/cache-mount-view"
#define LIMIT 1048576
static char boot[64], main_stat[8192], peer_stat[8192];
static void checked(bool ok,const char *action) {
    if(!ok) { fprintf(stderr,"mount fixture %s: errno %d\n",action,errno); exit(70); }
}
static char *contents(int fd) {
    checked(lseek(fd,0,SEEK_SET)==0,"seek");
    char *data=calloc(LIMIT+1,1); checked(data!=NULL,"allocate"); size_t used=0;
    for(;;) {
        ssize_t n=read(fd,data+used,LIMIT-used);
        if(n<0 && errno==EINTR) continue;
        checked(n>=0,"read"); if(!n) break;
        used+=(size_t)n; checked(used<LIMIT,"read bound");
    }
    return data;
}
static char *opened_contents(const char *path) {
    int fd=open(path,O_RDONLY|O_CLOEXEC); checked(fd>=0,"open");
    char *data=contents(fd); checked(close(fd)==0,"close"); return data;
}
static void announce(char *target) {
    char *text=opened_contents("/run/pi-daddy-cache-host-proc/self/stat");
    checked(strlen(text)<8192,"stat bound"); strcpy(target,text); free(text);
    target[strcspn(target,"\n")]=0;
    printf("{\"identity\":\"%s\",\"bootId\":\"%s\"}\n",target,boot); fflush(stdout);
}
static int priority(int fd) {
    struct pollfd p={.fd=fd,.events=POLLPRI}; int rc;
    do { rc=poll(&p,1,0); } while(rc<0 && errno==EINTR);
    checked(rc>=0,"poll"); checked(!(p.revents & POLLNVAL),"invalid descriptor"); return p.revents;
}
static unsigned long ns_inode(void) {
    struct stat st; checked(stat("/proc/self/ns/mnt",&st)==0,"namespace identity"); return st.st_ino;
}
static unsigned long blocks(void) {
    struct statvfs st; checked(statvfs(BASE,&st)==0,"statvfs"); return st.f_blocks;
}
static void file(const char *name,const char *text) {
    int fd=open(name,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600); checked(fd>=0,"create");
    checked(write(fd,text,strlen(text))==(ssize_t)strlen(text),"write"); checked(close(fd)==0,"close writer");
}
static void transfer(int fd,void *value,size_t length,bool writing) {
    char *bytes=value; size_t done=0;
    while(done<length) {
        ssize_t n=writing?write(fd,bytes+done,length-done):read(fd,bytes+done,length-done);
        if(n<0 && errno==EINTR) continue;
        checked(n>0,"peer transfer"); done+=(size_t)n;
    }
}
int main(int argc,char **argv) {
    checked((argc==2 || argc==3) && getuid()==0,"private user namespace credentials");
    const char *fault=argc==3?argv[2]:"none";
    char *id=opened_contents("/proc/sys/kernel/random/boot_id");
    checked(strlen(id)<sizeof boot,"boot bound"); strcpy(boot,id); free(id); boot[strcspn(boot,"\n")]=0;
    announce(main_stat);
    struct stat user_namespace,mount_namespace;
    checked(stat("/proc/self/ns/user",&user_namespace)==0 && stat("/proc/self/ns/mnt",&mount_namespace)==0,"private context identity");
    checked(mkdir(BASE,0700)==0,"private mountpoint");
    checked(mount("cache-mount-fixture",BASE,"tmpfs",0,"size=64k")==0,"private tmpfs");
    file(BASE "/source","temporary"); file(BASE "/target","original");
    int info=open("/proc/self/mountinfo",O_RDONLY|O_CLOEXEC); checked(info>=0,"mountinfo");
    char *before=contents(info), *changed=NULL, *after=NULL;
    int first=0,second=0,changed_poll=0,restored_poll=0;
    bool old_unchanged=false,ns_changed=false,lease_valid=false;
    bool inode_control=false,inode_quiet_changed=false,inode_quiet_restored=false,bytes_unchanged=false;
    unsigned long b0=blocks(),b1=b0,b2=b0;
    if(!strcmp(argv[1],"bind-undo")) {
        checked(mount(BASE "/source",BASE "/target",NULL,MS_BIND,NULL)==0,"bind");
        changed=contents(info);
        checked(umount2(BASE "/target",0)==0,"unmount bind");
        after=contents(info); first=priority(info); second=priority(info);
    } else if(!strcmp(argv[1],"flags-undo")) {
        checked(mount(NULL,BASE,NULL,MS_BIND|MS_REMOUNT|MS_NOATIME,NULL)==0,"noatime");
        changed=contents(info);
        checked(mount(NULL,BASE,NULL,MS_BIND|MS_REMOUNT|MS_RELATIME,NULL)==0,"restore relatime");
        after=contents(info); first=priority(info); second=priority(info);
    } else if(!strcmp(argv[1],"cross-sb")) {
        int input=open(BASE "/target",O_RDONLY|O_CLOEXEC); checked(input>=0,"content guard input");
        checked(fcntl(input,F_SETLEASE,F_RDLCK)==0,"owned content lease");
        int notifications=inotify_init1(IN_NONBLOCK|IN_CLOEXEC); checked(notifications>=0,"direct inode notifications");
        unsigned int mask=IN_ATTRIB|IN_MODIFY|IN_CREATE|IN_DELETE|IN_MOVED_FROM|IN_MOVED_TO|IN_MOVE_SELF|IN_DELETE_SELF;
        int file_watch=inotify_add_watch(notifications,BASE "/target",!strcmp(fault,"no-file-control")?IN_MODIFY:mask);
        int parent_watch=inotify_add_watch(notifications,BASE,!strcmp(fault,"no-parent-control")?IN_MODIFY:mask);
        checked(file_watch>0 && parent_watch>0,"file/parent watch admission");
        checked(fchmod(input,0640)==0 && fchmod(input,0600)==0,"forcing inode control");
        char notification_bytes[65536]; ssize_t notified=read(notifications,notification_bytes,sizeof notification_bytes);
        checked(notified>0,"control must observe actual inode events");
        bool observed_file=false,observed_parent=false; size_t position=0;
        while(position<(size_t)notified) {
            struct inotify_event event;
            checked((size_t)notified-position>=sizeof event,"control event header");
            memcpy(&event,notification_bytes+position,sizeof event);
            checked(!(event.mask & (IN_Q_OVERFLOW|IN_IGNORED|IN_UNMOUNT)),"control event loss");
            checked(event.len<=256 && sizeof event+event.len<=(size_t)notified-position,"control event bound");
            if(event.mask & IN_ATTRIB) {
                if(event.wd==file_watch) observed_file=true;
                if(event.wd==parent_watch) observed_parent=true;
            }
            position+=sizeof event+event.len;
        }
        checked(observed_file && observed_parent,"control requires ATTRIB on both file/parent watches"); inode_control=true;
        int commands[2],replies[2]; checked(pipe(commands)==0 && pipe(replies)==0,"peer pipes");
        unsigned long original_ns=ns_inode(); pid_t parent=getpid(),child=fork(); checked(child>=0,"fork");
        if(!child) {
            checked(close(commands[1])==0 && close(replies[0])==0,"child pipe close");
            checked(getppid()==parent && prctl(PR_SET_PDEATHSIG,SIGKILL)==0 && getppid()==parent,"peer parent");
            announce(peer_stat); /* Capture before namespace setup can block or fail. */
            if(!strcmp(fault,"peer-hang")) for(;;) pause();
            checked(unshare(CLONE_NEWNS)==0,"peer mount namespace");
            unsigned long next_ns=ns_inode(); transfer(replies[1],&next_ns,sizeof next_ns,true);
            transfer(replies[1],peer_stat,sizeof peer_stat,true);
            for(;;) {
                char command; transfer(commands[0],&command,1,false);
                checked(command=='c' || command=='r',"peer command");
                checked(mount(NULL,BASE,NULL,MS_REMOUNT,command=='c'?"size=128k":"size=64k")==0,"peer own superblock reconfigure");
                transfer(replies[1],&command,1,true);
            }
        }
        checked(close(commands[0])==0 && close(replies[1])==0,"parent pipe close");
        unsigned long next_ns; transfer(replies[0],&next_ns,sizeof next_ns,false);
        transfer(replies[0],peer_stat,sizeof peer_stat,false); ns_changed=original_ns!=next_ns;
        char command='c',ack; transfer(commands[1],&command,1,true); transfer(replies[0],&ack,1,false); checked(ack==command,"changed ack");
        changed=contents(info); b1=blocks(); changed_poll=priority(info);
        lease_valid=fcntl(input,F_GETLEASE)==F_RDLCK;
        notified=read(notifications,notification_bytes,sizeof notification_bytes);
        inode_quiet_changed=notified<0 && errno==EAGAIN;
        char *input_bytes=contents(input); bytes_unchanged=!strcmp(input_bytes,"original"); free(input_bytes);
        command='r'; transfer(commands[1],&command,1,true); transfer(replies[0],&ack,1,false); checked(ack==command,"restored ack");
        after=contents(info); b2=blocks(); restored_poll=priority(info);
        notified=read(notifications,notification_bytes,sizeof notification_bytes);
        inode_quiet_restored=notified<0 && errno==EAGAIN;
        lease_valid=lease_valid && fcntl(input,F_GETLEASE)==F_RDLCK;
        input_bytes=contents(input); bytes_unchanged=bytes_unchanged && !strcmp(input_bytes,"original"); free(input_bytes);
    } else if(!strcmp(argv[1],"root-view")) {
        int root=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC),proc=open("/proc",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
        checked(root>=0 && proc>=0,"saved root/proc directory descriptors");
        checked(mkdir(BASE "/jail",0700)==0,"private jail");
        unsigned long original_ns=ns_inode();
        checked(chroot(BASE "/jail")==0 && chdir("/")==0,"private same-task chroot");
        int fresh=openat(proc,"self/mountinfo",O_RDONLY|O_CLOEXEC); checked(fresh>=0,"fresh root-relative mountinfo");
        changed=contents(fresh); checked(close(fresh)==0,"close fresh view");
        char *old_view=contents(info); old_unchanged=!strcmp(before,old_view); free(old_view); changed_poll=priority(info);
        checked(fchdir(root)==0 && chroot(".")==0 && chdir("/")==0,"restore private root");
        ns_changed=original_ns!=ns_inode(); after=opened_contents("/proc/self/mountinfo");
    } else if(!strcmp(argv[1],"task-view")) {
        int old_ns=open("/proc/self/ns/mnt",O_RDONLY|O_CLOEXEC); checked(old_ns>=0,"original namespace pin");
        unsigned long original_ns=ns_inode(); checked(unshare(CLONE_NEWNS)==0,"same task new namespace");
        ns_changed=original_ns!=ns_inode();
        checked(mount(BASE "/source",BASE "/target",NULL,MS_BIND,NULL)==0,"new view bind");
        changed=opened_contents("/proc/self/mountinfo"); char *old_view=contents(info);
        old_unchanged=!strcmp(before,old_view); free(old_view); changed_poll=priority(info);
        checked(umount2(BASE "/target",0)==0,"new view unmount");
        checked(setns(old_ns,CLONE_NEWNS)==0,"restore original namespace");
        checked(original_ns==ns_inode(),"restored task namespace identity"); after=opened_contents("/proc/self/mountinfo");
    } else { checked(false,"unknown mode"); }
    printf("{\"mode\":\"%s\",\"bootId\":\"%s\",\"stats\":[\"%s\"",argv[1],boot,main_stat);
    if(*peer_stat) printf(",\"%s\"",peer_stat);
    printf("],\"beforeEqualsAfter\":%s,\"changedView\":%s,\"oldViewUnchanged\":%s,\"namespaceChanged\":%s,",
           !strcmp(before,after)?"true":"false",strcmp(before,changed)?"true":"false",old_unchanged?"true":"false",ns_changed?"true":"false");
    if(!strcmp(argv[1],"bind-undo") || !strcmp(argv[1],"flags-undo"))
        printf("\"firstPoll\":%d,\"secondPoll\":%d,\"changedPoll\":null,\"restoredPoll\":null,",first,second);
    else if(!strcmp(argv[1],"cross-sb"))
        printf("\"firstPoll\":null,\"secondPoll\":null,\"changedPoll\":%d,\"restoredPoll\":%d,",changed_poll,restored_poll);
    else printf("\"firstPoll\":null,\"secondPoll\":null,\"changedPoll\":%d,\"restoredPoll\":null,",changed_poll);
    printf("\"userNamespace\":\"%llu\",\"mountNamespace\":\"%llu\",",(unsigned long long)user_namespace.st_ino,(unsigned long long)mount_namespace.st_ino);
    if(!strcmp(argv[1],"cross-sb")) {
        printf("\"beforeBlocks\":%lu,\"changedBlocks\":%lu,\"restoredBlocks\":%lu,\"leaseValid\":%s,",b0,b1,b2,lease_valid?"true":"false");
        printf("\"inodeControl\":%s,\"inodeQuietChanged\":%s,\"inodeQuietRestored\":%s,\"bytesUnchanged\":%s}\n",
               inode_control?"true":"false",inode_quiet_changed?"true":"false",inode_quiet_restored?"true":"false",bytes_unchanged?"true":"false");
    } else {
        printf("\"beforeBlocks\":%lu,\"changedBlocks\":null,\"restoredBlocks\":null,\"leaseValid\":null,",b0);
        puts("\"inodeControl\":null,\"inodeQuietChanged\":null,\"inodeQuietRestored\":null,\"bytesUnchanged\":null}");
    }
    if(!strcmp(fault,"result-error")) puts("{\"error\":\"injected post-result peer failure\"}");
    if(!strcmp(fault,"result-overflow")) for(int i=0;i<70000;i++) putchar('x');
    if(!strcmp(fault,"result-duplicate")) printf("{\"mode\":\"%s\",\"bootId\":\"%s\",\"stats\":[\"%s\"]}\n",argv[1],boot,main_stat);
    if(!strcmp(fault,"result-trailing")) putchar('{');
    fflush(stdout); free(before); free(changed); free(after);
    for(;;) pause(); /* Namespace PID1 owns teardown and actual host identity checks. */
}
