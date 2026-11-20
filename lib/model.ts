// Token Radar's valuation pipeline, second rewrite.
//
// The program turns one sealed snapshot into a ranked board. The pipeline
// has four stages, each a pure function of the snapshot's own figures:
//
//   1. classify  — every protocol is sorted into one bucket: the watchlist
//                  (the floor), the early radar (pre-token below the floor),
//                  the live set (a token already trades), or skipped.
//   2. value     — each ranked protocol gets an implied value from its TVL,
//                  its seven-day growth, how long it has run with no token
//                  on record, and how many chains it runs on. No name is
//                  ever special-cased; the same arithmetic scores every row.
//   3. plan      — each ranked protocol gets a six-step farm plan derived
//                  from its category, its chains, its TVL and its age.
//   4. assemble  — the board, the live set and the dashboard's dataset.
//
// Implied value, in the model's own words:
//
//   base     = tvlUsd x 0.30
//   growth   = clamp(change7d, -60, 120); factor = 1 + growth / 100 x 0.60
//   maturity = 0.55 + min(ageDays, 1095) / 1095 x 0.45
//              (ageDays is whole days since first listing; an unlisted age
//               counts as 365 days)
//   breadth  = 1 + min(chains, 8) x 0.02
//   implied  = max(1, round(base x growth x maturity x breadth))
//
// The dashboard recomputes every row with this same arithmetic and prints
// the breakdown, so the page, the board and the code agree with each other.

