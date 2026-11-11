# Remaining plan — not completed or canceled

These are explicit remaining milestones after the first playable slice. Proposed designs below came from a read-only Plan agent; they are not accepted game-balance decisions. Coordinator must log accepted choices before implementation.

## Campaign and teaching

Separate campaign save/fixture from sandbox and ranked farms. Gate Lua wrapper access locally, never alter server legality using editable campaign saves. Proposed types: PlayMode=campaign|sandbox|ranked, CampaignSave={schema:1,completed:string[]}, LessonTrace={op,result,after:Snapshot}. Six lessons cover loops/carrot; scan/wheat/deposit/sell; water/clover/rotation; crew/signals; contracts/forecast; perennials/pollination/compost. Keep position/load/tick/wait/log always available to avoid deadlocks. Proposed completion-based unlocks rather than spending ranked capital; user may choose otherwise. Current instruments are not a full historical action profiler.

## Rules version 3: tier 5

Requires spec-first design, explicit balance parameters, version-dispatched replay and fresh golden hashes; preserve v2 replays. Proposed crop IDs5 orchard/6berry; append new operations build(hive|composter), clear, compost, fertilize without renumbering v2 operations. Existing berry and hive art must not be mistaken for implemented gameplay.

Perennial growth cycles should use timestamp arithmetic and fixed-at-cycle-start adjacency bonuses from four orthogonal neighboring hives, not per-tick whole-farm scans. Keep immutable readiness/rate for the cycle; hive changes apply next cycle. Proposed compost reserve consumes produce at composter, fertilize adjusts soil with bounded integer arithmetic. Rules/prices/tick costs are NOT chosen yet.

Important technical constraint: tile timestamps currently reside in Int32Array; truly long-lived farms eventually overflow. v3 should consider safe-number storage, document horizon and preserve checkpoint conversion. Snapshot/hash/replay cost still grows with action count, bots and farm state; lazy tile settling alone does not make all costs flat.

## Monthly leagues

Proposed League={id,seed,startsAtMs,endsAtMs,rulesVersion,rulesHash}; idempotent join(user,league), equal seed/initial checkpoint/server epoch, no imported coins/unlocks, late joins catch up same clock. Reuse bounded chunk replay and CAS revisions; tick ceiling uses min(serverNow,leagueEnd). Final standings need explicit upload-close/finalization policy. No production league service currently.

## Hosted delivery and auth (approval required)

Provider/project/account selection, real GitHub/email or other auth, desktop redirect/deep link, hosted database adapters and public board require explicit user authorization and free-tier confirmation. Local dev tokens are not production auth. Do not create repositories, publish/deploy, enable billing, or buy signing certificates automatically. Windows/Linux installer launch cannot be validated on this Mac alone.

## Backlog replay versus abuse limits

Ten chunk attempts/hour and 20,000 ticks/chunk cannot consume a long offline backlog promptly. Distinguish anti-abuse limits from authenticated recovery budgets before claiming seamless months-long ranked catch-up. Action logs and checkpoints must never silently discard unpaid/unsynced chunks. Distributed ownership/rate-limit races need genuine Postgres deployment tests in addition to PGlite single-process tests.
