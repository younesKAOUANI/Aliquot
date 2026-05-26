# ADR-NNNN: <decision, stated as a claim rather than a topic>

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD
**Deciders:** <names>

## Context

What forced a decision now. The constraints actually in play — load, team size,
existing stack, deadlines. What breaks if this is got wrong.

Write this part before you know the answer. If you cannot state the problem
without naming the solution, you have not finished understanding it.

## Decision

One or two sentences that survive being quoted out of context.

## Options considered

### Option A: <name>

| Dimension | Assessment |
|---|---|
| Complexity | |
| <the dimensions that actually matter for this decision> | |

**Pros:**
**Cons:**

### Option B: <name>

...

> Include a third option only where one genuinely exists. A strawman added to
> make the list look thorough has the opposite effect on anyone who knows the
> area.

## Trade-off analysis

The real reasoning. Which option was hardest to argue against, and why it still
lost. Where the chosen option is weaker than the one it beat.

This is the section a reviewer reads to decide whether a decision was made or
defaulted into.

## Consequences

**Easier:** what this unlocks.

**Harder:** what this costs, permanently. Be specific; "some added complexity"
is not a consequence.

**To revisit:** the concrete conditions under which this should be reopened —
a load threshold, a new requirement, a dependency changing. Not "if needs
change".

## Action items

1. [ ] What the decision obliges, as a checklist.
2. [ ] Mark `[x]` as each lands in the codebase.

---

### Notes on writing these

- Write it **when you decide**, not afterwards. A retrofitted ADR reads like a
  justification; a contemporaneous one reads like engineering.
- The rejected options are the valuable part. They are the evidence a decision
  was made rather than defaulted into.
- State the residual risk and the weakness of the chosen option plainly.
  Overclaiming is the fastest way to lose a technical reader.
- Never silently edit an accepted ADR to match what was later built. Supersede
  it and set the old status to `Superseded by ADR-NNNN`. The wrong turn is part
  of the record.
