// Token Radar — value model (radar-2-peer).
//
// Written from the behavioral spec alone. Every number in the board follows
// from the snapshot's own figures: a protocol's TVL, its 7-day change, how
// long it has been tracked, how many chains it runs on, and the peer
// multiples computed live from the snapshot's live-token protocols.
//
// Implied value = TVL x peer multiple x growth multiplier
//                     x maturity multiplier x breadth multiplier.
//
// Peer multiple: the median FDV/TVL (mcap_usd / tvl_usd) of live-token
// protocols in the same category, used only when the category has at least
// 3 live peers; otherwise the global median over all live peers. The
// multiple is clamped into [0.05, 3.0].
// Growth multiplier: 1 + clamp(change_7d, -50, +150) / 100 * 0.35.
// Maturity multiplier: 0.85 when the listing date is unknown, else
// 0.7 + 0.3 * (1 - exp(-age_days / 365)).
// Breadth multiplier: 1 + 0.02 * min(chains - 1, 5).

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelBreakdown {
  peer_multiple: number;
  peer_count: number;
  peer_fallback: boolean;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_status: string;
  watchlist: boolean;
  model: ModelBreakdown;
  farm_steps: string[];
}

export interface PeerEntry {
  category: string;
  multiple: number;
  peer_count: number;
  fallback: boolean;
}

export interface PeerTable {
  global_multiple: number;
  global_peer_count: number;
  by_category: PeerEntry[];
}

export const MODEL_VERSION = 'radar-2-peer';

export const MODEL_CONSTANTS = {
  peer_min_peers: 3,
  peer_clamp_low: 0.05,
  peer_clamp_high: 3.0,
  growth_weight: 0.35,
  growth_clamp_low: -50,
  growth_clamp_high: 150,
  maturity_unknown: 0.85,
  maturity_base: 0.7,
  maturity_span: 0.3,
  maturity_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_extra: 5,
} as const;

// ---------------------------------------------------------------- helpers

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** A protocol "records a token" when any of gecko_id, symbol or mcap_usd is present. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

function parseDay(text: string): number {
  const parts = text.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from listed_at to as_of; null when the listing date is unknown. */
export function ageDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const diff = parseDay(asOf) - parseDay(listedAt);
  return Math.floor(diff / 86400000);
}

// ---------------------------------------------------------------- set-aside rules

const SET_ASIDE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_NAMES = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];

const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Why a pre-token protocol is set aside (never a board row), or null when it
 * is rankable. Rules are checked in order; the first match wins.
 */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && SET_ASIDE_CATEGORIES.has(p.category)) {
    if (p.category === 'CEX') return 'Centralized exchange';
    if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') {
      return 'Liquid staking product';
    }
    return 'Wrapped / bridged product';
  }
  if (p.category !== null && p.category.toLowerCase().includes('bridge')) {
    return 'Wrapped / bridged product';
  }
  if (WRAPPED_WORD.test(p.name)) return 'Wrapped / bridged product';
  if (VERSION_MARKER.test(p.name)) return 'Versioned release';
  for (const exchange of EXCHANGE_NAMES) {
    if (p.name.startsWith(exchange)) return 'Centralized exchange';
  }
  return null;
}

// ---------------------------------------------------------------- peer table

/**
 * Peer multiples from the snapshot's live-token protocols: for each category
 * with at least 3 live peers (mcap_usd and tvl_usd both above zero), the
 * median of mcap_usd / tvl_usd; the global median over all such peers is
 * the fallback. Multiples are clamped into [0.05, 3.0].
 */
