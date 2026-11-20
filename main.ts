// gta6-trophy-rarity-forecast-01: forecast, for every trophy of Grand Theft Auto VI on
// PlayStation 5, the percent of the players Exophase tracks who will have earned it at the
// case's target, as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95), scored by pinball loss
// on the logit scale.
//
// How the rates move, and what this program does about it.
//
// Exophase does not update its page continuously: it refreshes a game's counts on its own
// schedule, hours apart, and between refreshes the page is frozen. At a refresh the tracked
// count jumps (new players syncing their profiles) and every rate moves at once. The jump is
// mostly dilution: the newly tracked players started later, hold fewer trophies, and pull
// most rates down -- on launch night the first refresh took tracked players 638 -> 3,868 and
// every rate but the one at 100% fell, about 1.5 logit units on average. Against that, the
// players already tracked keep playing and earn more, which pushes rates up, especially the
// early story trophies over a week. So a trophy's rate is a race between dilution (down, at
// refreshes) and progression (up, as the tracked cohort plays on).
//
// This program reads the race off the case's own history, per trophy:
//   - It compresses the history to its distinct states (a read only counts when the tracked
//     count or a rate changed, since the page is frozen between refreshes).
//   - With enough distinct states it fits each trophy's logit rate against time (least
//     squares), shrinks the slope toward the cross-trophy median so noisy trophies do not
//     run away, clamps it, and extrapolates it to the target with a damping that decays
//     the trend over long horizons (a drift measured over days does not hold for a week).
//   - With a flat history (one distinct state, as on launch night) there is no trend to
//     fit, so it uses the refresh prior: the page has been frozen for hours, a refresh is
//     due inside the horizon, and when it lands the rates fall about 1.5 logit units --
//     the size of the launch-night refresh. The drop is scaled by how overdue the refresh
//     is (flat time plus horizon against a ~4h refresh interval).
//   - A trophy already at 100% stays there: everyone who plays holds it, and no refresh
//     can take it away.
// The quantiles are the median plus a logit spread that grows with the horizon (a random
// walk's sqrt), a base term for parameter uncertainty, a term for unmodelled refresh jumps,
// and a term for trend uncertainty proportional to the extrapolated move. The spread is
// what keeps the pinball loss low when the median is off: too narrow and every refresh
// lands outside the band, too wide and every quantile pays.
//
// It runs offline, with no network, under the case's time cap: everything it knows is in
// the case file. It never reads the wall clock (the two grading executions must match
// byte for byte); every time it uses comes from the case itself.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Logit drop expected at a refresh after a long flat spell (launch night: ~1.5). */
const FLAT_DROP = 1.5;
/** Flat time (hours) after which a refresh is treated as due. */
const FLAT_HOURS = 4;
/** Base spread, in logit units. */
const SIGMA0 = 0.4;
/** Spread growth per square-root day of horizon. */
const SIGMA_DAY = 0.5;
/** Extra spread for unmodelled refresh jumps, flat vs rich history. */
const JUMP_FLAT = 0.3;
const JUMP_RICH = 0.25;
/** Trend damping timescale (days): the drift decays over long horizons. */
const DAMP_TAU = 3;
/** Clamp on a trophy's fitted drift, logit per day. */
const SLOPE_CLAMP = 2.5;
/** Clamp on the flat-prior drop, logit units. */
const DROP_CLAMP = 2.5;
/** A rate at or above this is pinned: everyone who plays holds it. */
const PIN_RATE = 99.99;

