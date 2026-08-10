import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = "1313708661209600000";
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

      return {
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
      };
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
    .map(([playerId, player]) => ({
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
function createMcpServer() {
  const server = new McpServer(
    {
      name: "democratic-peoples-republic-of-fantasy",
      version: "1.0.0"
    },
    {
      instructions:
        "Use these read-only tools to retrieve live Sleeper data for the Democratic People's Republic of Fantasy dynasty league. Purdy13Good is the user's team."
    }
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
    "get_available_veterans",
    {
      description:
        "Returns every available veteran QB, RB, WR, and TE not currently rostered, reserved, or on a taxi squad.",
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
          text: JSON.stringify(await getAvailableVeterans(), null, 2)
        }
      ]
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
