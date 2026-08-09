# pi-token-audit

**Where did your tokens and money actually go?**

pi tells you how many input tokens a request used and how they split across the prompt cache. It tells
you which tool ran. It tells you nothing in between — there is no field anywhere for *"how much of this
request was tool definitions?"*

That's the number this measures.

```
token-audit — 1 provider request(s), model gpt-5.6-sol

  prompt tokens        6,947
    served from cache   0 (0.0%)
    cache writes        0   read:write = no cache writes seen
  output tokens        5
  cost                 $0.0349

  TOOL DEFINITIONS     ~4,993 tokens (~71.9% of prompt tokens)
    tools sent          13
    definition chars    24,179 in the last request

  method: chars/token measured per turn from this provider's own counts.
    median 4.84 chars/token, observed range n/a across 1 turn(s).
    Tool-token figures are derived, not provider-reported — treat the range as the error bar.
```

That run is real, and it is the reason this tool exists: a **fresh** pi session spent **72% of its
prompt budget describing its own tools** before doing any work.

## Install

```bash
pi install npm:pi-token-audit          # once published
pi install /path/to/pi-token-audit     # or straight from a checkout
pi -e ./extensions/token-audit.ts      # or try it for one run, no install
```

## Use

```bash
/token-audit          # in-session report
/token-audit json     # raw per-turn records

PI_TOKEN_AUDIT_PRINT=1 pi -p "your prompt"   # headless: report to stderr on exit
```

Headless output goes to **stderr**, so it never contaminates `--mode json` on stdout.

## How the tool-definition number is derived

It is **derived, not provider-reported** — no provider exposes per-region token attribution. The method
is deliberately dependency-free and self-calibrating:

1. On `before_provider_request`, measure the serialized character length of the whole payload and of its
   tool-definition array.
2. On the matching assistant `message_end`, read the provider's own prompt-token count.
3. Divide to get an **observed chars-per-token for this exact provider and model**, then apply it to the
   tool-definition characters.

So the conversion ratio is measured per turn rather than assumed, and its spread across turns is
reported as the error bar. No tokenizer dependency, no second API call, no guessing. (The observed ratio
is often nothing like the ~4.0 rule of thumb — the run above measured 4.84 on a JSON-heavy payload.)

**Treat the tool-token figures as a measurement with a method, not as a vendor number.** The report always
prints the ratio and its range so you can check it yourself.

## Privacy

**Invariant: this extension never retains message content, prompts, tool arguments, or tool results.** It
measures string lengths and immediately discards the serialized strings. Everything it keeps is a number,
a tool name, or a model id. Nothing is written to disk unless you ask for it, and there is no network
egress of any kind.

## Reading the result

The number that matters is **tool definitions as a share of prompt tokens**, because it decides whether
dynamic/deferred tool loading can help you at all:

- **Small share (under ~15%)** — typical of long coding sessions, where file content dominates. Definitions
  are cheap to keep (the cache serves them) and *expensive to churn*, because they sit at the **head** of
  the cacheable prefix, ahead of the system prompt and history: change them and everything downstream
  re-writes. Dynamic loading has little to win here; your context is the cost driver.
- **Large share (over ~40%)** — typical of fresh sessions, short tasks, and many-tool automation agents.
  This is the regime where deferred loading pays. Check whether your provider supports it natively
  (Anthropic Sonnet/Opus/Haiku 4.5+, OpenAI Responses gpt-5.4+, Kimi) — pi routes additive
  `setActiveTools` changes onto that path, which keeps the prefix intact.

The share is not a fixed property of your setup. It is high at session start and falls as history grows,
so read it as a curve, not a verdict.

## Related pi features worth knowing before you optimise anything

pi already ships static tool control, which is often the whole answer:

```bash
pi --tools read,edit,bash        # allowlist
pi --exclude-tools web_search    # denylist
pi --no-builtin-tools            # extensions only
```

If a session only ever needs four tools, an allowlist beats any retrieval layer — zero moving parts and a
stable cached prefix from the first turn.

## Compatibility

Requires pi **≥ 0.83.0** and Node **≥ 22.19**. Typechecked against pi 0.83.0's declarations. The
`before_provider_request` payload is provider-shaped and pi moves quickly, so the tool-array lookup checks
several known spellings (`tools`, `toolConfig`, `functions`) and degrades to reporting zero rather than
failing. Every handler is wrapped so it can never throw into the agent loop.

## Status

**0.1.0 — early.** Verified end to end against pi 0.83.0 with `openai-codex`/`gpt-5.6-sol`. Not yet
verified against Anthropic or Google payload shapes, and the deferred-tool count relies on
`defer_loading` appearing in the serialized payload. Bug reports with the output of `/token-audit json`
are the most useful thing you can send.

MIT.
