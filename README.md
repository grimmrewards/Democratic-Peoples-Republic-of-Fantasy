# Democratic-Peoples-Republic-of-Fantasy

Superflex PPR TE Premium Dynasty Fantasy Football League.

## Read-only API

- `GET /api/league`
- `GET /api/rosters`
- `GET /api/waivers?position=RB&limit=25`
- `GET /api/player-ratings`
- `GET /api/roster-optimizer`
- `GET /api/opportunities?position=RB&scope=purdy_and_available&limit=100`
- `GET /api/roster-values`
- `GET /api/trade-targets?position=RB&limit=25`
- `POST /api/trade-evaluator`
- `GET /api/live`

The waiver endpoint ranks the complete available QB/RB/WR/TE pool for DPRF,
compares each candidate with Purdy13Good (roster 2), identifies the displaced
player, and returns STV, LTV, trade value, tier, recommendation, FAAB range,
trend, and confidence. The same data is exposed through the read-only MCP tool
`get_waiver_wire_rankings`.

The league-wide ratings action now ranks rostered and available players in one
DPRF-normalized universe. Each player includes overall rank, position rank,
actionable label, evaluation date, confidence, trend, and the applied league
modifier. The append-only movement-log contract lives in `data/`; add an event
only when STV, LTV, or CTV changes, with prior/current values, reason, and source.

The Purdy13Good roster optimizer classifies every rostered player as keep, cut
now, hold through preseason, taxi, IR, or trade before cutting. It calculates
the active-roster overage, respects current reserve/taxi capacity and protected
players, and compares each player with the best available same-position option.
The same output is exposed through `get_roster_cut_optimizer`.

The depth-chart and injury-opportunity engine maps rostered and available
players to their listed starter, direct competition, replacement chain,
estimated role, injury-away path, and opportunity score. It emits alerts when a
starter injury creates an opportunity for Purdy13Good or an available player.
Passing-down/goal-line projections are explicitly marked as depth-chart
inferences when source-backed usage or role reporting is unavailable. The
source-gated intelligence store in `player-intelligence.js` supplies
verified injury episodes, weekly usage samples, and role reports. The engine
aggregates one-, three-, and five-year injury windows and automatically adjusts
opportunity scores when new valid records are added. Records without a source
URL and date are ignored. Verified RB coverage now includes the initial
Purdy13Good opportunity set plus Justice Hill, Devin Neal, LeQuint Allen, Nick
Chubb, DJ Giddens, Emari Demercado, and Ty Johnson. Injury coverage remains
explicitly partial rather than implying a complete medical history.
The dynamic refresh layer re-reads Sleeper injury and depth-chart fields on
every request. Source-backed reports decay from current to recent to stale,
stale reports stop changing scores, usage samples expire from scoring, and the
engine emits live injury and stale-intelligence review alerts.
The same output is exposed through `get_depth_chart_opportunities`.

The live roster-value calculator grades all 10 teams from an optimized DPRF
starting lineup, bench depth, total roster value, age, positional scarcity,
roster pressure, and 2027-2029 draft capital. It classifies each team as a
contender, rebuilder, or in transition; identifies positional needs and
surpluses; and exposes the results through `get_live_roster_values`.

The trade engine matches Purdy13Good's needs and surpluses against every
opponent's competitive window, positional construction, and roster pressure.
`get_automated_trade_targets` generates aggressive-value, fair, consolidation,
pick-based, and maximum-acceptable offers. `evaluate_dprf_trade` grades a
specific proposal for lineup improvement, STV, LTV, CTV, roster-space impact,
risk, upside, and opponent impact before returning accept, reject, or counter.
No player is automatically protected from trade analysis; Nico Collins and
David Montgomery may be included when the return justifies their value.

## Durable opportunity monitoring

GitHub Actions runs `opportunity-monitor.mjs` every six hours and can also be
started manually. The first run establishes a baseline. Later runs compare live
Sleeper-driven opportunity data with `opportunity-monitor-snapshot.json`, append
only meaningful changes to `opportunity-monitor-events.jsonl`, and commit the
new snapshot. Team, DPRF availability, injury, depth order, estimated role,
actionable label, new medium/high alerts, and opportunity-score moves of at
least five points qualify as meaningful. Ordinary unchanged checks are never
logged. Medium/high changes open a GitHub issue so repository notifications can
surface the alert without a manual ChatGPT query.
