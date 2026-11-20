# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/bingx12/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/bingx12/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast, for every trophy of Grand Theft Auto VI on PlayStation 5, the percent of the players Exophase tracks who will have earned it at 2026-11-26T00:00:00Z — a week after launch — as five quantiles (5/25/50/75/95%), scored by pinball loss on the logit scale.

## How it works

Exophase does not update its page continuously: it refreshes a game's counts on its own schedule, hours apart, and between refreshes the page is frozen. At a refresh the tracked count jumps (new players syncing their profiles) and every rate moves at once. The jump is mostly dilution — the newly tracked players started later, hold fewer trophies, and pull most rates down. On launch night the first refresh took tracked players 638 → 3,868 and every rate but the one at 100% fell, about 1.5 logit units on average. Against that, the players already tracked keep playing and earn more, which pushes rates up, especially the early story trophies over a week. A trophy's rate is a race between dilution (down, at refreshes) and progression (up, as the tracked cohort plays on).

`main.ts` reads that race off the case's own history, per trophy:

- It compresses the history to its distinct states (a read only counts when the tracked count or a rate changed, since the page is frozen between refreshes).
- With enough distinct states it fits each trophy's logit rate against time (least squares), shrinks the slope toward the cross-trophy median so noisy trophies do not run away, clamps it, and extrapolates it to the target with a damping that decays the trend over long horizons (a drift measured over days does not hold for a week).
- With a flat history (one distinct state, as on launch night) there is no trend to fit, so it uses the refresh prior: the page has been frozen for hours, a refresh is due inside the horizon, and when it lands the rates fall about 1.5 logit units — the size of the launch-night refresh. The drop is scaled by how overdue the refresh is.
- A trophy already at 100% stays there: everyone who plays holds it, and no refresh can take it away.

The quantiles are the median plus a logit spread that grows with the horizon (a random walk's square root), a base term for parameter uncertainty, a term for unmodelled refresh jumps, and a term for trend uncertainty proportional to the extrapolated move.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

That reads every `<id>.in` in `input/` and writes `<id>.out` to `out/`. Node 22+, standard library only, no dependencies, deterministic (no wall clock — every time comes from the case itself).

## Results

On the kit's practice cases (p00/p01, which straddle Exophase's first refresh of the game's counts), the model scores a pinball loss of about 0.10–0.14 against a refresh-shaped answer, versus about 1.51 for the house persistence baseline. On synthetic final-like cases (a 4.5-day horizon with a rich refresh history, both a persistent and a decaying drift), it scores about 0.25–0.29, beating persistence (0.35) in both.

---

<sub>Entered on [make.fun](https://make.fun/?ref=k6eq9xtw&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
