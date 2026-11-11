# Brain: start here

This folder lets any agent take over Tendril without reading the whole codebase.
Read these in order. Each file is short.

1. **STATUS.md**: what is done, what is in flight, who owns which files, known issues. Read it first.
2. **MAP.md**: every directory and file, one line each. Use it instead of exploring.
3. **CONTRACTS.md**: the interfaces between modules (sim API, worker protocol, renderer API, HTTP API, DB schema, asset format). Code must match these.
4. **DECISIONS.md**: every decision with its reason. Append only. Check it before re-deciding anything.
5. **JOURNAL.md**: dated log of what happened, newest last.
6. **BACKLOG.md**: remaining plan items, proposed interfaces and unapproved future choices. Do not confuse asset availability with gameplay completion.
7. `docs/SIM_SPEC.md`: exact rules of the simulation (the source of truth for `packages/sim`).
8. `docs/PLAN.md`: the original design plan. Where it disagrees with DECISIONS.md, DECISIONS.md wins.

## Rules for every agent

- Edit only the files your brief says you own. If you need a change elsewhere, write it in your notes file as a request.
- When you finish, write `brain/notes/<your-workstream>.md`: files changed, checks run with their real output, decisions you made (with reasons), open issues. The coordinator merges notes into the shared brain files. Do not edit `STATUS.md`, `MAP.md`, `DECISIONS.md` or `JOURNAL.md` yourself unless your brief says so.
- Never commit, push or touch `main`. The coordinator reviews and commits on `dev`, and merges to `main` only after the full gate passes (see STATUS.md, "Gate").
- Never edit `~/Developer/tendril`. That is the original project and stays untouched (D-001).
