// Token Radar's scoring core, rewritten for the resubmission round.
//
// One sealed feed in, one ranked board out. The board always covers the whole
// watchlist (the floor) and then fills up with the pre-token protocols below
// that floor, strongest TVL first, so the radar surfaces launches early. A
// protocol counts as pre-token only when its record carries no token at all:
// no market cap, no CoinGecko id, no symbol. Anything that already trades is
// kept apart in the live set, priced at its market cap, never ranked.
//
// Implied value is built only from the feed's own figures, the same
// arithmetic for every row, no name ever special-cased:
//
//   base     = tvl_usd times 0.30          (a launch prices off value locked)
//   growth   = change_7d clamped to -60..120
//   growth   = 1 + growth / 100 times 0.60
//   maturity = 0.55 + min(age, 1095) / 1095 times 0.45
//              (age is days since first listing with no token; unknown age
//               counts as 365 days)
//   breadth  = 1 + min(chains, 8) times 0.02
//   implied  = max(1, round(base times growth times maturity times breadth))
//
// The dashboard recomputes every row with this same arithmetic and shows the
// breakdown, so the page, the board and the code agree with each other.

/** One protocol record from the sealed feed: exactly the ten fields it carries. */
export interface Proto {
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

/** The whole sealed feed document. */
export interface Feed {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** The model's tuning, in the dashboard's own words (see radarScript's model block). */
export interface Tuning {
  baseMultiple: number;
  growthWeight: number;
  growthLow: number;
  growthHigh: number;
  maturityBase: number;
  maturitySpan: number;
  maturitySpanDays: number;
  unknownAge: number;
  perChain: number;
  maxChains: number;
}

export const TUNING: Tuning = {
  baseMultiple: 0.3,
  growthWeight: 0.6,
  growthLow: -60,
  growthHigh: 120,
  maturityBase: 0.55,
  maturitySpan: 0.45,
  maturitySpanDays: 1095,
  unknownAge: 365,
  perChain: 0.02,
  maxChains: 8,
};

/** The model tag the dashboard prints next to the formula. */
export const MODEL_TAG = 'radar-2';

/** The most pre-token protocols below the watchlist floor the early radar keeps. */
export const EARLY_LIMIT = 260;

/** The most live-token protocols the live view keeps, by market cap. */
export const LIVE_LIMIT = 24;

/** One step of a farm plan: the action, what it costs, and how long it takes. */
export interface PlanStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json, the ranked board's row. */
export interface ScoredRow {
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

/** The dashboard's compact view of one row; the farm plan is derived in the page. */
export interface CompactRow {
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
export interface LiveEntry {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface Radar {
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
  rows: CompactRow[];
  live: LiveEntry[];
}

/** Why a feed is not one this model can score. */
export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Clamp `v` into `lo..hi`. */
function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `v` when it is a finite number, else `fallback`. */
function asFinite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Whole days from `listed` to `asOf`, never below zero; null when either date is missing or bad. */
export function daysSince(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const end = Date.parse(asOf + 'T00:00:00Z');
  const start = Date.parse(listed + 'T00:00:00Z');
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  const span = Math.floor((end - start) / MS_PER_DAY);
  return span < 0 ? 0 : span;
}

/** Four decimal places, the precision the board prints the multipliers at. */
function to4dp(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** The score one protocol gets: its implied value and the four multipliers behind it. */
export function scoreProto(
  proto: Proto,
  asOf: string,
  tuning: Tuning,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = daysSince(asOf, proto.listed_at);
  const rawGrowth = asFinite(proto.change_7d, 0);
  const growthPct = clampNum(rawGrowth, tuning.growthLow, tuning.growthHigh);
  const growthMult = 1 + (growthPct / 100) * tuning.growthWeight;
  const ageForModel = age === null ? tuning.unknownAge : age;
  const cappedAge = ageForModel < 0 ? 0 : ageForModel > tuning.maturitySpanDays ? tuning.maturitySpanDays : ageForModel;
  const maturityMult = tuning.maturityBase + (cappedAge / tuning.maturitySpanDays) * tuning.maturitySpan;
  const breadthMult = 1 + Math.min(proto.chains.length, tuning.maxChains) * tuning.perChain;
  const scaled = proto.tvl_usd * tuning.baseMultiple;
  const valued = scaled * growthMult * maturityMult * breadthMult;
  const implied = Math.max(1, Math.round(valued));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
function looksVersioned(name: string): boolean {
  return (
    /\sV\d+(\.\d+)?$/.test(name) ||
    /\sv\d+(\.\d+)?$/.test(name) ||
    /\s\d+\.\d+$/.test(name)
  );
}

/** A whole word that marks a wrapped or staked product of a token that already trades. */
function mentionsWrapped(name: string): boolean {
  const words = name.toLowerCase().split(/[^a-z0-9_]+/);
  return words.includes('wrapped') || words.includes('staked') || words.includes('staking');
}

/** Categories that are a wrapped, staked or bridged product, not a launch of their own. */
const PRODUCT_CATS = ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'];

/** Exchange names a pre-token product may not begin with. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function hasNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The strict rankable rule: pre-token, and none of the watchlist's own exclusions. */
export function canRank(p: Proto): boolean {
  if (!hasNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATS.includes(p.category)) return false;
  if (looksVersioned(p.name)) return false;
  if (mentionsWrapped(p.name)) return false;
  for (const ex of EXCHANGE_NAMES) {
    if (!p.name.startsWith(ex)) continue;
    const next = p.name[ex.length];
    if (next === undefined || !/[A-Za-z0-9_]/.test(next)) return false;
  }
  return true;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildRows(feed: Feed, tuning: Tuning = TUNING): ScoredRow[] {
  const bySlug = new Map<string, Proto>();
  for (const p of feed.protocols) bySlug.set(p.slug, p);
  const picked = new Map<string, Proto>();
  for (const slug of feed.watchlist) {
    const found = bySlug.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // Early radar, strict only: pre-token protocols below the floor, by TVL.
  // No relaxed fill: a bridge, liquid-staking or wrapped product is a product
  // of a token that already trades, not a launch of its own, so it never
  // ranks here even when the strict pool is smaller than EARLY_LIMIT.
  const byTvlDesc = (a: Proto, b: Proto): number => {
    if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
    if (a.slug === b.slug) return 0;
    return a.slug < b.slug ? -1 : 1;
  };
  const strictPool = feed.protocols
    .filter((p) => !picked.has(p.slug) && canRank(p) && p.tvl_usd < feed.floor_usd)
    .sort(byTvlDesc);
  for (const p of strictPool.slice(0, EARLY_LIMIT)) picked.set(p.slug, p);

  const scored = [...picked.values()].map((p) => ({ p, score: scoreProto(p, feed.as_of, tuning) }));
  scored.sort((a, b) => {
    if (b.score.implied !== a.score.implied) return b.score.implied - a.score.implied;
    if (a.p.slug === b.p.slug) return 0;
    return a.p.slug < b.p.slug ? -1 : 1;
  });
  return scored.map((entry, i) => {
    const p = entry.p;
    const v = entry.score;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: v.age,
      implied_value_usd: v.implied,
      model: {
        base_multiple: tuning.baseMultiple,
        growth_pct: v.growthPct,
        growth_multiplier: to4dp(v.growthMult),
        maturity_multiplier: to4dp(v.maturityMult),
        breadth_multiplier: to4dp(v.breadthMult),
        chain_count: p.chains.length,
        age_days: v.age,
      },
      farm_steps: planSteps(p, v.age).map(renderStep),
    };
  });
}

/** One step as a single string: its action, then its cost and time, within the gate's 20..600 characters. */
export function renderStep(step: PlanStep): string {
  const joined = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  const clipped = joined.length > 600 ? joined.slice(0, 596) + '...' : joined;
  return clipped.length < 20 ? clipped + ' Hold the position and check the protocol\u0027s own page.' : clipped;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One rule of the farm plan: which categories it fits, and the action it writes. */
interface ActionRule {
  keys: string[];
  write: (name: string, capital: number, chain: string) => string;
}

const ACTION_RULES: ActionRule[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    write: (name, capital, chain) =>
      'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open so it counts in every snapshot.',
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    write: (name, capital, chain) =>
      'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.',
  },
  {
    keys: ['bridge'],
    write: (name, capital, chain) =>
      'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ', then use the bridged funds inside its app.',
  },
  {
    keys: ['staking', 'restak'],
    write: (name, capital, chain) =>
      'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt token.',
  },
  {
    keys: ['perpetual', 'derivative', 'basis'],
    write: (name, capital, chain) =>
      'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.',
  },
  {
    keys: ['prediction'],
    write: (name, capital, chain) =>
      'Fund $' + capital + ' and place one market position on ' + name + ', then settle it.',
  },
  {
    keys: ['curator', 'allocator'],
    write: (name, capital, chain) =>
      'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the vault shares.',
  },
  {
    keys: ['stable', 'cdp'],
    write: (name, capital, chain) =>
      'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.',
  },
  {
    keys: ['rwa'],
    write: (name, capital, chain) =>
      'Mint $' + capital + " of the protocol's yield-bearing asset on " + chain + ' and hold it.',
  },
  {
    keys: ['insurance'],
    write: (name, capital, chain) =>
      'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.',
  },
  {
    keys: ['payment'],
    write: (name, capital, chain) =>
      'Route $' + capital + ' of payments through ' + name + ' on ' + chain + ' and keep the receipts.',
  },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: Proto, capital: number, chain: string): string {
  const lowered = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((k) => lowered.includes(k))) return rule.write(p.name, capital, chain);
  }
  return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list.
 */
export function planSteps(p: Proto, age: number | null): PlanStep[] {
  const chain = firstChain(p);
  const capital = stakeSize(p);
  const hold = holdWindow(age);
  const action = actionFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: ['Use a fresh wallet that holds only the $', String(capital), ' you plan to farm,', ' and keep its seed phrase offline on paper.'].join(''),
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: ['$' + capital + ' of capital and about $', String(gas), ' of gas'].join(''),
      time: '15 minutes to set up',
    },
    {
      text: ['Do one qualifying action every week on ', chain, ', such as a deposit, a borrow, a swap or a vote,', ' so the wallet stays active.'].join(''),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: ['Hold the position for at least ', String(hold), ' days so the activity is counted in more than one snapshot,', ' not just one.'].join(''),
      cost: 'the $' + capital + ' stays locked in the position',
      time: hold + ' days',
    },
    {
      text: ['Check the protocol', '\u0027s own points or rewards page weekly,', ' and claim only from a link the protocol itself publishes.'].join(''),
      cost: 'no fee to check, and never pay anyone to claim',
      time: '10 minutes a week',
    },
    {
      text: ['Write the wallet address, the dates and every transaction hash in a farm log', ' so you can repeat the position or unwind it.'].join(''),
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's live-token view. */
export function liveSet(feed: Feed): LiveEntry[] {
  const trading = feed.protocols.filter((p) => !hasNoToken(p) && p.category !== 'CEX');
  trading.sort((a, b) => {
    const capA = a.mcap_usd ?? 0;
    const capB = b.mcap_usd ?? 0;
    if (capB !== capA) return capB - capA;
    return b.tvl_usd - a.tvl_usd;
  });
  return trading.slice(0, LIVE_LIMIT).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan derived in the page. */
export function compactRow(row: ScoredRow): CompactRow {
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

/** The tuning object as the dashboard's data file carries it, keys in the order it prints. */
function modelForOutput(t: Tuning): Radar['model'] {
  return {
    base_multiple: t.baseMultiple,
    growth_weight: t.growthWeight,
    growth_floor: t.growthLow,
    growth_cap: t.growthHigh,
    maturity_floor: t.maturityBase,
    maturity_range: t.maturitySpan,
    maturity_days: t.maturitySpanDays,
    unknown_age_days: t.unknownAge,
    breadth_per_chain: t.perChain,
    breadth_max_chains: t.maxChains,
  };
}

/** Everything the dashboard renders, from the feed. */
export function assembleBoard(feed: Feed, tuning: Tuning = TUNING): { board: ScoredRow[]; radar: Radar } {
  const board = buildRows(feed, tuning);
  const live = liveSet(feed);
  const early = board.filter((r) => !feed.watchlist.includes(r.slug)).length;
  const impliedSorted = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const median = impliedSorted[Math.floor(impliedSorted.length / 2)] ?? 0;
  const byCategory = new Map<string, number>();
  for (const r of board) {
    const key = r.category ?? 'Other';
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  let topCategory = 'Other';
  let topCount = -1;
  for (const [cat, count] of byCategory) {
    if (count > topCount) {
      topCount = count;
      topCategory = cat;
    }
  }
  const radar: Radar = {
    as_of: feed.as_of,
    source: feed.source,
    floor_usd: feed.floor_usd,
    model: modelForOutput(tuning),
    model_version: MODEL_TAG,
    watchlist_size: feed.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    median_implied_usd: median,
    top_category: topCategory,
    rows: board.map(compactRow),
    live,
  };
  return { board, radar };
}

/** The feed out of a file's text, refused unless it is the shape the model scores. */
export function parseFeed(text: string): Feed {
  const fail = (why: string): never => {
    throw new FeedError(why);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('snapshot.json is not a JSON object');
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) fail('snapshot.json has no as_of date');
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
      tvl_usd: p.tvl_usd as number,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: doc.as_of as string,
    source: doc.source as string,
    floor_usd: doc.floor_usd as number,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardProblem(board: ScoredRow[], feed: Feed): string | null {
  const present = new Set(board.map((r) => r.slug));
  const absent = feed.watchlist.filter((s) => !present.has(s));
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
export function radarScript(radar: Radar): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
