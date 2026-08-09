#!/usr/bin/env python3
"""Retrospective baseline capture from pi session history.

Measures B1 (catalog size inputs), B3 (tokens per task), B6 (cost per task), B8 (inter-turn
gaps), B9 (distinct tools per session) and B10-adjacent shape data from ALREADY-EXISTING pi
session records. No instrumentation, no API calls, no new code in the agent loop.

Usage:  python3 session_stats.py [SESSIONS_DIR]
Default SESSIONS_DIR is ~/.pi/agent/sessions
"""

import collections
import glob
import json
import os
import statistics
import sys

TOOL_CALL_TYPES = ("toolCall", "tool_use", "tool_call")


def pct(values, p):
    """Nearest-rank percentile; returns None for an empty input."""
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round(p / 100 * len(ordered))) - 1))
    return ordered[idx]


def iter_entries(sessions_dir):
    for path in glob.glob(os.path.join(sessions_dir, "**", "*.jsonl"), recursive=True):
        with open(path, errors="ignore") as handle:
            for line in handle:
                try:
                    yield path, json.loads(line)
                except json.JSONDecodeError:
                    continue


def collect(sessions_dir):
    sessions = collections.defaultdict(
        lambda: {
            "tools": set(),
            "calls": 0,
            "user_turns": 0,
            "tokens_in": 0,
            "tokens_out": 0,
            "cache_read": 0,
            "cache_write": 0,
            "cost": 0.0,
            "prompt_sizes": [],
            "entry_types": collections.Counter(),
        }
    )
    tool_calls = collections.Counter()
    entry_types = collections.Counter()

    for path, entry in iter_entries(sessions_dir):
        s = sessions[path]
        etype = entry.get("type", "<none>")
        entry_types[etype] += 1
        s["entry_types"][etype] += 1
        if etype != "message":
            continue

        message = entry.get("message") or entry
        if message.get("role") == "user":
            s["user_turns"] += 1

        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") in TOOL_CALL_TYPES:
                    name = block.get("name") or block.get("toolName") or "?"
                    s["tools"].add(name)
                    s["calls"] += 1
                    tool_calls[name] += 1

        usage = message.get("usage") or {}
        if usage:
            s["tokens_in"] += usage.get("input", 0) or 0
            s["tokens_out"] += usage.get("output", 0) or 0
            s["cache_read"] += usage.get("cacheRead", 0) or 0
            s["cache_write"] += usage.get("cacheWrite", 0) or 0
            cost = usage.get("cost") or {}
            s["cost"] += cost.get("total", 0) or 0
            prompt = (usage.get("input", 0) or 0) + (usage.get("cacheRead", 0) or 0)
            if prompt:
                s["prompt_sizes"].append(prompt)

    return sessions, tool_calls, entry_types


def main():
    sessions_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/sessions")
    sessions, tool_calls, entry_types = collect(sessions_dir)
    active = {p: s for p, s in sessions.items() if s["calls"]}

    print(f"sessions dir      : {sessions_dir}")
    print(f"session files     : {len(sessions)}  (with >=1 tool call: {len(active)})")
    print()

    print("=== entry types present (settles which session entries the CLI actually writes) ===")
    for name, count in entry_types.most_common():
        print(f"  {count:7d}  {name}")
    print("  NOTE: absence of 'active_tools_change' is only informative if some extension")
    print("        in this setup calls setActiveTools(). If none does, this says nothing about A-11.")
    print()

    print(f"=== B9: distinct tools used per session (n={len(active)}) ===")
    distinct = [len(s["tools"]) for s in active.values()]
    if distinct:
        print(f"  min={min(distinct)}  p50={pct(distinct,50)}  p90={pct(distinct,90)}  max={max(distinct)}"
              f"  mean={statistics.mean(distinct):.2f}")
        for k, v in sorted(collections.Counter(distinct).items()):
            print(f"    {k:2d} tools: {'#' * v} ({v})")
    print()

    print("=== B1 input: distinct tools ever called across all history ===")
    total = sum(tool_calls.values())
    print(f"  distinct tools ever used: {len(tool_calls)}   total calls: {total}")
    running = 0
    for name, count in tool_calls.most_common():
        running += count
        share = 100 * count / total if total else 0
        print(f"    {count:6d}  ({share:5.1f}%, cum {100*running/total:5.1f}%)  {name}")
    print()

    print("=== B3 / B6: tokens and cost per session ===")
    for label, key in (
        ("prompt(input) tokens", "tokens_in"),
        ("completion tokens", "tokens_out"),
        ("cacheRead tokens", "cache_read"),
        ("cacheWrite tokens", "cache_write"),
    ):
        vals = [s[key] for s in active.values()]
        if vals:
            print(f"  {label:22s} p50={pct(vals,50):>9,}  p90={pct(vals,90):>9,}  total={sum(vals):>12,}")
    costs = [s["cost"] for s in active.values()]
    if costs:
        print(f"  {'cost (USD)':22s} p50={pct(costs,50):>9.4f}  p90={pct(costs,90):>9.4f}  total={sum(costs):>12.4f}")
    print()

    print("=== C term for the A-02 break-even (S > 11.5 * c * C) ===")
    prompts = [p for s in active.values() for p in s["prompt_sizes"]]
    if prompts:
        print(f"  per-request prompt size (input+cacheRead): p50={pct(prompts,50):,}  p90={pct(prompts,90):,}  max={max(prompts):,}")
    turns = [s["user_turns"] for s in active.values()]
    calls = [s["calls"] for s in active.values()]
    if turns:
        print(f"  user turns per session : p50={pct(turns,50)}  p90={pct(turns,90)}  max={max(turns)}")
    if calls:
        print(f"  tool calls per session : p50={pct(calls,50)}  p90={pct(calls,90)}  max={max(calls)}")
    cr, cw = sum(s["cache_read"] for s in active.values()), sum(s["cache_write"] for s in active.values())
    print(f"  cache usage totals     : cacheRead={cr:,}  cacheWrite={cw:,}")
    if cr == 0 and cw == 0:
        print("  ** NO PROMPT CACHING OBSERVED — see README: this inverts part of the R-01 argument **")


if __name__ == "__main__":
    main()
