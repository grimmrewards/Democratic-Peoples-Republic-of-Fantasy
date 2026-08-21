# Democratic-Peoples-Republic-of-Fantasy

Superflex PPR TE Premium Dynasty Fantasy Football League.

## Read-only API

- `GET /api/league`
- `GET /api/rosters`
- `GET /api/waivers?position=RB&limit=25`
- `GET /api/player-ratings`
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
