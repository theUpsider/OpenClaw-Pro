# Advisor (plugin)

Off by default. Advisor watches user-directed work and steps
in while the agent goes off course: repeating failing steps, waiting on
finished work, working around a blocker it could fix, drifting beyond the
request, or claiming results the tools do not show.

<<<<<<< OURS/upstream-11.10
A review forks the conversation on the session's own model and asks whether the
agent is on track. The reply is `NO_CHANGE` or `CORRECTION` followed by one
short correction, which steers the active run under its own permissions. If the
run already ended, the correction is dropped. Reviews run when a trigger is due:
||||||| BASE/v11.4
Review replies must start with `NO_CHANGE` or `CORRECTION` on its own line.
`NO_CHANGE` never starts verification or steering, even with commentary. A draft
correction is checked against the same session by a verifier, which replies
`APPROVE` with the final advice or `REJECT`. Only the approved body is delivered.
Both steps share a 120-second deadline. Advice is limited to 120 words and each
reply to 2,000 characters. Reserved decision words are not allowed as whole tokens
anywhere in either reply's body, including inline or next to punctuation.
Malformed replies, verification errors, and timeouts never steer; parser failures
log a bounded reason, and other failures log only a fixed category.

Enable it in **Settings → Agents & Tools → Labs → Advisor**. Its **Configure**
button opens the plugin's settings page. Or use config:
=======
Review replies must start with `NO_CHANGE` or `CORRECTION` on its own line.
`NO_CHANGE` never starts verification or steering, even with commentary. A draft
correction is checked against the same session by a verifier, which replies
`APPROVE` with the final advice or `REJECT`. Only the approved body is delivered.
Both steps share a 240-second deadline. Advice is limited to 120 words and each
reply to 2,000 characters. Reserved decision words are not allowed as whole tokens
anywhere in either reply's body, including inline or next to punctuation.
Malformed replies, verification errors, and timeouts never steer; parser failures
log a bounded reason, and other failures log only a fixed category.

Enable it in **Settings → Agents & Tools → Labs → Advisor**. Its **Configure**
button opens the plugin's settings page. Or use config:
>>>>>>> THEIRS/pro-main

```json
{
  "plugins": {
    "entries": {
      "advisor": {
        "enabled": true,
        "config": { "everyMinutes": 20, "everyToolCalls": 0 }
      }
    }
  }
}
```

- `everyMinutes` (default `20`): review after this many minutes of work in a run,
  checked when a tool starts. `0` turns it off.
- `everyToolCalls` (default `0`, off): also review after this many tool calls.
- `reviewInstructions`: optional guidance that replaces the built-in definition
  of "off course". Changes apply to the next review.

A due review waits until every running tool call has its result, so the fork never
sees a missing or synthetic tool outcome. User-triggered runs are reviewed,
including subagent runs (also those a cron run spawns), each in its own session.
A later review in the same run is told the correction it already gave and does
not repeat it. Each conversation has at most one review in flight; the run
ending or a new user message cancels it. Gateway info logs record review token
usage, whether a correction was steered, and each cancelled review with its
reason and running time.

Docs: https://docs.openclaw.ai/plugins/reference/advisor
