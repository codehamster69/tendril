// Pure: how a client builds a challenge's world. The server replays with the same function and the stored setup version.
import { challengeSetup, SETUP_LEGACY } from '@tendril/sim/src/index.ts';
import type { ChallengeKind } from '@tendril/sim/src/index.ts';

/** The fields of a ChallengeInfo that decide the world. */
export interface WorldFields {
  id: string; kind: ChallengeKind; seed: number; ticks: number; setupVersion?: number;
  /** Rules v4: the day's prices (centicoins, index = item id). Absent or null: base prices. */
  market?: { prices: number[] } | null;
  /** Rules v5 switches silos on from the first tick. */
  rulesVersion?: number;
  /** A duel copied from a brief challenge: its source kind (the same brief is drawn). */
  briefSource?: 'daily' | 'season';
  /** The world seed when it is not the challenge seed (a practice farm runs the brief on another farm). */
  farmSeed?: number;
}

/** The seed of the world a challenge is played on. */
export const worldSeedOf = (c: Pick<WorldFields, 'seed' | 'farmSeed'>): number => c.farmSeed ?? c.seed;

/** The starting conditions of a challenge, from the same function and stored version the server replays with. */
export const setupOf = (c: Pick<WorldFields, 'kind' | 'seed' | 'setupVersion' | 'market' | 'rulesVersion' | 'briefSource'>) =>
  challengeSetup(c.kind, c.seed, c.setupVersion ?? SETUP_LEGACY, c.market ? { p: c.market.prices } : null, c.rulesVersion, c.briefSource);

/** Scenario fields for the sim worker; the server builds the same world from the same function. */
export const challengeScenario = (c: WorldFields) => ({ tickLimit: c.ticks, farmId: c.id, setup: setupOf(c).setup });
