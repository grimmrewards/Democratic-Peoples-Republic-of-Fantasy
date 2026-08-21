# Democratic-Peoples-Republic-of-Fantasy

Superflex PPR TE Premium Dynasty Fantasy Football League.

## Read-only API

- `GET /api/league`
- `GET /api/rosters`
- `GET /api/waivers?position=RB&limit=25`
- `GET /api/live`

The waiver endpoint ranks the complete available QB/RB/WR/TE pool for DPRF,
compares each candidate with Purdy13Good (roster 2), identifies the displaced
player, and returns STV, LTV, trade value, tier, recommendation, FAAB range,
trend, and confidence. The same data is exposed through the read-only MCP tool
`get_waiver_wire_rankings`.
