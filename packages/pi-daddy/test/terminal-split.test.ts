/** Unit tests for Bucket 2B: cross-OS terminal split planning (tmux, WezTerm, Kitty, Ghostty, iTerm2, wt). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectSupportedSplitters, planTerminalSplit } from "../src/products/terminal-split.ts";

const URL = "http://127.0.0.1:45123/?token=abc";

test("planTerminalSplit selects Kitty vsplit with optional KITTY_LISTEN_ON socket", () => {
  const plain = planTerminalSplit(URL, { KITTY_WINDOW_ID: "42" }, "darwin");
  assert.deepEqual(plain, {
    kind: "kitty",
    command: "kitty",
    args: ["@", "launch", "--type=window", "--location=vsplit", "--cwd=current", "pi-daddy", "panel", URL],
  });

  const withSocket = planTerminalSplit(URL, { KITTY_WINDOW_ID: "42", KITTY_LISTEN_ON: "unix:/tmp/mykitty" }, "linux");
  assert.deepEqual(withSocket, {
    kind: "kitty",
    command: "kitty",
    args: [
      "@",
      "--to",
      "unix:/tmp/mykitty",
      "launch",
      "--type=window",
      "--location=vsplit",
      "--cwd=current",
      "pi-daddy",
      "panel",
      URL,
    ],
  });
});

test("planTerminalSplit supports Ghostty on macOS and Linux, while preferring tmux when nested", () => {
  assert.deepEqual(planTerminalSplit(URL, { TERM_PROGRAM: "ghostty" }, "darwin"), {
    kind: "ghostty",
    command: "open",
    args: ["-na", "Ghostty", "--args", "-e", "pi-daddy", "panel", URL],
  });
  assert.deepEqual(planTerminalSplit(URL, { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }, "linux"), {
    kind: "ghostty",
    command: "ghostty",
    args: ["-e", "pi-daddy", "panel", URL],
  });
  // Inside tmux running in Ghostty, tmux split wins
  assert.equal(
    planTerminalSplit(URL, { TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "ghostty" }, "darwin")?.kind,
    "tmux",
  );
});

test("planTerminalSplit covers WezTerm, macOS iTerm2, Windows Terminal, and returns undefined when unsupported", () => {
  assert.equal(planTerminalSplit(URL, { WEZTERM_PANE: "7" }, "darwin")?.kind, "wezterm");
  assert.equal(planTerminalSplit(URL, { TERM_PROGRAM: "iTerm.app" }, "darwin")?.kind, "iterm2");
  assert.equal(planTerminalSplit(URL, { WT_SESSION: "guid-1" }, "win32")?.kind, "wt");
  assert.equal(planTerminalSplit(URL, {}, "linux"), undefined);
});

test("detectSupportedSplitters reports Kitty and Ghostty alongside tmux, WezTerm, iTerm2, and wt", () => {
  const found = detectSupportedSplitters((cmd) => cmd === "kitty" || cmd === "ghostty" || cmd === "tmux", {}, "darwin");
  assert.deepEqual(found, ["tmux", "kitty", "ghostty", "iTerm2 (osascript)"]);
});
