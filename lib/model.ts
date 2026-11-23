// Launch Radar's model: the sealed snapshot in, a ranked board out.
//
// The board ranks every pre-token protocol the radar can score (289 of the snapshot's 342
// pre-token protocols; the 53 left out are CEX rows and versioned pools, excluded by the same
// principle the snapshot's own watchlist rule uses, and listed with their reason). The 416
// protocols whose token already trades are set aside in the Live view at the market's own
// value, never mixed into the ranked board. Together the dashboard accounts for all 758.
//
// Implied value is comps-fitted: a protocol's TVL times the median market-cap-to-TVL multiple
// of traded protocols in its own category, times a growth factor, a tenure factor, and the
// peer odds that a protocol in its category ever records a token:
//
//   multiple   = median(mcap / TVL) over traded protocols in the category (n >= 4),
//                else the global median; clipped to [0.02, 3.0]
//   odds       = (traded in category + 2 x global token rate) / (all in category + 2)
//   growth     = 1 + 0.55 x clamp(change_7d, -50, 100) / 100
//   tenure     = 0.7 + 0.3 x min(age_days, 1460) / 1460   (age unknown: 365 days)
//   implied    = max(1, round(tvl_usd x multiple x growth x tenure x odds))
//
// The multiples and the odds are fitted from the snapshot itself, and the fit is tested the
// way the title says: held-out (a deterministic 70/30 split of traded protocols) and
// walk-forward (fit on earlier listings, test on later ones). The measured errors are stated
// on the dashboard as measured. No protocol name is ever special-cased.

import { createHash } from 'node:crypto';

/** One protocol entry, exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  min_category_n: number;
  multiple_floor: number;
  multiple_cap: number;
  odds_shrink: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  tenure_floor: number;
  tenure_range: number;
  tenure_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  min_category_n: 4,
  multiple_floor: 0.02,
  multiple_cap: 3.0,
  odds_shrink: 2,
  growth_weight: 0.55,
  growth_floor: -50,
  growth_cap: 100,
  tenure_floor: 0.7,
  tenure_range: 0.3,
  tenure_days: 1460,
  unknown_age_days: 365,
};

/** The model's version label, named on the dashboard. */
export const MODEL_VERSION = 'comps-1';

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_status: 'pre-token';
  watchlist: boolean;
  model: {
    comps_multiple: number;
    token_odds: number;
    growth_multiplier: number;
    tenure_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_odds: number;
  comps_multiple: number;
  growth_multiplier: number;
  tenure_multiplier: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A traded protocol for the Live view, at the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  multiple: number | null;
}

/** A pre-token protocol the board leaves out, with the reason stated. */
export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  reason: string;
}

/** One validation measurement, as the dashboard prints it. */
export interface ValidationStat {
  name: string;
  train_n: number;
  test_n: number;
  median_abs_log_error: number;
  within_2x: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  excluded_size: number;
  total_protocols: number;
  global_multiple: number;
  global_token_rate: number;
  validation: ValidationStat[];
  rows: RadarRow[];
  live: LiveRow[];
  excluded: ExcludedRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The median of a sorted array, or null when it holds nothing. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Why a pre-token protocol is left off the board, or null when it ranks. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'token already trades';
  if (p.category === 'CEX') return 'centralised exchange: no token launch to farm';
  if (VERSIONED.test(p.name)) return 'versioned pool of another protocol';
  return null;
}

