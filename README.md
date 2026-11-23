[![token-radar-01](https://make.fun/badge/competition/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/rank/token-radar-01/b19bay/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/reward/token-radar-01/b19bay/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)

# Launch Radar — comps-fitted token launch radar

A dashboard that ranks pre-token protocols by the implied value of the token they may one day issue, and shows how to farm each one before or after it launches.

**Model (comps-1):** implied value = TVL x comps multiple x growth x tenure x token odds. The comps multiple is the median market-cap-to-TVL ratio of traded protocols in the same category; token odds are the peer share of the category that already records a token. Validated held-out and walk-forward — the measured errors are stated on the dashboard as measured.

**Coverage:** 289 pre-token protocols ranked on the board (all 40 on the watchlist), 53 pre-token protocols excluded with reasons, and a Live view listing the top 60 traded protocols by market cap — only 144 of the 416 traded protocols carry a market cap in the snapshot. All 758 protocols in the snapshot accounted for.

Run: `MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`. Node 22, standard library only.