export function computePeerTable(protocols: SnapshotProtocol[]): PeerTable {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (!recordsToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0) continue;
    if (p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category === null ? '(no category)' : p.category;
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const globalMultiple = clamp(median(all), MODEL_CONSTANTS.peer_clamp_low, MODEL_CONSTANTS.peer_clamp_high);
  const entries: PeerEntry[] = [];
  for (const [category, ratios] of byCategory) {
    if (ratios.length < MODEL_CONSTANTS.peer_min_peers) continue;
    entries.push({
      category,
      multiple: clamp(median(ratios), MODEL_CONSTANTS.peer_clamp_low, MODEL_CONSTANTS.peer_clamp_high),
      peer_count: ratios.length,
      fallback: false,
    });
  }
  entries.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { global_multiple: globalMultiple, global_peer_count: all.length, by_category: entries };
}

/** The peer multiple a category uses, with its peer count and fallback flag. */
export function peerForCategory(table: PeerTable, category: string | null): PeerEntry {
  const key = category === null ? '(no category)' : category;
  for (const entry of table.by_category) {
    if (entry.category === key) return entry;
  }
  return {
    category: key,
    multiple: table.global_multiple,
    peer_count: 0,
    fallback: true,
  };
}

// ---------------------------------------------------------------- scoring

export interface ScoredProtocol {
  protocol: SnapshotProtocol;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
}

/** Score one protocol from its own fields plus the peer table. */
export function scoreProtocol(
  p: SnapshotProtocol,
  table: PeerTable,
  asOf: string,
): ScoredProtocol {
  const peer = peerForCategory(table, p.category);
  const base = p.tvl_usd * peer.multiple;
  const growthPct = clamp(p.change_7d === null ? 0 : p.change_7d, MODEL_CONSTANTS.growth_clamp_low, MODEL_CONSTANTS.growth_clamp_high);
  const growthMultiplier = 1 + (growthPct / 100) * MODEL_CONSTANTS.growth_weight;
  const age = ageDays(p.listed_at, asOf);
  const maturityMultiplier =
    age === null
      ? MODEL_CONSTANTS.maturity_unknown
      : MODEL_CONSTANTS.maturity_base +
        MODEL_CONSTANTS.maturity_span * (1 - Math.exp(-age / MODEL_CONSTANTS.maturity_days));
  const extraChains = Math.max(0, Math.min(p.chains.length - 1, MODEL_CONSTANTS.breadth_max_extra));
  const breadthMultiplier = 1 + MODEL_CONSTANTS.breadth_per_chain * extraChains;
  const implied = Math.max(1, Math.round(base * growthMultiplier * maturityMultiplier * breadthMultiplier));
  return {
    protocol: p,
    age_days: age,
    implied_value_usd: implied,
    model: {
      peer_multiple: peer.multiple,
      peer_count: peer.peer_count,
      peer_fallback: peer.fallback,
      growth_pct: growthPct,
      growth_multiplier: growthMultiplier,
      maturity_multiplier: maturityMultiplier,
      breadth_multiplier: breadthMultiplier,
    },
  };
}

// ---------------------------------------------------------------- farm plans

const GAS_USD: Record<string, number> = {
  Ethereum: 4.0,
  Solana: 0.01,
  Base: 0.05,
  Arbitrum: 0.1,
  Optimism: 0.1,
  Binance: 0.15,
  Polygon: 0.02,
  Avalanche: 0.3,
  Sui: 0.02,
  Monad: 0.01,
  'Hyperliquid L1': 0.01,
  Berachain: 0.05,
  Sonic: 0.02,
  Sei: 0.01,
  Mantle: 0.05,
  Linea: 0.05,
  Scroll: 0.1,
  Blast: 0.05,
  Gnosis: 0.05,
  Fantom: 0.05,
  Tron: 0.5,
  Bitcoin: 2.0,
};

export function gasUsd(chain: string): number {
  const value = GAS_USD[chain];
  return value === undefined ? 0.5 : value;
}

function money(value: number): string {
  return '$' + value.toFixed(2);
}

interface CategoryVerbs {
  first: string;
  second: string;
  repeat: string;
}

const GENERIC_VERBS: CategoryVerbs = {
  first: 'Deposit into the protocol',
  second: 'Use a second feature of the protocol',
  repeat: 'use the protocol again',
};

const VERBS_BY_CATEGORY: Record<string, CategoryVerbs> = {
  Lending: {
    first: 'Supply an asset as collateral',
    second: 'Borrow a modest amount against that collateral',
    repeat: 'supply a little more collateral',
  },
  Dexs: {
    first: 'Swap a small amount through the exchange',
    second: 'Provide liquidity to one pool',
    repeat: 'add a little more liquidity to the same pool',
  },
  RWA: {
    first: 'Mint or buy the tokenized asset',
    second: 'Hold the tokenized asset inside the protocol',
    repeat: 'add a small amount to the same tokenized holding',
  },
  Yield: {
    first: 'Deposit into the yield vault',
    second: 'Deposit into a second vault or strategy',
    repeat: 'top up the same vault',
  },
  'Yield Aggregator': {
    first: 'Deposit into the yield vault',
    second: 'Deposit into a second vault or strategy',
    repeat: 'top up the same vault',
  },
  CDP: {
    first: 'Lock collateral in the protocol',
    second: "Mint the protocol's stable asset against that collateral",
    repeat: 'lock a little more collateral',
  },
  'Basis Trading': {
    first: 'Deposit into the basis vault',
    second: 'Add to a second basis position',
    repeat: 'top up the basis vault',
  },
  'Risk Curators': {
    first: 'Deposit into a curator vault',
    second: 'Allocate to a second curator vault',
    repeat: 'add to the same curator vault',
  },
  'Onchain Capital Allocator': {
    first: 'Deposit into a curator vault',
    second: 'Allocate to a second curator vault',
    repeat: 'add to the same curator vault',
  },
  Restaking: {
    first: 'Restake the asset',
    second: 'Use the receipt token in a second protocol action',
    repeat: 'restake a little more',
  },
  'Liquid Restaking': {
    first: 'Restake the asset',
    second: 'Use the receipt token in a second protocol action',
    repeat: 'restake a little more',
  },
  Chain: {
    first: 'Bridge a small amount to the chain',
    second: 'Use a native app on the chain',
    repeat: 'use the same native app again',
  },
  Payments: {
    first: 'Make a payment through the protocol',
    second: 'Set up a recurring payment',
    repeat: 'make another payment through the protocol',
  },
  Derivatives: {
    first: 'Open a small position',
    second: 'Open a second, different position',
    repeat: 'open another small position',
  },
  'Collateral Markets': {
    first: 'Deposit collateral',
    second: 'Open a managed position',
    repeat: 'add a little more collateral',
  },
  'CDP Manager': {
    first: 'Deposit collateral',
    second: 'Open a managed position',
    repeat: 'add a little more collateral',
  },
  'Staking Pool': {
    first: 'Stake the asset',
    second: 'Stake a second tranche',
    repeat: 'stake another small tranche',
  },
  'Stablecoin Wrapper': {
    first: 'Wrap the stablecoin',
    second: 'Use the wrapped asset in the protocol',
    repeat: 'wrap a little more of the stablecoin',
  },
  'Governance Incentives': {
    first: 'Lock or vote in governance',
    second: 'Vote in a second round',
    repeat: 'vote in the next round',
  },
  Insurance: {
    first: 'Buy cover for one position',
    second: 'Top up the cover',
    repeat: 'extend the cover',
  },
  Privacy: {
    first: 'Make a private transaction',
    second: 'Repeat it with a second asset',
    repeat: 'make another private transaction',
  },
  'Prediction Market': {
    first: 'Place a small prediction',
    second: 'Place a second prediction on a different market',
    repeat: 'place another small prediction',
  },
  Indexes: {
    first: 'Buy the index',
    second: 'Add a second index position',
    repeat: 'add a little more to the index',
  },
  Launchpad: {
    first: 'Join a launch allocation',
    second: 'Join a second launch allocation',
    repeat: 'join the next launch allocation',
  },
};

function verbsFor(category: string | null): CategoryVerbs {
  if (category === null) return GENERIC_VERBS;
  const verbs = VERBS_BY_CATEGORY[category];
  return verbs === undefined ? GENERIC_VERBS : verbs;
}

/**
 * The farm plan for one board row: 6 or 7 concrete steps, each naming what
 * it costs and how long it takes. Steps come from the protocol's category,
 * its primary chain and its age — never from its name. Nothing here promises
 * an airdrop, a token or a return.
 */
export function buildFarmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? (p.chains[0] as string) : 'Ethereum';
  const gas = money(gasUsd(chain));
  const capital = p.tvl_usd > 500000000 ? '$500–$2,000' : '$100–$500';
  const verbs = verbsFor(p.category);
  const hold = age !== null && age > 365 ? 'at least 60 days' : '30 to 90 days';
  const steps: string[] = [];
  steps.push(
    `Set up a wallet you control and move ${capital} onto ${chain}, the protocol's primary chain, keeping a little extra for gas at about ${gas} per transaction. Allow about 30 minutes for the transfer to confirm.`,
  );
  steps.push(
    `${verbs.first}, using part of your ${capital} allocation. Check that the position shows in the protocol's own interface, then note the date and the amount; allow about 20 minutes.`,
  );
  steps.push(
    `${verbs.second}, keeping this second position smaller than the first so one mistake cannot take the whole allocation. Confirm it the same way and allow about 20 minutes.`,
  );
  steps.push(
    `Repeat every week: ${verbs.repeat}, and compound any rewards back into the same position when the protocol lets you. Budget about ${gas} of gas per repeat and about 15 minutes each time.`,
  );
  steps.push(
    `Stay eligible: watch for points or quests if the protocol runs one, and track the protocol's own announcements for snapshot dates. Hold the position for ${hold}, and do not close it early on a rumour.`,
  );
  if (age === null || age < 180) {
    steps.push(
      `Add one low-cost touch: try the testnet, read the docs, or join a community quest or a governance forum discussion. It costs about $0 and takes 15 to 30 minutes, and it leaves a second trail of activity.`,
    );
  }
  steps.push(
    `Stay ready: keep the position open and funds at hand so you can act the day a token is announced, and do not bridge out early. Exit if the protocol announces no token, or if a dated snapshot passes with you outside it.`,
  );
  return steps;
}