/** Traded protocols with a usable market cap and TVL: the comps pool. */
function compsPool(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** The median mcap/TVL of a pool, or null when it holds nothing. */
function poolMedian(pool: SnapshotProtocol[]): number | null {
  const ratios = pool.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  return median(ratios);
}
/** The fitted comps multiples: one per category with enough traded peers, plus the global one. */
export interface FittedMultiples {
  byCategory: Map<string, number>;
  global: number;
}

/** Fit the multiples on a pool of traded protocols. */
export function fitMultiples(pool: SnapshotProtocol[], model: ModelConstants = MODEL): FittedMultiples {
  const global = poolMedian(pool);
  if (global === null) throw new SnapshotError('no traded protocol carries both a market cap and a TVL');
  const byCategory = new Map<string, number>();
  const cats = new Map<string, SnapshotProtocol[]>();
  for (const p of pool) {
    const key = p.category ?? '';
    const arr = cats.get(key) ?? [];
    arr.push(p);
    cats.set(key, arr);
  }
  for (const [cat, members] of cats) {
    if (members.length >= model.min_category_n) {
      const m = poolMedian(members);
      if (m !== null) byCategory.set(cat, m);
    }
  }
  return { byCategory, global };
}

/** A category's fitted multiple, clipped to the model's band. */
export function multipleFor(category: string | null, fitted: FittedMultiples, model: ModelConstants = MODEL): number {
  const raw = category !== null ? fitted.byCategory.get(category) : undefined;
  const m = raw ?? fitted.global;
  return Math.min(model.multiple_cap, Math.max(model.multiple_floor, m));
}

/** The peer token odds for a category: traded share, shrunk toward the global rate. */
export function tokenOddsFor(category: string | null, protocols: SnapshotProtocol[], model: ModelConstants = MODEL): number {
  const globalRate = protocols.filter((p) => !isPreToken(p)).length / protocols.length;
  if (category === null) return globalRate;
  const members = protocols.filter((p) => p.category === category);
  if (members.length === 0) return globalRate;
  const traded = members.filter((p) => !isPreToken(p)).length;
  return (traded + model.odds_shrink * globalRate) / (members.length + model.odds_shrink);
}

/** The four factors and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fitted: FittedMultiples,
  protocols: SnapshotProtocol[],
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; odds: number; growthMult: number; tenureMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const multiple = multipleFor(protocol.category, fitted, model);
  const odds = tokenOddsFor(protocol.category, protocols, model);
  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const tenureMult = model.tenure_floor + (Math.min(Math.max(ageForModel, 0), model.tenure_days) / model.tenure_days) * model.tenure_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * tenureMult * odds));
  return { implied, multiple, odds, growthMult, tenureMult, age };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} on ${chain} and keep the loan open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('allocator') || c.includes('curator')) return `Put $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('bridge')) return `Move $${capital} of USDC onto ${chain} through ${name} and use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one market position on ${name}.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy live.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${name}'s basis trade on ${chain} and hold the position.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Gas for one setup transaction, from the position's size. */
function setupGas(capital: number): number {
  return capital >= 150 ? 8 : 4;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time, netted at the end.
 * Every step derives from the protocol's own record (category, chains, TVL, age).
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = setupGas(capital);
  const weeklyGas = 2;
  const totalGas = gas + weeklyGas * Math.ceil(hold / 7);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `about $${weeklyGas} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Netted: $${capital} of capital plus about $${totalGas} of gas over ${hold} days. Unwind by reversing the deposit; the position stays yours.`,
      cost: `$${capital + totalGas} all in`,
      time: '5 minutes to log',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const fitted = fitMultiples(compsPool(snapshot.protocols));
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      multiple: p.tvl_usd > 0 ? round4(p.mcap_usd! / p.tvl_usd) : null,
    }))
    .slice(0, 60);
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const fitted = fitMultiples(compsPool(snapshot.protocols), model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fitted, snapshot.protocols, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    token_status: 'pre-token' as const,
    watchlist: snapshot.watchlist.includes(s.p.slug),
    model: {
      comps_multiple: round4(s.v.multiple),
      token_odds: round4(s.v.odds),
      growth_multiplier: round4(s.v.growthMult),
      tenure_multiplier: round4(s.v.tenureMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    token_odds: row.model.token_odds,
    comps_multiple: row.model.comps_multiple,
    growth_multiplier: row.model.growth_multiplier,
    tenure_multiplier: row.model.tenure_multiplier,
    watchlist: row.watchlist,
    farm_steps: row.farm_steps,
  };
}

/** The md5 bucket of a slug, 0..9: the deterministic held-out split. */
function slugBucket(slug: string): number {
  const hex = createHash('md5').update(slug).digest('hex');
  return parseInt(hex.slice(0, 8), 16) % 10;
}

/** The median absolute log error of predicting mcap as TVL x fitted multiple, over a test pool. */
function medianLogError(test: SnapshotProtocol[], fitted: FittedMultiples, model: ModelConstants): { median: number; within2x: number } {
  const errs = test.map((p) => Math.abs(Math.log((p.tvl_usd * multipleFor(p.category, fitted, model)) / p.mcap_usd!)));
  errs.sort((a, b) => a - b);
  const m = median(errs) ?? 0;
  return { median: round4(m), within2x: Math.round((errs.filter((e) => e < Math.log(2)).length / Math.max(1, errs.length)) * 100) / 100 };
}

/** The validation suite: held-out plus two walk-forward folds, all fitted from the snapshot. */
export function validateModel(snapshot: Snapshot, model: ModelConstants = MODEL): ValidationStat[] {
  const pool = compsPool(snapshot.protocols);
  const out: ValidationStat[] = [];
  const fit = pool.filter((p) => slugBucket(p.slug) < 7);
  const test = pool.filter((p) => slugBucket(p.slug) >= 7);
  const held = medianLogError(test, fitMultiples(fit, model), model);
  out.push({ name: 'held-out 70/30', train_n: fit.length, test_n: test.length, median_abs_log_error: held.median, within_2x: held.within2x });
  const dated = pool.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const third = Math.floor(dated.length / 3);
  const f1 = dated.slice(0, third);
  const f2 = dated.slice(third, 2 * third);
  const f3 = dated.slice(2 * third);
  const wf1 = medianLogError(f2, fitMultiples(f1, model), model);
  out.push({ name: 'walk-forward fold 1 to 2', train_n: f1.length, test_n: f2.length, median_abs_log_error: wf1.median, within_2x: wf1.within2x });
  const wf2 = medianLogError(f3, fitMultiples([...f1, ...f2], model), model);
  out.push({ name: 'walk-forward folds 1+2 to 3', train_n: f1.length + f2.length, test_n: f3.length, median_abs_log_error: wf2.median, within_2x: wf2.within2x });
  return out;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const fitted = fitMultiples(compsPool(snapshot.protocols), model);
  const excluded = snapshot.protocols
    .filter((p) => isPreToken(p) && !board.some((r) => r.slug === p.slug))
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, reason: exclusionReason(p) ?? 'not ranked' }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    excluded_size: excluded.length,
    total_protocols: snapshot.protocols.length,
    global_multiple: round4(fitted.global),
    global_token_rate: round4(snapshot.protocols.filter((p) => !isPreToken(p)).length / snapshot.protocols.length),
    validation: validateModel(snapshot, model),
    rows: board.map(radarRow),
    live,
    excluded,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
