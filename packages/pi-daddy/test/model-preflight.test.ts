import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightModel } from "../src/model-preflight.ts";

test("model preflight uses pi's provider/id catalogue and caches each answer per session", () => {
  let finds = 0;
  const catalogue = {
    find(provider: string, id: string) {
      finds += 1;
      return provider === "provider" && id === "family/model" ? { provider, id } : undefined;
    },
  };
  const cache = new Map<string, boolean>();
  assert.equal(preflightModel("provider/family/model", catalogue, cache, false), undefined);
  assert.equal(preflightModel("provider/family/model", catalogue, cache, false), undefined);
  assert.equal(finds, 1, "the session cache prevents repeated catalogue resolution");
  assert.equal(preflightModel("missing/model", catalogue, cache, false)?.code, "MODEL_UNRESOLVED");
  assert.equal(preflightModel("missing/model", catalogue, cache, false)?.code, "MODEL_UNRESOLVED");
  assert.equal(finds, 2, "negative answers are cached too");
});

test("only the operator bypass permits an unresolved model", () => {
  const catalogue = { find: () => undefined };
  assert.equal(preflightModel("custom/model", catalogue, new Map(), true), undefined);
  const refusal = preflightModel("custom/model", catalogue, new Map(), false);
  assert.equal(refusal?.code, "MODEL_UNRESOLVED");
  assert.match(refusal?.message ?? "", /PI_GRANTS_ALLOW_UNRESOLVED_MODELS=1/);
});
