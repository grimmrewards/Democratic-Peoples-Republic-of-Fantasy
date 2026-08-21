import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = "1313708661209600000";
const USER_ROSTER_ID = 2;
const SLEEPER_API = "https://api.sleeper.app/v1";

app.use(express.json({ limit: "2mb" }));

async function sleeperFetch(path) {
  const response = await fetch(`${SLEEPER_API}${path}`);

  if (!response.ok) {
    throw new Error(`Sleeper API returned ${response.status}`);
  }

  return response.json();
}

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data)
      }
    ]
  };
}
const VALUE_TIERS = [
  { min: 95, tier: "Elite Cornerstone" },
  { min: 90, tier: "Elite Asset" },
  { min: 85, tier: "High-End Starter" },
  { min: 80, tier: "Strong Starter" },
  { min: 75, tier: "Quality Starter" },
  { min: 70, tier: "Weekly Contributor" },
  { min: 60, tier: "Flex or Developmental" },
  { min: 50, tier: "Bench Depth" },
  { min: 40, tier: "Deep Stash" },
  { min: 20, tier: "Very Limited Value" },
  { min: 0, tier: "Cut or Avoid" }
];

function clampRating(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getValueTier(rating) {
  return VALUE_TIERS.find((tier) => rating >= tier.min).tier;
}
function calculateCombinedTradeValue(stv, ltv, stvWeight = 0.6) {
  const ltvWeight = 1 - stvWeight;

  return clampRating(
    stv * stvWeight +
    ltv * ltvWeight
  );
}
function getAgeAdjustment(age, position, horizon) {
  if (!age) return 0;

  const primeAge = {
    QB: 29,
    RB: 24,
    WR: 26,
    TE: 27
  }[position] || 26;

  const yearsFromPrime = age - primeAge;

  if (horizon === "STV") {
    return yearsFromPrime <= 2
      ? Math.max(-10, yearsFromPrime * -2)
      : Math.max(-20, yearsFromPrime * -4);
  }

    return yearsFromPrime <= 0
    ? Math.min(10, yearsFromPrime * -2)
    : Math.max(-30, yearsFromPrime * -6);
}
function getExperienceAdjustment(yearsExp, horizon) {
  const experience = Number(yearsExp) || 0;

  if (horizon === "STV") {
    if (experience === 0) return -8;
    if (experience <= 2) return 2;
    if (experience <= 6) return 5;
    return 0;
  }

  if (experience === 0) return 8;
  if (experience <= 2) return 6;
  if (experience <= 5) return 2;
  return -5;
}
function getDepthChartAdjustment(depthChartOrder, position, horizon) {
  const order = Number(depthChartOrder);

  if (!Number.isFinite(order) || order <= 0) return 0;

  const positionWeight = position === "RB" ? 1.25 : 1;
  const baseAdjustment =
    order === 1 ? 10 :
    order === 2 ? 5 :
    order === 3 ? 1 :
    order <= 5 ? -4 :
    -8;

  return Math.round(
    baseAdjustment *
    positionWeight *
    (horizon === "STV" ? 1 : 0.6)
  );
}
function getInjuryAdjustment(injuryStatus, horizon) {
  if (!injuryStatus) return 0;

  const status = String(injuryStatus).toLowerCase();

  const baseAdjustment =
    status === "out" ? -12 :
    status === "doubtful" ? -8 :
    status === "questionable" ? -4 :
    status === "pup" ? -10 :
    status === "ir" ? -15 :
    0;

  return horizon === "STV"
    ? baseAdjustment
    : Math.round(baseAdjustment * 0.5);
}
function getPositionAdjustment(position, horizon) {
  const adjustments = {
    QB: { STV: 8, LTV: 10 },
    RB: { STV: 6, LTV: 2 },
    WR: { STV: 4, LTV: 6 },
    TE: { STV: 7, LTV: 8 }
  };

  return adjustments[position]?.[horizon] || 0;
}
function calculatePlayerRatings(player) {
  const baseRating = 50;

  const stv = clampRating(
    baseRating +
    getAgeAdjustment(player.age, player.position, "STV") +
    getExperienceAdjustment(player.years_exp, "STV") +
    getDepthChartAdjustment(
      player.depth_chart_order,
      player.position,
      "STV"
    ) +
    getInjuryAdjustment(player.injury_status, "STV") +
    getPositionAdjustment(player.position, "STV")
  );

  const ltv = clampRating(
    baseRating +
    getAgeAdjustment(player.age, player.position, "LTV") +
    getExperienceAdjustment(player.years_exp, "LTV") +
    getDepthChartAdjustment(
      player.depth_chart_order,
      player.position,
      "LTV"
    ) +
    getInjuryAdjustment(player.injury_status, "LTV") +
    getPositionAdjustment(player.position, "LTV")
  );

  const combinedTradeValue = calculateCombinedTradeValue(stv, ltv);

  return {
    short_term_value: stv,
    long_term_value: ltv,
    combined_trade_value: combinedTradeValue,
    value_tier: getValueTier(combinedTradeValue)
  };
}
function addPlayerRatings(player) {
  return {
    ...player,
    ...calculatePlayerRatings(player)
  };
}

const WAIVER_SCARCITY_BONUS = {
  QB: 5,
  RB: 3,
  WR: 0,
  TE: 4
};

function getWaiverTrend(player) {
  if (player.injury_status) return "down";

  const depthOrder = Number(player.depth_chart_order);
  if (depthOrder === 1 || depthOrder === 2 || Number(player.years_exp) === 0) {
    return "up";
  }

  return "steady";
}

function getWaiverConfidence(player) {
  const hasTeam = Boolean(player.team);
  const hasDepthChart = Number.isFinite(Number(player.depth_chart_order));

  if (hasTeam && hasDepthChart && !player.injury_status) return "high";
  if (hasTeam || hasDepthChart) return "medium";
  return "low";
}

function calculateWaiverScore(player) {
  const depthOrder = Number(player.depth_chart_order);
  const employmentAdjustment = player.team ? 0 : -25;
  const opportunityBonus =
    depthOrder === 1 ? 6 :
    depthOrder === 2 ? 3 :
    depthOrder === 3 ? 1 :
    0;

  return clampRating(
    player.short_term_value * 0.55 +
    player.long_term_value * 0.45 +
    (WAIVER_SCARCITY_BONUS[player.position] || 0) +
    opportunityBonus +
    employmentAdjustment
  );
}

function getWaiverRecommendation(valueGain) {
  if (valueGain >= 12) return { action: "add", label: "Top waiver priority" };
  if (valueGain >= 7) return { action: "add", label: "Immediate add" };
  if (valueGain >= 3) return { action: "consider", label: "Roster-dependent add" };
  if (valueGain >= 0) return { action: "watch", label: "Watch list" };
  return { action: "pass", label: "Below roster replacement" };
}

function getFaabRange(waiverScore, valueGain) {
  if (valueGain < 0) return { min_percent: 0, max_percent: 0 };

  const midpoint = Math.max(
    1,
    Math.min(30, Math.round((waiverScore - 55) * 0.5 + valueGain * 0.15))
  );

  return {
    min_percent: Math.max(0, midpoint - 3),
    max_percent: Math.min(40, midpoint + 3)
  };
}

function getRosterStatus(playerId, roster) {
  if ((roster.taxi || []).includes(playerId)) return "taxi";
  if ((roster.reserve || []).includes(playerId)) return "reserve";
  return "active";
}

function findDisplacedPlayer(candidate, rosterPlayers) {
  const droppablePlayers = rosterPlayers.filter(
    (player) => player.roster_status !== "taxi"
  );
  const samePosition = droppablePlayers.filter(
    (player) => player.position === candidate.position
  );
  const comparisonPool = samePosition.length > 0
    ? samePosition
    : droppablePlayers;

  return [...comparisonPool].sort(
    (a, b) =>
      a.combined_trade_value - b.combined_trade_value ||
      a.short_term_value - b.short_term_value
  )[0] || null;
}

async function getWaiverWireRankings({ position, limit = 50 } = {}) {
  const [availablePlayers, players, rosters] = await Promise.all([
    getAvailablePlayers(),
    sleeperFetch("/players/nfl"),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`)
  ]);

  const userRoster = rosters.find(
    (roster) => roster.roster_id === USER_ROSTER_ID
  );

  if (!userRoster) {
    throw new Error(`Roster ${USER_ROSTER_ID} was not found in league ${LEAGUE_ID}`);
  }

  const rosterPlayers = [...new Set(userRoster.players || [])]
    .map((playerId) => {
      const player = players[playerId];
      if (!player || !["QB", "RB", "WR", "TE"].includes(player.position)) {
        return null;
      }

      return addPlayerRatings({
        player_id: playerId,
        full_name: player.full_name,
        position: player.position,
        team: player.team,
        years_exp: Number(player.years_exp) || 0,
        age: player.age,
        depth_chart_position: player.depth_chart_position,
        depth_chart_order: player.depth_chart_order,
        injury_status: player.injury_status,
        roster_status: getRosterStatus(playerId, userRoster)
      });
    })
    .filter(Boolean);

  return availablePlayers
    .filter((player) => !position || player.position === position)
    .map((player) => {
      const waiverScore = calculateWaiverScore(player);
      const displacedPlayer = findDisplacedPlayer(player, rosterPlayers);
      const replacementValue = displacedPlayer?.combined_trade_value ?? 0;
      const valueGain = waiverScore - replacementValue;
      const recommendation = getWaiverRecommendation(valueGain);

      return {
        ...player,
        waiver_score: waiverScore,
        waiver_rank: null,
        recommendation: recommendation.action,
        label: recommendation.label,
        trend: getWaiverTrend(player),
        confidence: getWaiverConfidence(player),
        faab: getFaabRange(waiverScore, valueGain),
        roster_value_gain: valueGain,
        displaced_player: displacedPlayer
          ? {
              player_id: displacedPlayer.player_id,
              full_name: displacedPlayer.full_name,
              position: displacedPlayer.position,
              roster_status: displacedPlayer.roster_status,
              short_term_value: displacedPlayer.short_term_value,
              long_term_value: displacedPlayer.long_term_value,
              combined_trade_value: displacedPlayer.combined_trade_value,
              value_tier: displacedPlayer.value_tier
            }
          : null
      };
    })
    .sort(
      (a, b) =>
        b.waiver_score - a.waiver_score ||
        b.roster_value_gain - a.roster_value_gain ||
        a.full_name.localeCompare(b.full_name)
    )
    .slice(0, limit)
    .map((player, index) => ({
      ...player,
      waiver_rank: index + 1
    }));
}
async function getAvailablePlayers() {
  const [players, rosters] = await Promise.all([
    sleeperFetch("/players/nfl"),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`)
  ]);

  const rosteredPlayerIds = new Set(
    rosters.flatMap((roster) => [
      ...(roster.players || []),
      ...(roster.reserve || []),
      ...(roster.taxi || [])
    ])
  );

  return Object.entries(players)
    .filter(([playerId, player]) => {
      return (
        !rosteredPlayerIds.has(playerId) &&
        ["QB", "RB", "WR", "TE"].includes(player.position) &&
        player.active !== false
      );
    })
    .map(([playerId, player]) => {
      const yearsExp = Number(player.years_exp) || 0;

      return addPlayerRatings({
        player_id: playerId,
        full_name: player.full_name,
        position: player.position,
        team: player.team,
        experience_type: yearsExp === 0 ? "rookie" : "veteran",
        years_exp: yearsExp,
        age: player.age,
        depth_chart_position: player.depth_chart_position,
        depth_chart_order: player.depth_chart_order,
        injury_status: player.injury_status,
        status: player.status
      });
    })
    .sort((a, b) => {
      if (a.position !== b.position) {
        return a.position.localeCompare(b.position);
      }

      return (
        (a.depth_chart_order ?? 99) -
        (b.depth_chart_order ?? 99)
      );
    });
}
async function getAvailableVeterans() {
  const [players, rosters] = await Promise.all([
    sleeperFetch("/players/nfl"),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`)
  ]);

  const rosteredPlayerIds = new Set(
    rosters.flatMap((roster) => [
      ...(roster.players || []),
      ...(roster.reserve || []),
      ...(roster.taxi || [])
    ])
  );

  return Object.entries(players)
    .filter(([playerId, player]) => {
      return (
        !rosteredPlayerIds.has(playerId) &&
        Number(player.years_exp) > 0 &&
        ["QB", "RB", "WR", "TE"].includes(player.position) &&
        player.active !== false
      );
    })
    .map(([playerId, player]) => addPlayerRatings({
      player_id: playerId,
      full_name: player.full_name,
      position: player.position,
      team: player.team,
      depth_chart_position: player.depth_chart_position,
      depth_chart_order: player.depth_chart_order,
      injury_status: player.injury_status,
      age: player.age,
      years_exp: player.years_exp
    }))
    .sort((a, b) => {
      if (a.position !== b.position) {
        return a.position.localeCompare(b.position);
      }

      return (
        (a.depth_chart_order ?? 99) -
        (b.depth_chart_order ?? 99)
      );
    });
}
async function getLeaguePlayerRatings() {
  const [players, rosters, users] = await Promise.all([
    sleeperFetch("/players/nfl"),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
    sleeperFetch(`/league/${LEAGUE_ID}/users`)
  ]);

  const userMap = Object.fromEntries(
    users.map((user) => [
      user.user_id,
      {
        username: user.username,
        display_name: user.display_name,
        team_name: user.metadata?.team_name || user.display_name
      }
    ])
  );

  return rosters
    .flatMap((roster) => {
      const reserveIds = new Set(roster.reserve || []);
      const taxiIds = new Set(roster.taxi || []);

      return [...new Set(roster.players || [])]
        .map((playerId) => {
          const player = players[playerId];

          if (
            !player ||
            !["QB", "RB", "WR", "TE"].includes(player.position)
          ) {
            return null;
          }

          return addPlayerRatings({
            player_id: playerId,
            full_name: player.full_name,
            position: player.position,
            team: player.team,
            years_exp: Number(player.years_exp) || 0,
            age: player.age,
            depth_chart_position: player.depth_chart_position,
            depth_chart_order: player.depth_chart_order,
            injury_status: player.injury_status,
            roster_id: roster.roster_id,
            manager: userMap[roster.owner_id] || null,
            roster_status: taxiIds.has(playerId)
              ? "taxi"
              : reserveIds.has(playerId)
                ? "reserve"
                : "active"
          });
        })
        .filter(Boolean);
    })
    .sort(
      (a, b) =>
        b.combined_trade_value - a.combined_trade_value
    );
}
function createMcpServer() {
  const server = new McpServer(
    {
      name: "democratic-peoples-republic-of-fantasy",
      version: "1.1.0"
    },
    {
      instructions:
        "Use these read-only tools to retrieve live Sleeper data for the Democratic People's Republic of Fantasy dynasty league. Purdy13Good is the user's team."
    }
  );
    server.registerTool(
    "get_league_player_ratings",
    {
      title: "Get league-wide player ratings",
      description:
        "Returns every rostered QB, RB, WR, and TE with short-term value, long-term value, combined trade value, value tier, manager, and roster status.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () =>
      toolResult({
        refreshed_at: new Date().toISOString(),
        players: await getLeaguePlayerRatings()
      })
  );
  server.registerTool(
    "get_available_players",
    {
      description:
        "Returns every available rookie and veteran QB, RB, WR, and TE not currently rostered, reserved, or on a taxi squad.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await getAvailablePlayers(), null, 2)
        }
      ]
    })
  );

  server.registerTool(
    "get_waiver_wire_rankings",
    {
      title: "Get custom waiver-wire rankings",
      description:
        "Ranks available DPRF players, compares them with Purdy13Good's roster, identifies the displaced player, and recommends add, watch, or pass with FAAB guidance.",
      inputSchema: {
        position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
        limit: z.number().int().min(1).max(200).default(50)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ position, limit }) =>
      toolResult({
        refreshed_at: new Date().toISOString(),
        league_id: LEAGUE_ID,
        roster_id: USER_ROSTER_ID,
        methodology: {
          format: "10-team Superflex dynasty with TE premium",
          horizon_weights: { short_term: 0.55, long_term: 0.45 },
          position_scarcity_bonus: WAIVER_SCARCITY_BONUS,
          faab_unit: "percent_of_budget"
        },
        players: await getWaiverWireRankings({ position, limit })
      })
  );
  
  server.registerTool(
    "get_league_state",
    {
      title: "Get league state",
      description:
        "Get the league’s live settings, status, season and scoring configuration.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const league = await sleeperFetch(`/league/${LEAGUE_ID}`);

      return toolResult({
        refreshed_at: new Date().toISOString(),
        league
      });
    }
  );

  server.registerTool(
    "get_rosters",
    {
      title: "Get league rosters",
      description:
        "Get every current roster and match each roster to its manager and fantasy team name.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const [rosters, users] = await Promise.all([
        sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
        sleeperFetch(`/league/${LEAGUE_ID}/users`)
      ]);

      const userMap = Object.fromEntries(
        users.map((user) => [
          user.user_id,
          {
            username: user.username,
            display_name: user.display_name,
            team_name: user.metadata?.team_name || user.display_name
          }
        ])
      );

      const enrichedRosters = rosters.map((roster) => ({
        ...roster,
        manager: userMap[roster.owner_id] || null
      }));

      return toolResult({
        refreshed_at: new Date().toISOString(),
        rosters: enrichedRosters
      });
    }
  );

  server.registerTool(
    "get_draft_state",
    {
      title: "Get draft state",
      description:
        "Get all league drafts and every selection made in those drafts.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const drafts = await sleeperFetch(`/league/${LEAGUE_ID}/drafts`);

      const draftResults = await Promise.all(
        drafts.map(async (draft) => ({
          draft,
          picks: await sleeperFetch(`/draft/${draft.draft_id}/picks`)
        }))
      );

      return toolResult({
        refreshed_at: new Date().toISOString(),
        drafts: draftResults
      });
    }
  );

  server.registerTool(
    "get_traded_picks",
    {
      title: "Get traded draft picks",
      description:
        "Get all future draft picks that have been traded between teams.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const tradedPicks = await sleeperFetch(
        `/league/${LEAGUE_ID}/traded_picks`
      );

      return toolResult({
        refreshed_at: new Date().toISOString(),
        traded_picks: tradedPicks
      });
    }
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get league transactions",
      description:
        "Get trades, waiver claims, free-agent additions and drops for a specific NFL week.",
      inputSchema: {
        week: z
          .number()
          .int()
          .min(1)
          .max(18)
          .describe("NFL week number from 1 through 18")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ week }) => {
      const transactions = await sleeperFetch(
        `/league/${LEAGUE_ID}/transactions/${week}`
      );

      return toolResult({
        refreshed_at: new Date().toISOString(),
        week,
        transactions
      });
    }
  );

  server.registerTool(
    "get_live_league_data",
    {
      title: "Get complete live league data",
      description:
        "Get the current league, managers, rosters, drafts, draft selections and traded picks in one request.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => {
      const [league, users, rosters, drafts, tradedPicks] =
        await Promise.all([
          sleeperFetch(`/league/${LEAGUE_ID}`),
          sleeperFetch(`/league/${LEAGUE_ID}/users`),
          sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
          sleeperFetch(`/league/${LEAGUE_ID}/drafts`),
          sleeperFetch(`/league/${LEAGUE_ID}/traded_picks`)
        ]);

      const draftResults = await Promise.all(
        drafts.map(async (draft) => ({
          draft,
          picks: await sleeperFetch(`/draft/${draft.draft_id}/picks`)
        }))
      );

      return toolResult({
        refreshed_at: new Date().toISOString(),
        league,
        users,
        rosters,
        drafts: draftResults,
        traded_picks: tradedPicks
      });
    }
  );

  return server;
}

app.all("/mcp", async (req, res) => {
  const server = createMcpServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal MCP server error"
        },
        id: null
      });
    }
  }
});

app.get("/", (req, res) => {
  res.json({
    name: "Democratic People's Republic of Fantasy API",
    status: "online",
    league_id: LEAGUE_ID,
    mcp_endpoint: "/mcp",
    endpoints: [
      "/api/league",
      "/api/users",
      "/api/rosters",
      "/api/drafts",
      "/api/draft-picks",
      "/api/traded-picks",
      "/api/transactions/:week",
      "/api/waivers",
      "/api/live"
    ]
  });
});

app.get("/api/league", async (req, res) => {
  try {
    const league = await sleeperFetch(`/league/${LEAGUE_ID}`);

    res.json({
      refreshed_at: new Date().toISOString(),
      league
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const users = await sleeperFetch(`/league/${LEAGUE_ID}/users`);

    res.json({
      refreshed_at: new Date().toISOString(),
      users
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/rosters", async (req, res) => {
  try {
    const [rosters, users] = await Promise.all([
      sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
      sleeperFetch(`/league/${LEAGUE_ID}/users`)
    ]);

    const userMap = Object.fromEntries(
      users.map((user) => [
        user.user_id,
        {
          username: user.username,
          display_name: user.display_name,
          team_name: user.metadata?.team_name || user.display_name
        }
      ])
    );

    const enrichedRosters = rosters.map((roster) => ({
      ...roster,
      manager: userMap[roster.owner_id] || null
    }));

    res.json({
      refreshed_at: new Date().toISOString(),
      rosters: enrichedRosters
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/drafts", async (req, res) => {
  try {
    const drafts = await sleeperFetch(`/league/${LEAGUE_ID}/drafts`);

    res.json({
      refreshed_at: new Date().toISOString(),
      drafts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/draft-picks", async (req, res) => {
  try {
    const drafts = await sleeperFetch(`/league/${LEAGUE_ID}/drafts`);

    const draftResults = await Promise.all(
      drafts.map(async (draft) => ({
        draft,
        picks: await sleeperFetch(`/draft/${draft.draft_id}/picks`)
      }))
    );

    res.json({
      refreshed_at: new Date().toISOString(),
      drafts: draftResults
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/traded-picks", async (req, res) => {
  try {
    const tradedPicks = await sleeperFetch(
      `/league/${LEAGUE_ID}/traded_picks`
    );

    res.json({
      refreshed_at: new Date().toISOString(),
      traded_picks: tradedPicks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/transactions/:week", async (req, res) => {
  try {
    const week = Number(req.params.week);

    if (!Number.isInteger(week) || week < 1 || week > 18) {
      return res.status(400).json({
        error: "Week must be a whole number from 1 through 18."
      });
    }

    const transactions = await sleeperFetch(
      `/league/${LEAGUE_ID}/transactions/${week}`
    );

    res.json({
      refreshed_at: new Date().toISOString(),
      week,
      transactions
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/waivers", async (req, res) => {
  try {
    const position = req.query.position
      ? String(req.query.position).toUpperCase()
      : undefined;
    const limit = req.query.limit === undefined
      ? 50
      : Number(req.query.limit);

    if (position && !["QB", "RB", "WR", "TE"].includes(position)) {
      return res.status(400).json({
        error: "Position must be QB, RB, WR, or TE."
      });
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({
        error: "Limit must be a whole number from 1 through 200."
      });
    }

    res.json({
      refreshed_at: new Date().toISOString(),
      league_id: LEAGUE_ID,
      roster_id: USER_ROSTER_ID,
      methodology: {
        format: "10-team Superflex dynasty with TE premium",
        horizon_weights: { short_term: 0.55, long_term: 0.45 },
        position_scarcity_bonus: WAIVER_SCARCITY_BONUS,
        faab_unit: "percent_of_budget"
      },
      players: await getWaiverWireRankings({ position, limit })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/live", async (req, res) => {
  try {
    const [league, users, rosters, drafts, tradedPicks] =
      await Promise.all([
        sleeperFetch(`/league/${LEAGUE_ID}`),
        sleeperFetch(`/league/${LEAGUE_ID}/users`),
        sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
        sleeperFetch(`/league/${LEAGUE_ID}/drafts`),
        sleeperFetch(`/league/${LEAGUE_ID}/traded_picks`)
      ]);

    const draftResults = await Promise.all(
      drafts.map(async (draft) => ({
        draft,
        picks: await sleeperFetch(`/draft/${draft.draft_id}/picks`)
      }))
    );

    res.json({
      refreshed_at: new Date().toISOString(),
      league,
      users,
      rosters,
      drafts: draftResults,
      traded_picks: tradedPicks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Fantasy league API and MCP server running on port ${PORT}`);
});
