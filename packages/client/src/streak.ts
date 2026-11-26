import { signedInHint } from './api-client';
import type { FarmApi } from './api-client';

let cached: Promise<number | null> | null = null;

/** The signed-in player's daily streak (consecutive UTC days with a daily challenge, same count as the README badge). Null: signed out or offline. Asked once per page. */
export function dailyStreak(api: FarmApi): Promise<number | null> {
  if (!signedInHint()) return Promise.resolve(null);
  cached ??= api.me().then((m) => api.player(m.profile.login)).then((p) => p.streak.current).catch(() => null);
  return cached;
}

export const streakText = (days: number): string => days > 0 ? `${days}-day streak` : 'No streak yet';
