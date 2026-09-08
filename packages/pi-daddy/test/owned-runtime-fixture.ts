import { constants, createReadStream } from "node:fs";
import { copyFile, chmod, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
/** A test-only byte-identical private copy, not installation or shared-cache permission repair. */
export async function ownedRuntimeFixture(directory: string) {
  const source=await realpath(process.execPath),before=await lstat(source),target=join(directory,"node");
  assert.ok(before.isFile()&&before.size<=268435456,"bounded regular retained Node required for the missing-bwrap fixture");
  const hash=async(path:string)=>{const digest=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(path)){bytes+=chunk.length;if(bytes>268435456)throw new Error("runtime fixture source grew beyond bound");digest.update(chunk);}return digest.digest("hex");};
  const expected=await hash(source);await copyFile(source,target,constants.COPYFILE_EXCL);await chmod(target,0o500);
  assert.equal(await hash(target),expected);assert.equal(await hash(source),expected);
  const after=await lstat(source);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(after.mode,before.mode);assert.equal(after.size,before.size);
  return target;
}
