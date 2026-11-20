[![Token Radar bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Token Radar rank](https://make.fun/badge/token-radar-01/harrierme/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Token Radar reward](https://make.fun/badge/token-radar-01/harrierme/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar

A board of the DefiLlama protocols that record no token, ranked by what a token would be worth if their record stayed as it is. It covers all 40 protocols on the snapshot's watchlist, plus 161 more below the $50M floor that pass the same rule, for 201 rows. Each row carries a farm plan: six concrete steps with what they cost and how long they take.

## The value model

Implied value = TVL × 0.50 × (1 + 7-day change, clamped to −15% / +40%) × (1 + years listed, capped at 3, × 0.10).

A launch is priced near half the value the protocol already secures; the seven-day change bends it up or down, and the years it has run with no token add a little for a longer track record. The formula sees only TVL, growth and age — never a name. A protocol whose token already trades is never on the board, and neither are centralised exchanges, bridges, liquid staking or restaking products, wrapped or staked products, or versioned names: those are products of a token that already trades, not protocols waiting for one.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../../kits/token-radar-01-kit/token-radar-01-kit/input/snapshot.json
```

Node 22 or later, standard library only, no install. The program reads the sealed snapshot, writes `out/board.json`, `out/data.js`, copies `dashboard/` and `screenshots/` into `out/`, and writes `out/dossier.json` with the kit's dossier library. Run it twice and both runs write the same bytes.

Open `out/dashboard/index.html` to use the board: sortable, filterable by category and chain, searchable, with a detail view for each protocol showing its value breakdown and farm steps.

## Design notes

The page is a printed ledger on purpose: warm paper, ink type, one teal accent for value and one amber for warnings, figures in tabular numerals. No gradient wash, no glass, no decoration without a job to do.

---

Built for the [token-radar-01 bounty on make.fun](https://make.fun/bounty/token-radar-01?ref=efmrhagc).
