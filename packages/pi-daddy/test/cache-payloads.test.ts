import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CachePayloads } from "../src/products/cache-payloads.ts";

test("invalidation removes reusable ownership while an existing delivery alone pins immutable bytes", () => {
  const pool = new CachePayloads({ bytes: 20, itemBytes: 10, deliveries: 2, payloads: 2 });
  const payload = pool.store("original");
  assert.ok(payload);
  const delivery = pool.pin(payload);
  assert.ok(delivery);
  pool.drop(payload);
  assert.equal(pool.pin(payload), undefined, "new delivery cannot read invalidated output");
  assert.equal(delivery.read(), "original");
  assert.deepEqual(pool.stats(), { bytes: 8, payloads: 1, deliveries: 1 });
  delivery.release();
  delivery.release();
  pool.drop(payload);
  assert.deepEqual(pool.stats(), { bytes: 0, payloads: 0, deliveries: 0 });
  assert.throws(() => delivery.read(), /released/);
});

test("pinned invalid output remains charged, limits are atomic, and UTF8 rather than string length is counted", () => {
  const pool = new CachePayloads({ bytes: 8, itemBytes: 8, deliveries: 1, payloads: 2 });
  const payload = pool.store("😀😀");
  assert.ok(payload);
  const delivery = pool.pin(payload);
  assert.ok(delivery);
  assert.equal(pool.pin(payload), undefined);
  pool.drop(payload);
  assert.equal(pool.store("x"), undefined, "eviction cannot invent free pinned capacity");
  assert.deepEqual(pool.stats(), { bytes: 8, payloads: 1, deliveries: 1 });
  delivery.release();
  assert.ok(pool.store("12345678"));
  assert.equal(pool.store("123456789"), undefined);
  assert.deepEqual(pool.stats(), { bytes: 8, payloads: 1, deliveries: 0 });
  const zero = new CachePayloads({ bytes: 8, itemBytes: 8, deliveries: 1, payloads: 1 });
  assert.ok(zero.store(""));
  assert.equal(zero.store(""), undefined, "zero-byte metadata is bounded too");
});

test("clear drops all reusable ownership but cannot revoke an already acquired delivery", () => {
  const pool = new CachePayloads({ bytes: 12, itemBytes: 6, deliveries: 2, payloads: 2 });
  const one = pool.store("first"),
    two = pool.store("second");
  assert.ok(one);
  assert.ok(two);
  const delivery = pool.pin(one);
  assert.ok(delivery);
  pool.clear();
  assert.equal(pool.pin(one), undefined);
  assert.equal(pool.pin(two), undefined);
  assert.equal(delivery.read(), "first");
  assert.equal(pool.stats().bytes, 5);
  delivery.release();
  assert.equal(pool.stats().bytes, 0);
});

test("retaining retired tokens cannot retain uncharged internal descriptor rows", () => {
  const pool = new CachePayloads({ bytes: 1, itemBytes: 1, payloads: 1, deliveries: 1 });
  const held = [];
  // Read-only whitebox lifetime assertion: public byte/count stats alone cannot detect dead row retention.
  const handles = (pool as unknown as { handles: WeakMap<object, unknown> }).handles;
  for (let index = 0; index < 1000; index++) {
    const token = pool.store("");
    assert.ok(token);
    held.push(token);
    pool.drop(token);
    pool.drop(token);
    assert.equal(pool.pin(token), undefined);
  }
  assert.equal(held.filter((token) => handles.has(token)).length, 0);
  assert.deepEqual(pool.stats(), { bytes: 0, payloads: 0, deliveries: 0 });
});

test("retained released deliveries and tokens allow descriptor GC, not just empty byte accounting", async () => {
  const script = `
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {CachePayloads} from ${JSON.stringify(new URL("../src/products/cache-payloads.ts", import.meta.url).href)};
function prepare(){
  const pool=new CachePayloads({bytes:1,itemBytes:1,payloads:1,deliveries:1});
  const token=pool.store('x');const delivery=pool.pin(token);
  const descriptor=new WeakRef(pool.handles.get(token));
  pool.drop(token);delivery.release();return {pool,token,delivery,descriptor};
}
const retained=prepare();globalThis.retained=retained;
for(let pass=0;pass<30;pass++){await setImmediate();globalThis.gc();}
assert.equal(retained.descriptor.deref(),undefined,'released wrapper still retains internal descriptor');
assert.equal(retained.pool.pin(retained.token),undefined);assert.throws(()=>retained.delivery.read(),/released/);
`;
  await promisify(execFile)(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { timeout: 10000 });
});

test("foreign and fabricated handles never access a payload; malformed resource limits refuse", () => {
  const limits = { bytes: 8, itemBytes: 8, deliveries: 1, payloads: 2 };
  const one = new CachePayloads(limits),
    two = new CachePayloads(limits);
  const handle = one.store("secret");
  assert.ok(handle);
  assert.throws(() => two.pin(handle), /foreign/);
  assert.throws(() => two.drop(handle), /foreign/);
  assert.throws(() => one.pin({} as typeof handle), /foreign/);
  for (const options of [
    { ...limits, bytes: 0 },
    { ...limits, itemBytes: 9 },
    { ...limits, deliveries: NaN },
    { ...limits, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...limits, deliveries: 1.5 },
    { bytes: 8, itemBytes: 8, payloads: 2, notDeliveries: 1 } as unknown as typeof limits,
  ]) {
    assert.throws(() => new CachePayloads(options), /limit/);
  }
});
