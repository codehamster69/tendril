import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { dailyNumber, dailySeed, DAILY_PAR, RULES_VERSION } from '@tendril/sim/src/index.ts';

const date = new Date().toISOString().slice(0, 10);
const daily = {
  id: `d-${date}`, kind: 'daily', number: dailyNumber(date), seed: dailySeed(date), ticks: 3000, par: DAILY_PAR,
  opensAt: Date.now() - 3_600_000, closesAt: Date.now() + 3_600_000, rulesVersion: RULES_VERSION, players: 3, best: 400,
};
const DUEL = 'x-aB_dE9xQ'; // an id with an underscore: the server's base64url ids can have one
const duelInfo = { ...daily, id: DUEL, kind: 'duel', number: null, opensAt: Date.now(), closesAt: null };
const people = {
  ann: { id: 'u1', login: 'ann', displayName: 'Ann', avatarUrl: null },
  bo: { id: 'u2', login: 'bo', displayName: 'Bo', avatarUrl: null },
};
const entryFor = (id: string, netWorth: number) => ({ entryId: id, netWorth, parTick: 1200, tokens: null, mosaic: 'B' + '1'.repeat(63), ranks: { wealth: 1, speed: 1, brevity: null }, percentile: 100, improved: true, total: 2 });

/** One fake server shared by every browser context of a test, so two players can meet in the same duel. */
function makeServer() {
  const s = { duelsCreated: 0, entries: [] as { who: string; challenge: string }[], accepted: [] as string[] };
  const install = async (context: BrowserContext, who: keyof typeof people | null) => {
    if (who) await context.addInitScript(() => localStorage.setItem('tendril.signedin', '1'));
    await context.route('**/api/**', (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace('/api', '');
      const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/me') return who ? json(200, { profile: people[who] }) : json(401, { error: 'Sign in first.' });
      if (path === `/challenges/${daily.id}`) return json(200, daily);
      if (path === `/challenges/${DUEL}`) return json(200, duelInfo);
      if (path === '/duels' && req.method() === 'POST') { if (!who) return json(401, { error: 'no' }); s.duelsCreated++; return json(201, { challengeId: DUEL }); }
      if (path.endsWith('/entries') && req.method() === 'POST') {
        if (!who) return json(401, { error: 'Sign in first.' });
        const challenge = path.split('/')[2]!;
        s.entries.push({ who, challenge });
        return json(200, entryFor(`entry-${who}-12`, 500));
      }
      if (path === `/duels/${DUEL}` && req.method() === 'GET') {
        const ann = s.entries.find((e) => e.who === 'ann' && e.challenge === DUEL);
        return json(200, { id: DUEL, seed: daily.seed, ticks: 3000, par: DAILY_PAR, rulesVersion: RULES_VERSION, createdAt: 1, challenger: people.ann, entry: ann ? { entryId: 'entry-ann-12', netWorth: 321, parTick: 1200, mosaic: null } : null, accepted: s.accepted.length, viewer: who ? { isChallenger: who === 'ann', accepted: false, entryId: null } : null });
      }
      if (path === `/duels/${DUEL}/accept` && req.method() === 'POST') { s.accepted.push(who ?? '?'); return json(200, { accepted: true, changed: true, challenger: people.ann }); }
      return json(404, { error: 'not mocked' });
    });
  };
  return { s, install };
}

async function runToEnd(page: Page): Promise<void> {
  await page.click('#btn-run-end');
  await expect(page.locator('#arena-result')).toBeVisible({ timeout: 15_000 });
}

test('create a duel as one player, accept it as another in a fresh context, reach the race', async ({ browser }) => {
  const server = makeServer();
  const a = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await server.install(a, 'ann');
  const pa = await a.newPage();
  await pa.goto('/?mode=daily');
  await runToEnd(pa);
  await pa.click('#btn-challenge');
  const link = await pa.locator('#duel-link').inputValue();
  expect(link).toBe(`http://localhost:${process.env.PW_PORT ?? 4173}/duel/?id=${DUEL}`);
  expect(server.s.duelsCreated).toBe(1);
  expect(server.s.entries).toEqual([{ who: 'ann', challenge: daily.id }, { who: 'ann', challenge: DUEL }]);
  expect(await pa.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await a.close();

  const b = await browser.newContext(); // fresh browser: no storage, no cookies
  await server.install(b, 'bo');
  const pb = await b.newPage();
  await pb.goto(`/?mode=challenge&id=${DUEL}`);
  await expect(pb.locator('#arena-head')).toContainText('Duel');
  await runToEnd(pb);
  await expect(pb.locator('#duel-status')).toContainText('Ann 321');
  await expect(pb.locator('#duel-follow')).toHaveText('You and Ann now follow each other.');
  expect(server.s.accepted).toEqual(['bo']);
  const race = pb.locator('#duel-race');
  await expect(race).toHaveAttribute('src', 'replay.html?e=entry-ann-12&vs=entry-bo-12&embed=1');
  await expect(pb.locator('#duel-race-link')).toHaveAttribute('href', 'replay.html?e=entry-ann-12&vs=entry-bo-12');
  await b.close();
});

test('signed out: a local result against the challenger and a sign-in prompt, nothing submitted', async ({ browser }) => {
  const server = makeServer();
  server.s.entries.push({ who: 'ann', challenge: DUEL });
  const c = await browser.newContext();
  await server.install(c, null);
  const p = await c.newPage();
  await p.goto(`/?mode=challenge&id=${DUEL}`);
  await runToEnd(p);
  await expect(p.locator('#arena-facts')).toContainText('net worth');
  await expect(p.locator('#duel-status')).toContainText('Ann 321');
  await expect(p.locator('#btn-duel-signin')).toBeVisible();
  await expect(p.locator('#btn-arena-signin')).toBeVisible();
  await expect(p.locator('#duel-race')).toHaveCount(0);
  expect(server.s.entries).toHaveLength(1);
  expect(server.s.accepted).toEqual([]);
  await c.close();
});
