---
purpose: Audit a predictive/betting/trading model for data leakage, overfitting, and unrealistic backtest assumptions
model-notes:
last-validated: 2026-07-08
---

Review this modeling pipeline as a skeptical quant. The question is not "is the code clean" but "would this model's backtest results survive contact with live data?" Hunt for the ways backtests lie:

1. **Temporal leakage** — Any feature computed using data from at or after prediction time: full-season aggregates applied to early-season games, closing lines/prices used to predict outcomes decided before close, stats windows that include the target event itself. Trace each feature to when its inputs actually become available.
2. **Train/test contamination** — Random splits on time-series data (must be chronological), scaling/normalization fit on the full dataset before splitting, target encoding computed over all rows, deduplication that leaks across the split.
3. **Survivorship & selection bias** — Backtest universe built from entities that exist *today*; filters applied using information not available at decision time.
4. **Execution realism** — Does the backtest assume odds/prices you could actually get? Check for: fills at closing line when the bet decision uses closing-line inputs, no vig/fees/slippage, unlimited liquidity, simultaneous bets exceeding realistic bankroll.
5. **Overfitting signals** — Hyperparameters tuned on the test set (even indirectly, via repeated evaluation), feature counts high relative to sample size, performance that degrades sharply on the most recent season/period.
6. **Metric honesty** — Is the headline metric the one that matters (ROI/CLV/calibration), or a proxy (accuracy) that flatters the model? Is variance reported, or just the mean?

For each finding: file:line, the leak/flaw, and a concrete estimate of the direction it biases results. End with the single change most likely to reveal the model's true performance.