interface Trophy {
  id: number;
  name: string;
  tier: string;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct);
  return Math.log(p / (100 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** One distinct state of the page: a read that changed something. */
interface State {
  tMs: number;
  tracked: number;
  rates: Array<number | null>;
}

function distinctStates(c: Case): State[] {
  const states: State[] = [];
  for (const r of c.history) {
    const s: State = { tMs: Date.parse(r.at), tracked: r.players_tracked, rates: r.rates };
    const prev = states[states.length - 1];
    if (prev === undefined) {
      states.push(s);
      continue;
    }
    if (s.tracked !== prev.tracked) {
      states.push(s);
      continue;
    }
    let changed = false;
    for (let i = 0; i < s.rates.length; i++) {
      if (s.rates[i] !== prev.rates[i]) {
        changed = true;
        break;
      }
    }
    if (changed) states.push(s);
  }
  return states;
}

/** Least-squares slope of y against x (days). Returns null with <2 points. */
function olsSlope(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (xs[k] - mx) * (ys[k] - my);
    den += (xs[k] - mx) * (xs[k] - mx);
  }
  if (den === 0) return null;
  return num / den;
}

function forecastCase(c: Case): { id: number; q: number[] }[] {
  const horizonDays = c.horizon_minutes / 1440;
  const horizonHours = c.horizon_minutes / 60;
  const atMs = Date.parse(c.at);
  const states = distinctStates(c);
  const last = states[states.length - 1];
  if (last === undefined) {
    // No history at all: fall back to a flat 1% with a wide spread rather than crash.
    return c.trophies.map((t) => ({ id: t.id, q: [0.1, 0.4, 1, 2.5, 6.3].map(round4) }));
  }
  const lastRates: Array<number | null> = last.rates;
  // Time of each distinct state, in days since the first one.
  const t0 = states[0].tMs;
  const tDays = states.map((s) => (s.tMs - t0) / 86_400_000);
  // Hours the page has been frozen at the checkpoint (since the last change).
  const flatHours = (atMs - last.tMs) / 3_600_000;
  const rich = states.length >= 4;

  // Per-trophy fitted drift (logit/day) where the history supports one.
  const slopes: Array<number | null> = c.trophies.map((_t, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < states.length; k++) {
      const r = states[k].rates[i];
      if (r === null || r === undefined) continue;
      xs.push(tDays[k]);
      ys.push(logit(r));
    }
    return olsSlope(xs, ys);
  });
  const haveSlope = slopes.filter((s): s is number => s !== null);
  const medSlope = haveSlope.length > 0 ? median(haveSlope) : 0;

  // Mean logit drop per observed refresh (for the sparse case).
  let obsDrop = 0;
  let obsCount = 0;
  for (let k = 1; k < states.length; k++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < c.trophies.length; i++) {
      const a = states[k - 1].rates[i];
      const b = states[k].rates[i];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      if (a >= PIN_RATE) continue;
      sum += logit(a) - logit(b);
      n++;
    }
    if (n > 0) {
      obsDrop += sum / n;
      obsCount++;
    }
  }
  const meanObsDrop = obsCount > 0 ? obsDrop / obsCount : FLAT_DROP;

  // The drift decays: a rate's move slows as the tracked population matures and
  // growth slows, so the extrapolated move is the integral of a decaying drift,
  // not the slope times the horizon. damp is that integral's share of the horizon.
  const damp = (DAMP_TAU * (1 - Math.exp(-horizonDays / DAMP_TAU))) / Math.max(horizonDays, 1e-9);
  // How due a refresh is: flat time plus horizon against the ~4h interval.
  const refreshDue = Math.min(1, Math.max(0, (flatHours + horizonHours) / FLAT_HOURS));

  return c.trophies.map((t, i) => {
    const rLast = lastRates[i];
    // A trophy everyone holds stays held.
    if (rLast !== null && rLast !== undefined && rLast >= PIN_RATE) {
      return { id: t.id, q: [99.99, 99.99, 100, 100, 100] };
    }
    // Last non-null rate, else a neutral 1%.
    let r = rLast;
    if (r === null || r === undefined) {
      for (let k = states.length - 1; k >= 0; k--) {
        const v = states[k].rates[i];
        if (v !== null && v !== undefined) {
          r = v;
          break;
        }
      }
    }
    if (r === null || r === undefined) r = 1;
    const lLast = logit(r);

    let lMed: number;
    let move = 0;
    if (rich) {
      // Trend from the history, shrunk toward the cross-trophy median and damped.
      const s = slopes[i];
      const w = 0.6;
      const bRaw = s === null ? medSlope : w * s + (1 - w) * medSlope;
      const b = Math.min(SLOPE_CLAMP, Math.max(-SLOPE_CLAMP, bRaw));
      move = b * horizonDays * damp;
      lMed = lLast + move;
    } else {
      // Flat or nearly flat history: a refresh is the move. Use the observed drop
      // when the history saw one, else the launch-night prior, scaled by how due
      // a refresh is inside the horizon.
      const drop = states.length >= 2 ? meanObsDrop : FLAT_DROP;
      const d = Math.min(DROP_CLAMP, Math.max(-1, drop)) * refreshDue;
      move = -d;
      lMed = lLast - d;
    }

    const sJump = rich ? JUMP_RICH : JUMP_FLAT;
    const sTrend = rich ? 0.3 * Math.abs(move) : 0;
    const spread = Math.sqrt(
      SIGMA0 * SIGMA0 +
        SIGMA_DAY * SIGMA_DAY * horizonDays +
        sJump * sJump +
        sTrend * sTrend,
    );
    const q = Z.map((z) => round4(clampPct(invLogit(lMed + z * spread))));
    // Keep the row non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
