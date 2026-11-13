// Rating simulation: 1,000 synthetic players with hidden skill over 60 days.
// From workspace root: node --experimental-strip-types packages/rating/scripts/simulate.ts
import { ALGO_VERSION, PLACEMENT_EVENTS, START_RATING, rateContest, type Standing } from '../src/index.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

const N = 1000, DAYS = 60, PLAY = 0.6, NOISE = 200;
const r = rng(20261113);
const skill = Array.from({ length: N }, () => START_RATING + 250 * r.gauss());
const rating = new Array<number>(N).fill(START_RATING);
const events = new Array<number>(N).fill(0);

function ranks(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]!] === xs[idx[i]!]) j++;
    for (let k = i; k <= j; k++) out[idx[k]!] = (i + j) / 2;
    i = j + 1;
  }
  return out;
}
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a), rb = ranks(b), n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (ra[i]! - ma) * (rb[i]! - mb); va += (ra[i]! - ma) ** 2; vb += (rb[i]! - mb) ** 2; }
  return c / Math.sqrt(va * vb);
}
const estMean = () => {
  const e = rating.filter((_, i) => events[i]! >= PLACEMENT_EVENTS);
  return e.length ? e.reduce((s, x) => s + x, 0) / e.length : NaN;
};

// Fake farm: 50 low accounts sitting at the bottom of the same daily board as a strong player.
const FAKES = 50;
const farmer = { id: 'p-farmer', rating: 1500, events: 20 };
const fakeSets = {
  'established fakes @600': (): Standing[] => Array.from({ length: FAKES }, (_, i) => ({ id: `f${i}`, place: 0, rating: 600, events: 10 })),
  'placement fakes @1200': (): Standing[] => Array.from({ length: FAKES }, (_, i) => ({ id: `f${i}`, place: 0, rating: START_RATING, events: 0 })),
};
const farmGain: Record<string, number[]> = Object.fromEntries(Object.keys(fakeSets).map((k) => [k, []]));

let spearman30 = NaN, mean30 = NaN;
const mean0 = START_RATING;
for (let day = 1; day <= DAYS; day++) {
  const today = [];
  for (let i = 0; i < N; i++) if (r.next() < PLAY) today.push({ i, perf: skill[i]! + NOISE * r.gauss() });
  today.sort((a, b) => b.perf - a.perf);
  const standings: Standing[] = today.map((t, k) => ({ id: `p${String(t.i).padStart(4, '0')}`, place: k + 1, rating: rating[t.i]!, events: events[t.i]! }));

  // Farm check on the same state: the farmer is mid-table in today's board; fakes finish below everyone.
  const mid = Math.floor(standings.length / 4);
  const farmBoard = [...standings.slice(0, mid), { ...farmer, place: mid + 1 }, ...standings.slice(mid).map((s) => ({ ...s, place: s.place + 1 }))];
  const base = rateContest({ standings: farmBoard, weight: 1, algoVersion: ALGO_VERSION }).find((c) => c.id === farmer.id)!.delta;
  for (const [name, mk] of Object.entries(fakeSets)) {
    const fakes = mk().map((f, k) => ({ ...f, place: farmBoard.length + 1 + k }));
    const withFakes = rateContest({ standings: [...farmBoard, ...fakes], weight: 1, algoVersion: ALGO_VERSION }).find((c) => c.id === farmer.id)!.delta;
    farmGain[name]!.push(withFakes - base);
  }

  for (const c of rateContest({ standings, weight: 1, algoVersion: ALGO_VERSION })) {
    const i = Number(c.id.slice(1));
    rating[i] = c.rating;
    events[i]! += 1;
  }
  if (day === 30) {
    const seasoned = [...Array(N).keys()].filter((i) => events[i]! >= PLACEMENT_EVENTS);
    spearman30 = spearman(seasoned.map((i) => rating[i]!), seasoned.map((i) => skill[i]!));
    mean30 = estMean();
  }
}
const mean60 = estMean();
const drift = Math.abs(mean60 - mean30);
const out: Record<string, number | string> = {
  'spearman rating vs skill, day 30 (established)': +spearman30.toFixed(3),
  'established mean day 30': +mean30.toFixed(1),
  'established mean day 60': +mean60.toFixed(1),
  'drift day 30 to 60 (points)': +drift.toFixed(2),
  '(info) established mean minus START_RATING at day 60': +(mean60 - mean0).toFixed(2),
};
let farmOk = true;
for (const [k, v] of Object.entries(farmGain)) {
  const avg = v.reduce((s, x) => s + x, 0) / v.length;
  const late = v.slice(10);
  out[`farm: ${k}, mean extra points/day`] = +avg.toFixed(2);
  out[`farm: ${k}, mean extra points/day after day 10`] = +(late.reduce((s, x) => s + x, 0) / late.length).toFixed(2);
  out[`farm: ${k}, max extra points in a day`] = Math.max(...v);
  if (!(avg < 10)) farmOk = false;
}
console.log(JSON.stringify(out, null, 2));
const pass = spearman30 > 0.85 && drift < 5 && farmOk;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