/** One protocol as the snapshot records it, fields renamed to camelCase. */
export interface ProtocolRecord {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvlUsd: number;
  change7d: number | null;
  mcapUsd: number | null;
  listedAt: string | null;
  geckoId: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface SnapshotDoc {
  asOf: string;
  source: string;
  floorUsd: number;
  protocols: ProtocolRecord[];
  watchlist: string[];
}

/** The model's constants, in the dashboard's own words. */
export interface ValuationParams {
  baseMultiple: number;
  growthWeight: number;
  growthLow: number;
  growthHigh: number;
  maturityBase: number;
  maturitySpan: number;
  maturityDays: number;
  unknownAgeDays: number;
  perChain: number;
  maxChains: number;
}

export const VALUATION: ValuationParams = {
  baseMultiple: 0.3,
  growthWeight: 0.6,
  growthLow: -60,
  growthHigh: 120,
  maturityBase: 0.55,
  maturitySpan: 0.45,
  maturityDays: 1095,
  unknownAgeDays: 365,
  perChain: 0.02,
  maxChains: 8,
};

/** The model tag the dashboard prints next to the formula. */
export const MODEL_TAG = 'radar-2';

/** How many pre-token protocols below the floor the early radar keeps. */
export const EARLY_CAP = 260;

/** How many live-token protocols the live view keeps, by market cap. */
export const LIVE_CAP = 24;

/** One row of board.json. Keys are spelled in the order the file prints. */
export interface BoardEntry {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    chain_count: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** One row as the dashboard's data file carries it; the farm plan is derived in the page. */
export interface PageRow {
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
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface DashboardData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: {
    base_multiple: number;
    growth_weight: number;
    growth_floor: number;
    growth_cap: number;
    maturity_floor: number;
    maturity_range: number;
    maturity_days: number;
    unknown_age_days: number;
    breadth_per_chain: number;
    breadth_max_chains: number;
  };
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  median_implied_usd: number;
  top_category: string;
  rows: PageRow[];
  live: LiveProtocol[];
}

/** Why a snapshot is not one this pipeline can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** `v` clamped into `lo..hi`. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `v` when it is a finite number, else `fallback`. */
function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Four decimal places, the precision the board prints the factors at. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** `YYYY-MM-DD` as a UTC midnight timestamp, or NaN when it is not a date. */
function utcMidnight(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when either date is missing or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = utcMidnight(asOf);
  const start = utcMidnight(listedAt);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  const span = Math.floor((end - start) / DAY_MS);
  return span < 0 ? 0 : span;
}

/** A protocol's valuation: its implied value and the factors behind it. */
export interface Valuation {
  implied: number;
  growthPct: number;
  growthFactor: number;
  maturityFactor: number;
  breadthFactor: number;
  ageDays: number | null;
}

/**
 * Value one protocol. The factors are folded in the order the formula
 * names them — base, then growth, then maturity, then breadth — so the
 * arithmetic is the model's own, whatever calls it.
 */
export function valueProtocol(
  rec: ProtocolRecord,
  asOf: string,
  params: ValuationParams = VALUATION,
): Valuation {
  const ageDays = ageInDays(asOf, rec.listedAt);
  const growthPct = clamp(finiteOr(rec.change7d, 0), params.growthLow, params.growthHigh);
  const growthFactor = 1 + (growthPct / 100) * params.growthWeight;
  const ageForModel = ageDays === null ? params.unknownAgeDays : ageDays;
  const maturityFactor =
    params.maturityBase + (clamp(ageForModel, 0, params.maturityDays) / params.maturityDays) * params.maturitySpan;
  const breadthFactor = 1 + Math.min(rec.chains.length, params.maxChains) * params.perChain;
  let value = rec.tvlUsd * params.baseMultiple;
  for (const factor of [growthFactor, maturityFactor, breadthFactor]) value *= factor;
  const implied = Math.max(1, Math.round(value));
  return { implied, growthPct, growthFactor, maturityFactor, breadthFactor, ageDays };
}

// ---------------------------------------------------------------- classify

/** Whether a protocol records a token at all. */
export function recordsToken(rec: ProtocolRecord): boolean {
  return rec.mcapUsd !== null || rec.geckoId !== null || rec.symbol !== null;
}

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
const VERSION_TAIL = /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product, not a launch of their own. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names a pre-token product may not begin with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * The exclusions, in the order the watchlist's own rule names them. A
 * protocol is rankable only when none of them fires: pre-token, in no
 * product category, with no version marker, no wrapped or staked word, and
 * not named after an exchange.
 */
function exclusionOf(rec: ProtocolRecord): string | null {
  if (recordsToken(rec)) return 'token';
  if (rec.category !== null && PRODUCT_CATEGORIES.has(rec.category)) return 'product-category';
  if (VERSION_TAIL.test(rec.name)) return 'versioned';
  const words = rec.name.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) return 'wrapped';
  for (const prefix of EXCHANGE_PREFIXES) {
    if (!rec.name.startsWith(prefix)) continue;
    const next = rec.name[prefix.length];
    if (next === undefined || !/[A-Za-z0-9_]/.test(next)) return 'exchange';
  }
  return null;
}

/** Whether a protocol may be ranked on the board. */
export function isRankable(rec: ProtocolRecord): boolean {
  return exclusionOf(rec) === null;
}

/** Slug order: the tie-break every ranking in this file shares. */
function bySlugAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The board's rows, ranked: the watchlist first, then the early radar by TVL, all scored and sorted. */
export function rankBoard(doc: SnapshotDoc, params: ValuationParams = VALUATION): BoardEntry[] {
  const bySlug = new Map(doc.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, ProtocolRecord>();
  for (const slug of doc.watchlist) {
    const found = bySlug.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // Early radar, strict only: pre-token protocols below the floor, by TVL.
  // No relaxed fill: a bridge, liquid-staking or wrapped product is a
  // product of a token that already trades, not a launch of its own, so it
  // never ranks here even when the strict pool is smaller than EARLY_CAP.
  const earlyPool = doc.protocols
    .filter((p) => !picked.has(p.slug) && isRankable(p) && p.tvlUsd < doc.floorUsd)
    .sort((a, b) => (b.tvlUsd !== a.tvlUsd ? b.tvlUsd - a.tvlUsd : bySlugAsc(a.slug, b.slug)));
  for (const p of earlyPool.slice(0, EARLY_CAP)) picked.set(p.slug, p);

  const valued = [...picked.values()].map((rec) => ({ rec, value: valueProtocol(rec, doc.asOf, params) }));
  valued.sort((a, b) =>
    b.value.implied !== a.value.implied
      ? b.value.implied - a.value.implied
      : bySlugAsc(a.rec.slug, b.rec.slug),
  );
  return valued.map((entry, i) => {
    const rec = entry.rec;
    const v = entry.value;
    return {
      rank: i + 1,
      slug: rec.slug,
      name: rec.name,
      category: rec.category,
      chains: rec.chains,
      tvl_usd: rec.tvlUsd,
      change_7d: rec.change7d,
      mcap_usd: rec.mcapUsd,
      listed_at: rec.listedAt,
      gecko_id: rec.geckoId,
      symbol: rec.symbol,
      token_status: 'pre-token' as const,
      age_days: v.ageDays,
      implied_value_usd: v.implied,
      model: {
        base_multiple: params.baseMultiple,
        growth_pct: v.growthPct,
        growth_multiplier: round4(v.growthFactor),
        maturity_multiplier: round4(v.maturityFactor),
        breadth_multiplier: round4(v.breadthFactor),
        chain_count: rec.chains.length,
        age_days: v.ageDays,
      },
      farm_steps: farmPlan(rec, v.ageDays),
    };
  });
}

// ---------------------------------------------------------------- farm plan

/** What a farm plan is built from: the protocol, its first chain, its capital and its hold. */
interface FarmContext {
  name: string;
  chain: string;
  capital: number;
  hold: number;
  gas: number;
}

/** Fill `{capital}`, `{name}`, `{chain}`, `{hold}` and `{gas}` in a template. Capital and gas carry their dollar sign. */
function fill(template: string, ctx: FarmContext): string {
  return template
    .replaceAll('{capital}', '$' + ctx.capital)
    .replaceAll('{name}', ctx.name)
    .replaceAll('{chain}', ctx.chain)
    .replaceAll('{hold}', String(ctx.hold))
    .replaceAll('{gas}', '$' + ctx.gas);
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(rec: ProtocolRecord): string {
  return rec.chains.length > 0 ? rec.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(rec: ProtocolRecord): number {
  if (rec.tvlUsd >= 5_000_000_000) return 250;
  if (rec.tvlUsd >= 1_000_000_000) return 150;
  if (rec.tvlUsd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDays(ageDays: number | null): number {
  if (ageDays === null) return 30;
  if (ageDays < 180) return 60;
  if (ageDays < 365) return 45;
  return 30;
}

/**
 * The category action, as a flat keyword table in first-match order. Each
 * keyword maps to one template; a category matches the first keyword it
 * contains, lowercased. The templates are the plan's own words, filled in
 * by `fill` with the protocol's name, chain and capital.
 */
const ACTION_TEMPLATES: Array<[keyword: string, template: string]> = [
  ['lend', 'Supply {capital} of USDC to {name} on {chain} and keep the position open so it counts in every snapshot.'],
  ['cdp', 'Supply {capital} of USDC to {name} on {chain} and keep the position open so it counts in every snapshot.'],
  ['collateral', 'Supply {capital} of USDC to {name} on {chain} and keep the position open so it counts in every snapshot.'],
  ['dex', "Provide {capital} of liquidity to {name}'s main pool on {chain} and keep the position open."],
  ['yield', "Provide {capital} of liquidity to {name}'s main pool on {chain} and keep the position open."],
  ['leveraged farm', "Provide {capital} of liquidity to {name}'s main pool on {chain} and keep the position open."],
  ['bridge', 'Bridge {capital} of USDC to {chain} through {name}, then use the bridged funds inside its app.'],
  ['staking', "Stake {capital} of the chain's staking asset through {name} and keep the receipt token."],
  ['restak', "Stake {capital} of the chain's staking asset through {name} and keep the receipt token."],
  ['perpetual', 'Deposit {capital} of USDC as margin on {name} and open one small hedged position.'],
  ['derivative', 'Deposit {capital} of USDC as margin on {name} and open one small hedged position.'],
  ['basis', 'Deposit {capital} of USDC as margin on {name} and open one small hedged position.'],
  ['prediction', 'Fund {capital} and place one market position on {name}, then settle it.'],
  ['curator', 'Deposit {capital} into a {name} vault on {chain} and keep the vault shares.'],
  ['allocator', 'Deposit {capital} into a {name} vault on {chain} and keep the vault shares.'],
  ['stable', 'Mint or deposit {capital} of the stable asset through {name} on {chain}.'],
  ['rwa', "Mint {capital} of the protocol's yield-bearing asset on {chain} and hold it."],
  ['insurance', 'Buy {capital} of cover from {name} on {chain} and keep the policy active.'],
  ['payment', 'Route {capital} of payments through {name} on {chain} and keep the receipts.'],
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(rec: ProtocolRecord, ctx: FarmContext): string {
  const lowered = (rec.category ?? '').toLowerCase();
  for (const [keyword, template] of ACTION_TEMPLATES) {
    if (lowered.includes(keyword)) return fill(template, ctx);
  }
  return fill('Deposit {capital} of USDC into {name} on {chain} and keep the position open.', ctx);
}

/** One step as a single string: its action, then its cost and time, within the gate's 20..600 characters. */
function joinStep(action: string, cost: string, time: string): string {
  const joined = action + ' Cost: ' + cost + '. Time: ' + time + '.';
  const clipped = joined.length > 600 ? joined.slice(0, 596) + '...' : joined;
  return clipped.length < 20 ? clipped + ' Hold the position and check the protocol\u0027s own page.' : clipped;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains,
 * TVL, age), never from a hand-written list.
 */
export function farmPlan(rec: ProtocolRecord, ageDays: number | null): string[] {
  const ctx: FarmContext = {
    name: rec.name,
    chain: firstChain(rec),
    capital: stakeSize(rec),
    hold: holdDays(ageDays),
    gas: 0,
  };
  ctx.gas = ctx.capital >= 150 ? 8 : 4;
  const action = actionFor(rec, ctx);
  const steps: Array<[action: string, cost: string, time: string]> = [
    [
      fill('Use a fresh wallet that holds only the {capital} you plan to farm, and keep its seed phrase offline on paper.', ctx),
      'under $3 of gas for the first transaction',
      '5 minutes',
    ],
    [action, fill('{capital} of capital and about {gas} of gas', ctx), '15 minutes to set up'],
    [
      fill('Do one qualifying action every week on {chain}, such as a deposit, a borrow, a swap or a vote, so the wallet stays active.', ctx),
      'about $2 of gas a week',
      '10 minutes a week',
    ],
    [
      fill('Hold the position for at least {hold} days so the activity is counted in more than one snapshot, not just one.', ctx),
      fill('the {capital} stays locked in the position', ctx),
      ctx.hold + ' days',
    ],
    [
      "Check the protocol's own points or rewards page weekly, and claim only from a link the protocol itself publishes.",
      'no fee to check, and never pay anyone to claim',
      '10 minutes a week',
    ],
    [
      'Write the wallet address, the dates and every transaction hash in a farm log so you can repeat the position or unwind it.',
      'nothing but the log',
      '5 minutes',
    ],
  ];
  return steps.map(([text, cost, time]) => joinStep(text, cost, time));
}

// ---------------------------------------------------------------- live set

/** The live-token protocols, by market cap, for the dashboard's live-token view. */
export function liveProtocols(doc: SnapshotDoc): LiveProtocol[] {
  const trading = doc.protocols.filter((p) => recordsToken(p) && p.category !== 'CEX');
  trading.sort((a, b) => {
    const capA = a.mcapUsd ?? 0;
    const capB = b.mcapUsd ?? 0;
    if (capB !== capA) return capB - capA;
    return b.tvlUsd - a.tvlUsd;
  });
  return trading.slice(0, LIVE_CAP).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvlUsd,
    mcap_usd: p.mcapUsd,
    change_7d: p.change7d,
  }));
}

// ---------------------------------------------------------------- assemble

/** A board row's compact form for data.js, with the farm plan derived in the page. */
function toPageRow(row: BoardEntry): PageRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** The tuning as the dashboard's data file carries it, keys in the order it prints. */
function paramsForOutput(p: ValuationParams): DashboardData['model'] {
  return {
    base_multiple: p.baseMultiple,
    growth_weight: p.growthWeight,
    growth_floor: p.growthLow,
    growth_cap: p.growthHigh,
    maturity_floor: p.maturityBase,
    maturity_range: p.maturitySpan,
    maturity_days: p.maturityDays,
    unknown_age_days: p.unknownAgeDays,
    breadth_per_chain: p.perChain,
    breadth_max_chains: p.maxChains,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(doc: SnapshotDoc, params: ValuationParams = VALUATION): { board: BoardEntry[]; data: DashboardData } {
  const board = rankBoard(doc, params);
  const live = liveProtocols(doc);
  const early = board.reduce((n, r) => n + (doc.watchlist.includes(r.slug) ? 0 : 1), 0);
  const values = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const median = values[values.length >> 1] ?? 0;
  const topCategory = board.reduce(
    (best, r) => {
      const key = r.category ?? 'Other';
      const count = (best.counts.get(key) ?? 0) + 1;
      best.counts.set(key, count);
      if (count > best.topCount) return { counts: best.counts, top: key, topCount: count };
      return best;
    },
    { counts: new Map<string, number>(), top: 'Other', topCount: -1 },
  ).top;
  const data: DashboardData = {
    as_of: doc.asOf,
    source: doc.source,
    floor_usd: doc.floorUsd,
    model: paramsForOutput(params),
    model_version: MODEL_TAG,
    watchlist_size: doc.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    median_implied_usd: median,
    top_category: topCategory,
    rows: board.map(toPageRow),
    live,
  };
  return { board, data };
}

// ---------------------------------------------------------------- parse

/** The snapshot out of a file's text, refused unless it is the shape the pipeline scores. */
export function readSnapshot(text: string): SnapshotDoc {
  const fail = (why: string): never => {
    throw new SnapshotError(why);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('snapshot.json is not a JSON object');
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    fail('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') fail('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    fail('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) fail('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    fail('snapshot.json has no watchlist of slugs');
  }
  const protocols = (doc.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail("snapshot.json's protocol " + i + ' is not an object');
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      fail("snapshot.json's protocol " + i + ' lacks a slug, a name or a TVL');
    }
    return {
      slug: p.slug as string,
      name: p.name as string,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? (p.chains as unknown[]).filter((c): c is string => typeof c === 'string') : [],
      tvlUsd: p.tvl_usd as number,
      change7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcapUsd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listedAt: typeof p.listed_at === 'string' ? p.listed_at : null,
      geckoId: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    asOf: doc.as_of as string,
    source: doc.source as string,
    floorUsd: doc.floor_usd as number,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

// ---------------------------------------------------------------- validate

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function checkBoard(board: BoardEntry[], doc: SnapshotDoc): string | null {
  const present = new Set(board.map((r) => r.slug));
  const absent = doc.watchlist.filter((s) => !present.has(s));
  if (absent.length > 0) {
    return 'the board misses ' + absent.length + ' watchlist slug' + (absent.length === 1 ? '' : 's') + ': ' + absent.slice(0, 5).join(', ');
  }
  if (board.length < 100 || board.length > 4000) return 'the board holds ' + board.length + ' rows, outside 100..4000';
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return 'rank ' + (i + 1) + ' is ' + ranks[i];
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return 'row ' + (i + 1) + ' outranks row ' + i + ' on implied value';
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'all ' + board.length + ' rows share the same implied value $' + board[0]!.implied_value_usd + ': a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return r.slug + ' has ' + r.farm_steps.length + ' farm steps';
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return r.slug + ' has a farm step of ' + len + ' characters';
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return r.slug + ' has implied value ' + r.implied_value_usd;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function pageScript(data: DashboardData): string {
  return 'window.RADAR=' + JSON.stringify(data) + ';\n';
}
