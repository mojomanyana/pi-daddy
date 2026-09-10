import { constants, openSync, closeSync, readSync, writeSync, fstatSync, lstatSync, fsyncSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, dirname, parse, resolve } from 'node:path';
import { interventionCanonicalJson } from '@skill-harness/core';
export const learningJson = (value: unknown): string => interventionCanonicalJson(value);
export const learningHash = (value: unknown): string => createHash('sha256').update(learningJson(value)).digest('hex');
export const learningCopy = <T>(value:T):T => JSON.parse(learningJson(value));
export interface LearningEvent { id:string; prior:string|null; value:Record<string,unknown> }
const LIMIT=4*1024*1024;
function directory(path:string){
 if(!isAbsolute(path))throw Error('absolute learning directory required');
 for(let p=path;;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('learning directory substitution');if(p===parse(p).root)break;}
 const s=lstatSync(path);if((s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw Error('private owned learning directory required');
}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
export function learningFile(path:string,limit=1024*1024):Buffer {
 if(!constants.O_NOFOLLOW||!constants.O_NONBLOCK)throw Error('required safe file flags unavailable');
 if(!isAbsolute(path))throw Error('absolute learning file required');
 // Reject every symlink ancestor, but do not require public parent directories to be private.
 for(let p=dirname(path);;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('learning file ancestor substitution');if(p===parse(p).root)break;}
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>limit)throw Error('bounded regular learning file required');const out=Buffer.alloc(limit+1);let n=0;
  while(n<out.length){const k=readSync(fd,out,n,out.length-n,n);if(!k)break;n+=k;}if(n>limit)throw Error('learning file bound exceeded');return out.subarray(0,n);
 }finally{closeSync(fd);}
}
/** Shared durable CAS for the weekly supervisor and trust lifecycle. Trusted cooperative filesystem,
 * not hostile same-UID rollback protection. A stranded claim is never automatically recovered. */
export function learningJournal(path:string,initial?:Record<string,unknown>){
 if(!constants.O_NOFOLLOW||!constants.O_NONBLOCK||!constants.O_DIRECTORY)throw Error('required safe journal flags unavailable');
 if(initial!==undefined){directory(dirname(path));mkdirSync(path,{mode:0o700});directory(path);
  const value=learningCopy(initial),body={prior:null,value},record={...body,id:learningHash(body)};
  const fd=openSync(join(path,'events.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeAll(fd,Buffer.from(learningJson(record)+'\n'));fsyncSync(fd);}finally{closeSync(fd);}sync(path);sync(dirname(path));
 }
 directory(path);const identity=lstatSync(path),file=join(path,'events.jsonl');
 const check=()=>{directory(path);const s=lstatSync(path);if(s.dev!==identity.dev||s.ino!==identity.ino)throw Error('learning directory identity changed');};
 const read=():LearningEvent[]=>{check();const stat=lstatSync(file);if((stat.mode&0o077)||(process.getuid&&stat.uid!==process.getuid()))throw Error('private learning journal required');
  const text=learningFile(file,LIMIT).toString('utf8');if(!text.endsWith('\n'))throw Error('learning history incomplete');
  const lines=text.slice(0,-1).split('\n');if(!lines.length||lines.length>4096)throw Error('learning history bound');let prior:string|null=null;
  return lines.map(line=>{const r=JSON.parse(line) as LearningEvent;if(learningJson(r)!==line||Object.keys(r).sort().join()!=='id,prior,value'||r.prior!==prior||r.id!==learningHash({prior,value:r.value}))throw Error('learning history identity mismatch');prior=r.id;return r;});
 };
 read();
 return {read,append(prior:string,value:Record<string,unknown>){check();const lock=join(path,'writer.lock'),token=randomUUID();const fd=openSync(lock,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),owned=fstatSync(fd);let error:unknown,result:LearningEvent|undefined;
  try{writeAll(fd,Buffer.from(token));fsyncSync(fd);const history=read();if(history.at(-1)!.id!==prior)throw Error('stale learning CAS');if(history.length>=4096)throw Error('learning history bound');
   const body={prior,value:learningCopy(value)},event={...body,id:learningHash(body)},line=Buffer.from(learningJson(event)+'\n');
   const out=openSync(file,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{const s=fstatSync(out);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.size+line.length>LIMIT)throw Error('learning append refused');writeAll(out,line);fsyncSync(out);}finally{closeSync(out);}sync(path);result=event;
  }catch(e){error=e;}finally{try{const s=lstatSync(lock);if(s.dev!==owned.dev||s.ino!==owned.ino||learningFile(lock,128).toString()!==token)throw Error('learning lock ownership lost');unlinkSync(lock);sync(path);}catch(e){error??=e;}finally{try{closeSync(fd);}catch(e){error??=e;}}}
  if(error)throw error;return result!;
 }};
}
/** One authoritative store per weekly key/policy in this archive; a renamed directory cannot refill it. */
export function registerLearningStore(root:string,kind:'weekly'|'trust',key:string,target:string,binding:string){
 if(!/^[a-f0-9]{64}$/.test(key)||!isAbsolute(target)||!['weekly','trust'].includes(kind))throw Error('invalid learning registration');directory(root);directory(dirname(target));
 const parent=join(root,'learning-stores');try{mkdirSync(parent,{mode:0o700});sync(root);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}directory(parent);
 const path=join(parent,`${kind}-${key}`),initial={type:'learning-registration-v1',target:resolve(target),binding};
 try{learningJournal(path,initial);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const records=learningJournal(path).read();if(records.length!==1||learningHash(records[0].value)!==learningHash(initial))throw Error('learning key already bound to another store or input');}
}
export function verifyLearningStore(root:string,kind:'weekly'|'trust',key:string,target:string,binding:string){
 if(!/^[a-f0-9]{64}$/.test(key)||!isAbsolute(target))throw Error('invalid learning registration');
 const records=learningJournal(join(root,'learning-stores',`${kind}-${key}`)).read();
 if(records.length!==1||learningHash(records[0].value)!==learningHash({type:'learning-registration-v1',target:resolve(target),binding}))throw Error('learning store registration mismatch');
}
function writeAll(fd:number,bytes:Buffer){let n=0;while(n<bytes.length){const k=writeSync(fd,bytes,n,bytes.length-n);if(!k)throw Error('learning write stalled');n+=k;}}
