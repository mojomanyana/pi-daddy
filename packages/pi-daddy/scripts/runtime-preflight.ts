import { inspectDigestPrerequisites } from "../src/effect-profile-runtime.ts";
// Telemetry, NOT a prerequisite pass or a replacement for any required test. Always report every path;
// unsupported observations remain conforms:false, while the following full suite exercises the guards.
console.log(JSON.stringify(await inspectDigestPrerequisites(), null, 2));
