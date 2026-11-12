// Pure: how a client builds a challenge's world. The server replays with the same function and the stored setup version.
import { challengeSetup, SETUP_LEGACY } from '@tendril/sim/src/index.ts';
import type { ChallengeKind } from '@tendril/sim/src/index.ts';

/** The fields of a ChallengeInfo that decide the world. */
export interface WorldFields {
  id: string; kind: ChallengeKind; seed: number; ticks: number; setupVersion?: number;
  /** Rules v4: the day's prices (centicoins, index = item id). Absent or null: base prices. */
  market?: { prices: number[] } | null;
}

/** The starting conditions of a challenge, from the same function and stored version the server replays with. */
export const setupOf = (c: Pick<WorldFields, 'kind' | 'seed' | 'setupVersion' | 'market'>) =>
  challengeSetup(c.kind, c.seed, c.setupVersion ?? SETUP_LEGACY, c.market ? { p: c.market.prices } : null);

/** Scenario fields for the sim worker; the server builds the same world from the same function. */
export const challengeScenario = (c: WorldFields) => ({ tickLimit: c.ticks, farmId: c.id, setup: setupOf(c).setup });
