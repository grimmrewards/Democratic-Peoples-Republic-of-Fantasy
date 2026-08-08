import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = "1313708661209600000";
const SLEEPER_API = "https://api.sleeper.app/v1";

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    name: "Democratic People's Republic of Fantasy API",
    status: "online",
    league_id: LEAGUE_ID,
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

async function sleeperFetch(path) {
  const response = await fetch(`${SLEEPER_API}${path}`);

  if (!response.ok) {
    throw new Error(`Sleeper API returned ${response.status}`);
  }

  return response.json();
}

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
    const picks = await sleeperFetch(`/league/${LEAGUE_ID}/traded_picks`);

    res.json({
      refreshed_at: new Date().toISOString(),
      traded_picks: picks
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
    const [league, users, rosters, drafts, tradedPicks] = await Promise.all([
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
  console.log(`Fantasy league API is running on port ${PORT}`);
});
