/**
 * The mutation auditor's transcript parser, extracted so that it can itself be tested — because when it
 * broke, every guard in the catalogue reported as missing.
 *
 * **Measured 2026-08-22 at `0a62a42`, with all twenty guards intact:** `npm run test:mutation` printed
 * `0/20 guards forced a named failure`. The guards were fine. The session's environment exports
 * `FORCE_COLOR=3`, so `node --test` emitted an SGR-coloured `✖ name` line, and the matcher — anchored on
 * `^\s*✖` — could never match past the escape sequence. The same sweep with `FORCE_COLOR=0` printed `20/20`.
 *
 * That failure mode is worse than it looks. The auditor exists to stop a session trusting a guard nothing
 * forces; when it cannot read the reporter it says *"a guard nothing forces is not a guard"* twenty times,
 * which sends the next session round a loop of fixing twenty guards that were never broken.
 *
 * Two defences, because either alone can fail:
 *
 *  - **Strip ANSI before matching**, so no colouring environment can blind the parser. The auditor also
 *    pins `FORCE_COLOR=0` in the child's environment; that is belt-and-braces, and it is the strip that
 *    `test/mutation-audit.test.ts` forces.
 *  - **`reporterWasReadable`, a positive control.** If a transcript yields no test-name line at all, the
 *    auditor must report that it could not read the output rather than score the guard as unforced.
 *    "I saw no failure" and "I saw nothing" are different sentences, and only one of them is about the guard.
 */

const ANSI = /\u001b\[[0-9;]*m/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/**
 * The names of the tests that FAILED — not the transcript, which also contains the names of the tests that
 * passed. `node --test`'s spec reporter prints a name on `✔` too, so matching the transcript scores an entry
 * as proven whenever a mutation breaks some NEIGHBOUR of the guard's own test.
 */
export const failedTestNames = (stdout: string): string[] =>
  [...stripAnsi(stdout).matchAll(/^\s*✖ (.+?)(?: \(\d|$)/gm)].map((match) => match[1]);

/** Did this transcript contain any test-name line at all? See the positive-control note above. */
export const reporterWasReadable = (stdout: string): boolean => /^\s*[✔✖] /m.test(stripAnsi(stdout));
