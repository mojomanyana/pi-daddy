import { test as nodeTest,type TestContext,type TestOptions } from "node:test";
type Body=(t:TestContext)=>void|Promise<void>;
/** Preserve default case45s and existing explicit30s/60s groups beneath the file120s wrapper. */
export function test(name:string,body:Body):ReturnType<typeof nodeTest>;
export function test(name:string,options:TestOptions,body:Body):ReturnType<typeof nodeTest>;
export function test(name:string,options:TestOptions|Body,body?:Body){
 return typeof options==="function"?nodeTest(name,{timeout:45000},options):nodeTest(name,{timeout:45000,...options},body!);
}
