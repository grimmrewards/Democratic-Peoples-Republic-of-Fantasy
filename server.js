import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = "1313708661209600000";
const USER_ROSTER_ID = 2;
const SLEEPER_API = "https://api.sleeper.app/v1";
const EVALUATION_MODEL_VERSION = "dprf-ratings-v2";
const ROSTER_OPTIMIZER_VERSION = "dprf-roster-optimizer-v1";
const OPPORTUNITY_ENGINE_VERSION = "dprf-opportunity-engine-v1";
const USER_PROTECTED_PLAYERS = new Set(["Nico Collins", "David Montgomery"]);

const DPRF_SCORING_PROFILE = {
  teams: 10,
  superflex: true,
  passing_touchdown_points: 5,
  passing_yards_per_point: 25,
  completion_points: 0.1,
  points_per_carry: 0.1,
  reception_points: { QB: 0, RB: 0.5, WR: 1, TE: 1.5 },
  return_yard_points: 0,
  positional_scarcity: {
    QB: { STV: 10, LTV: 12, reason: "Superflex and five-point passing touchdowns" },
    RB: { STV: 8, LTV: 4, reason: "Two RB starters, two RB/WR flexes, and points per carry" },
    WR: { STV: 4, LTV: 6, reason: "Full PPR and up to six practical starting slots" },
    TE: { STV: 10, LTV: 11, reason: "1.5 PPR TE premium and three TE-eligible slots" }
  }
};

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
  return DPRF_SCORING_PROFILE.positional_scarcity[position]?.[horizon] || 0;
}

function getRatingTrend(player) {
  if (player.injury_status) return "down";
  const order = Number(player.depth_chart_order);
  if (order <= 2 || Number(player.years_exp) === 0) return "up";
  return "steady";
}

function getRatingConfidence(player) {
  const inputs = [
    Boolean(player.full_name),
    Boolean(player.position),
    Number.isFinite(Number(player.age)),
    Number.isFinite(Number(player.years_exp)),
    Boolean(player.team),
    Number.isFinite(Number(player.depth_chart_order))
  ];
  const score = Math.round(inputs.filter(Boolean).length / inputs.length * 100);
  return {
    score,
    level: score >= 85 ? "high" : score >= 60 ? "medium" : "low"
  };
}

function getActionableLabel(player, ratings) {
  const { short_term_value: stv, long_term_value: ltv, combined_trade_value: ctv } = ratings;
  if (!player.team && ctv < 45) return "Cut Candidate";
  if (ctv < 35) return "Cut Candidate";
  if (player.roster_status !== "available" && stv - ltv >= 12 && stv >= 60) {
    return "Trade Candidate";
  }
  if (ctv >= 90) return "Franchise Cornerstone";
  if (ctv >= 80) return "Core Starter";
  if (stv >= 70 && stv - ltv >= 8) return "Championship Piece";
  if (ltv >= 65 && ltv - stv >= 8) return "Upside Stash";
  if (ctv >= 60) return "Core Starter";
  if (ltv >= 55) return "Upside Stash";
  return player.roster_status === "available" ? "Waiver Watch" : "Roster Bubble";
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
  const ratings = calculatePlayerRatings(player);
  const confidence = getRatingConfidence(player);
  return {
    ...player,
    ...ratings,
    actionable_label: getActionableLabel(player, ratings),
    evaluation_date: new Date().toISOString().slice(0, 10),
    evaluation_model: EVALUATION_MODEL_VERSION,
    confidence_score: confidence.score,
    confidence: confidence.level,
    trend: getRatingTrend(player),
    league_modifier: {
      short_term: getPositionAdjustment(player.position, "STV"),
      long_term: getPositionAdjustment(player.position, "LTV"),
      reason: DPRF_SCORING_PROFILE.positional_scarcity[player.position]?.reason || null
    }
  };
}

const WAIVER_SCARCITY_BONUS = {
  QB: 5,
  RB: 3,
  WR: 0,
  TE: 4
};

function getWaiverTrend(player) {
  return getRatingTrend(player);
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

  const rosteredPlayers = rosters
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
  const rosteredIds = new Set(rosteredPlayers.map((player) => player.player_id));
  const availablePlayers = Object.entries(players)
    .filter(([playerId, player]) =>
      !rosteredIds.has(playerId) &&
      ["QB", "RB", "WR", "TE"].includes(player.position) &&
      player.active !== false
    )
    .map(([playerId, player]) => addPlayerRatings({
      player_id: playerId,
      full_name: player.full_name,
      position: player.position,
      team: player.team,
      years_exp: Number(player.years_exp) || 0,
      age: player.age,
      depth_chart_position: player.depth_chart_position,
      depth_chart_order: player.depth_chart_order,
      injury_status: player.injury_status,
      roster_id: null,
      manager: null,
      roster_status: "available"
    }));

  const rankedPlayers = [...rosteredPlayers, ...availablePlayers].sort(
    (a, b) =>
      b.combined_trade_value - a.combined_trade_value ||
      b.long_term_value - a.long_term_value ||
      a.full_name.localeCompare(b.full_name)
  );
  const positionRanks = {};

  return rankedPlayers.map((player, index) => {
    positionRanks[player.position] = (positionRanks[player.position] || 0) + 1;
    return {
      ...player,
      overall_rank: index + 1,
      position_rank: positionRanks[player.position]
    };
  });
}

function getActiveRosterLimit(league) {
  return (league.roster_positions || []).length;
}

function isReserveEligible(player, league) {
  const status = String(player.injury_status || "").toLowerCase();
  const settings = league.settings || {};
  return (
    ["ir", "pup", "na"].includes(status) ||
    (status === "out" && settings.reserve_allow_out === 1) ||
    (status === "doubtful" && settings.reserve_allow_doubtful === 1) ||
    (status === "suspended" && settings.reserve_allow_sus === 1)
  );
}

function getCutPriorityScore(player) {
  const scarcityProtection = { QB: 7, RB: 8, WR: 0, TE: 5 }[player.position] || 0;
  const roleProtection = Number(player.depth_chart_order) === 1
    ? 6
    : Number(player.depth_chart_order) === 2
      ? 3
      : 0;
  const preferenceProtection = USER_PROTECTED_PLAYERS.has(player.full_name) ? 100 : 0;
  return player.combined_trade_value + scarcityProtection + roleProtection + preferenceProtection;
}

function getRosterDecision(player, context) {
  const {
    requiredMoveIds,
    irMoveIds,
    taxiSlots,
    currentTaxiCount
  } = context;

  if (player.roster_status === "reserve" || irMoveIds.has(player.player_id)) {
    return {
      action: "IR",
      label: player.roster_status === "reserve" ? "Keep on IR/reserve" : "Move to IR/reserve",
      urgency: "immediate",
      reason: "Player is reserve-eligible and using this slot preserves an active roster spot."
    };
  }

  if (player.roster_status === "taxi") {
    return {
      action: "TAXI",
      label: "Keep on taxi squad",
      urgency: "hold",
      reason: "Player already occupies a valid developmental taxi slot."
    };
  }

  if (USER_PROTECTED_PLAYERS.has(player.full_name)) {
    return {
      action: "KEEP",
      label: "Protected keep",
      urgency: "hold",
      reason: "Current Purdy13Good strategy protects this player from cut or trade recommendations."
    };
  }

  if (requiredMoveIds.has(player.player_id)) {
    const depthOrder = Number(player.depth_chart_order);
    const veteranWithResidualMarket =
      Boolean(player.team) &&
      Number(player.years_exp) >= 5 &&
      player.combined_trade_value >= 25;
    const hasTradeValue =
      player.combined_trade_value >= 40 ||
      (player.team && depthOrder <= 2) ||
      player.short_term_value >= 50 ||
      veteranWithResidualMarket;
    const developmentalHold =
      Number(player.years_exp) <= 1 &&
      player.long_term_value >= 55;

    if (hasTradeValue) {
      return {
        action: "TRADE_BEFORE_CUT",
        label: "Trade before cutting",
        urgency: "before roster deadline",
        reason: "The player is inside the roster-reduction group but retains enough role or dynasty value to shop first."
      };
    }

    if (developmentalHold) {
      return {
        action: "HOLD_THROUGH_PRESEASON",
        label: "Hold through preseason",
        urgency: "reassess before final cuts",
        reason: "Young-player LTV justifies delaying the final cut decision while roles are still developing."
      };
    }

    return {
      action: "CUT_NOW",
      label: "Cut now",
      urgency: "immediate",
      reason: "The player is in the required roster-reduction group and lacks sufficient trade or developmental value."
    };
  }

  if (
    Number(player.years_exp) === 0 &&
    player.long_term_value >= 55 &&
    currentTaxiCount >= taxiSlots
  ) {
    return {
      action: "HOLD_THROUGH_PRESEASON",
      label: "Hold; taxi squad is full",
      urgency: "reassess before final cuts",
      reason: "The player is taxi-eligible, but all taxi slots are occupied; compare with the current taxi players later."
    };
  }

  return {
    action: "KEEP",
    label: "Keep",
    urgency: "hold",
    reason: "Player ranks above the current active-roster reduction line."
  };
}

function findBestAvailableReplacement(player, availablePlayers) {
  const samePosition = availablePlayers.filter(
    (candidate) => candidate.position === player.position && candidate.team
  );
  const replacement = samePosition[0] || null;
  if (!replacement) return null;
  return {
    player_id: replacement.player_id,
    full_name: replacement.full_name,
    position: replacement.position,
    team: replacement.team,
    overall_rank: replacement.overall_rank,
    position_rank: replacement.position_rank,
    short_term_value: replacement.short_term_value,
    long_term_value: replacement.long_term_value,
    combined_trade_value: replacement.combined_trade_value,
    actionable_label: replacement.actionable_label,
    value_gain: replacement.combined_trade_value - player.combined_trade_value
  };
}

async function getRosterCutOptimizer() {
  const [league, rosters, rankedPlayers] = await Promise.all([
    sleeperFetch(`/league/${LEAGUE_ID}`),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
    getLeaguePlayerRatings()
  ]);
  const userRoster = rosters.find((roster) => roster.roster_id === USER_ROSTER_ID);
  if (!userRoster) throw new Error(`Roster ${USER_ROSTER_ID} was not found.`);

  const rosterPlayers = rankedPlayers.filter((player) => player.roster_id === USER_ROSTER_ID);
  const availablePlayers = rankedPlayers.filter((player) => player.roster_status === "available");
  const activePlayers = rosterPlayers.filter((player) => player.roster_status === "active");
  const activeLimit = getActiveRosterLimit(league);
  const reserveSlots = Number(league.settings?.reserve_slots) || 0;
  const taxiSlots = Number(league.settings?.taxi_slots) || 0;
  const currentReserveCount = rosterPlayers.filter((player) => player.roster_status === "reserve").length;
  const currentTaxiCount = rosterPlayers.filter((player) => player.roster_status === "taxi").length;
  const openReserveSlots = Math.max(0, reserveSlots - currentReserveCount);

  const irCandidates = activePlayers
    .filter((player) => isReserveEligible(player, league))
    .sort((a, b) => b.combined_trade_value - a.combined_trade_value)
    .slice(0, openReserveSlots);
  const irMoveIds = new Set(irCandidates.map((player) => player.player_id));
  const activeAfterIr = activePlayers.filter((player) => !irMoveIds.has(player.player_id));
  const reductionsRequired = Math.max(0, activeAfterIr.length - activeLimit);
  const requiredMovePlayers = [...activeAfterIr]
    .sort((a, b) =>
      getCutPriorityScore(a) - getCutPriorityScore(b) ||
      a.combined_trade_value - b.combined_trade_value
    )
    .slice(0, reductionsRequired);
  const requiredMoveIds = new Set(requiredMovePlayers.map((player) => player.player_id));
  const context = { requiredMoveIds, irMoveIds, taxiSlots, currentTaxiCount };

  const decisions = rosterPlayers
    .map((player) => {
      const decision = getRosterDecision(player, context);
      const replacement = findBestAvailableReplacement(player, availablePlayers);
      return {
        player_id: player.player_id,
        full_name: player.full_name,
        position: player.position,
        team: player.team,
        roster_status: player.roster_status,
        short_term_value: player.short_term_value,
        long_term_value: player.long_term_value,
        combined_trade_value: player.combined_trade_value,
        overall_rank: player.overall_rank,
        position_rank: player.position_rank,
        actionable_label: player.actionable_label,
        trend: player.trend,
        confidence: player.confidence,
        decision: decision.action,
        decision_label: decision.label,
        urgency: decision.urgency,
        reason: decision.reason,
        required_to_clear_active_slot: requiredMoveIds.has(player.player_id),
        best_available_replacement: replacement
      };
    })
    .sort((a, b) => {
      const actionOrder = {
        CUT_NOW: 0,
        TRADE_BEFORE_CUT: 1,
        HOLD_THROUGH_PRESEASON: 2,
        IR: 3,
        TAXI: 4,
        KEEP: 5
      };
      return actionOrder[a.decision] - actionOrder[b.decision] ||
        a.combined_trade_value - b.combined_trade_value;
    });

  const decisionCounts = decisions.reduce((counts, player) => {
    counts[player.decision] = (counts[player.decision] || 0) + 1;
    return counts;
  }, {});

  return {
    generated_at: new Date().toISOString(),
    league_id: LEAGUE_ID,
    roster_id: USER_ROSTER_ID,
    model: ROSTER_OPTIMIZER_VERSION,
    roster_limits: {
      active_limit: activeLimit,
      current_active: activePlayers.length,
      reserve_slots: reserveSlots,
      current_reserve: currentReserveCount,
      taxi_slots: taxiSlots,
      current_taxi: currentTaxiCount,
      active_reductions_required: reductionsRequired,
      capacity_override: Boolean(league.settings?.capacity_override)
    },
    protected_players: [...USER_PROTECTED_PLAYERS],
    decision_counts: decisionCounts,
    players: decisions
  };
}

function getDepthGroupKey(player) {
  return `${player.team}:${player.depth_chart_position || player.position}`;
}

function isMeaningfullyInjured(player) {
  return ["out", "doubtful", "ir", "pup", "na"].includes(
    String(player.injury_status || "").toLowerCase()
  );
}

function getEstimatedRole(player) {
  const order = Number(player.depth_chart_order);
  const roleByPosition = {
    QB: {
      1: "Starting quarterback",
      2: "Direct quarterback replacement",
      3: "Developmental or emergency quarterback"
    },
    RB: {
      1: "Lead or primary committee running back",
      2: "Primary handcuff or committee running back",
      3: "Secondary handcuff or specialist running back"
    },
    WR: {
      1: "Starting receiver in listed alignment",
      2: "Direct alignment replacement or rotational receiver",
      3: "Developmental depth receiver"
    },
    TE: {
      1: "Starting tight end",
      2: "Direct tight-end replacement or rotational tight end",
      3: "Developmental depth tight end"
    }
  };
  return roleByPosition[player.position]?.[order] || "Depth-chart reserve";
}

function getOpportunityType(player) {
  const order = Number(player.depth_chart_order);
  if (order === 1) return "current_role";
  if (order === 2) {
    if (player.position === "RB") return "primary_handcuff_or_committee";
    if (player.position === "QB") return "direct_injury_replacement";
    return "direct_role_replacement";
  }
  if (order === 3) return "secondary_injury_replacement";
  return "multiple_events_away";
}

function getRoleConfidence(player) {
  const hasOrder = Number.isFinite(Number(player.depth_chart_order));
  const hasSpecificPosition = Boolean(player.depth_chart_position);
  if (player.team && hasOrder && hasSpecificPosition) return "medium";
  if (player.team && hasOrder) return "low";
  return "very_low";
}

function calculateOpportunityScore(player, starter) {
  const order = Number(player.depth_chart_order);
  const validOrder = Number.isFinite(order) && order > 0;
  const base = !validOrder ? 8 : order === 1 ? 82 : order === 2 ? 66 : order === 3 ? 46 : order <= 5 ? 28 : 12;
  const positionBonus = { QB: 5, RB: 8, WR: 2, TE: 5 }[player.position] || 0;
  const starterInjuryBonus = starter && starter.player_id !== player.player_id && isMeaningfullyInjured(starter)
    ? 20
    : 0;
  const ownInjuryPenalty = isMeaningfullyInjured(player) ? -25 : 0;
  const employmentPenalty = player.team ? 0 : -20;
  return clampRating(base + positionBonus + starterInjuryBonus + ownInjuryPenalty + employmentPenalty);
}

function compactOpportunityPlayer(player) {
  if (!player) return null;
  return {
    player_id: player.player_id,
    full_name: player.full_name,
    position: player.position,
    team: player.team,
    depth_chart_position: player.depth_chart_position,
    depth_chart_order: player.depth_chart_order,
    injury_status: player.injury_status,
    roster_id: player.roster_id,
    roster_status: player.roster_status,
    manager: player.manager,
    short_term_value: player.short_term_value,
    long_term_value: player.long_term_value,
    combined_trade_value: player.combined_trade_value
  };
}

async function getDepthChartOpportunityEngine({
  position,
  team,
  scope = "purdy_and_available",
  limit = 100
} = {}) {
  const rankedPlayers = await getLeaguePlayerRatings();
  const nflPlayers = rankedPlayers.filter((player) => player.team);
  const groups = new Map();
  for (const player of nflPlayers) {
    const key = getDepthGroupKey(player);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(player);
  }
  for (const group of groups.values()) {
    group.sort((a, b) =>
      (Number(a.depth_chart_order) || 99) - (Number(b.depth_chart_order) || 99) ||
      b.combined_trade_value - a.combined_trade_value
    );
  }

  const scopeFilter = (player) => {
    if (scope === "league") return true;
    if (scope === "purdy") return player.roster_id === USER_ROSTER_ID;
    if (scope === "available") return player.roster_status === "available";
    return player.roster_id === USER_ROSTER_ID || player.roster_status === "available";
  };

  const targetPlayers = rankedPlayers.filter(
    (player) => player.team || player.roster_id === USER_ROSTER_ID
  );
  const results = targetPlayers
    .filter(scopeFilter)
    .filter((player) => !position || player.position === position)
    .filter((player) => !team || player.team === team)
    .map((player) => {
      const group = groups.get(getDepthGroupKey(player)) || [];
      const playerIndex = group.findIndex((candidate) => candidate.player_id === player.player_id);
      const starter = group.find((candidate) => Number(candidate.depth_chart_order) === 1) || null;
      const playerAbove = playerIndex > 0 ? group[playerIndex - 1] : null;
      const directReplacement = playerIndex >= 0 ? group[playerIndex + 1] || null : null;
      const competition = group
        .filter((candidate) => candidate.player_id !== player.player_id)
        .slice(0, 4)
        .map(compactOpportunityPlayer);
      const opportunityScore = calculateOpportunityScore(player, starter);
      const starterInjured = starter && starter.player_id !== player.player_id && isMeaningfullyInjured(starter);

      return {
        ...compactOpportunityPlayer(player),
        overall_rank: player.overall_rank,
        position_rank: player.position_rank,
        actionable_label: player.actionable_label,
        trend: player.trend,
        confidence: player.confidence,
        estimated_role: getEstimatedRole(player),
        role_confidence: getRoleConfidence(player),
        opportunity_type: getOpportunityType(player),
        opportunity_score: opportunityScore,
        starter_injured: Boolean(starterInjured),
        starter: compactOpportunityPlayer(starter),
        player_directly_ahead: compactOpportunityPlayer(playerAbove),
        direct_replacement_if_player_is_out: compactOpportunityPlayer(directReplacement),
        depth_chart_competition: competition,
        injury_away_path: starterInjured
          ? "Current starter injury creates an immediate opportunity increase."
          : Number(player.depth_chart_order) === 2
            ? "One injury or role change away from the listed starting role."
            : Number(player.depth_chart_order) === 3
              ? "Usually two events away or requires a committee-role expansion."
              : Number(player.depth_chart_order) === 1
                ? "Currently holds the listed starting role."
                : "Requires multiple injuries, transactions, or a major role change.",
        role_projection: {
          direct_replacement: compactOpportunityPlayer(
            Number(player.depth_chart_order) === 1 ? directReplacement : player
          ),
          passing_down_replacement: player.position === "RB"
            ? compactOpportunityPlayer(directReplacement)
            : null,
          goal_line_replacement: player.position === "RB"
            ? compactOpportunityPlayer(directReplacement)
            : null,
          evidence_level: "depth_chart_inference_only"
        },
        injury_history: {
          one_year: null,
          three_year: null,
          five_year: null,
          coverage: "not_configured"
        },
        sourced_role_reports: [],
        reporting_coverage: "not_configured"
      };
    })
    .sort((a, b) =>
      b.starter_injured - a.starter_injured ||
      b.opportunity_score - a.opportunity_score ||
      b.combined_trade_value - a.combined_trade_value
    );

  const alerts = [];
  for (const group of groups.values()) {
    const starter = group.find((player) => Number(player.depth_chart_order) === 1);
    if (!starter || !isMeaningfullyInjured(starter)) continue;
    if (position && starter.position !== position) continue;
    if (team && starter.team !== team) continue;
    const replacement = group.find((player) =>
      player.player_id !== starter.player_id && !isMeaningfullyInjured(player)
    );
    if (!replacement) continue;
    const alertMatchesScope =
      scope === "league" ||
      (scope === "purdy" && (
        starter.roster_id === USER_ROSTER_ID || replacement.roster_id === USER_ROSTER_ID
      )) ||
      (scope === "available" && replacement.roster_status === "available") ||
      (scope === "purdy_and_available" && (
        starter.roster_id === USER_ROSTER_ID ||
        replacement.roster_id === USER_ROSTER_ID ||
        replacement.roster_status === "available"
      ));
    if (!alertMatchesScope) continue;
    alerts.push({
      alert_type: "starter_injury_opportunity",
      priority: replacement.roster_status === "available" ? "high" : "medium",
      starter: compactOpportunityPlayer(starter),
      opportunity_player: compactOpportunityPlayer(replacement),
      recommendation: replacement.roster_status === "available"
        ? "Review immediately as a waiver or free-agent target."
        : replacement.roster_id === USER_ROSTER_ID
          ? "Reassess Purdy13Good hold and lineup value."
          : "Monitor the depth-chart change."
    });
  }

  return {
    generated_at: new Date().toISOString(),
    league_id: LEAGUE_ID,
    roster_id: USER_ROSTER_ID,
    model: OPPORTUNITY_ENGINE_VERSION,
    filters: { position: position || null, team: team || null, scope, limit },
    methodology: {
      current_depth_chart_source: "Sleeper NFL player data",
      opportunity_method: "Depth-chart order, current injury designation, DPRF scarcity, and roster availability",
      role_inference_warning: "Passing-down and goal-line roles are provisional until sourced usage and reporting ingestion is configured.",
      injury_history_coverage: "not_configured",
      sourced_reporting_coverage: "not_configured"
    },
    alert_count: alerts.length,
    alerts,
    total_matching_players: results.length,
    players: results.slice(0, limit)
  };
}
function createMcpServer() {
  const server = new McpServer(
    {
      name: "democratic-peoples-republic-of-fantasy",
      version: "1.3.0"
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
        "Returns every rostered and available QB, RB, WR, and TE with DPRF-normalized STV, LTV, CTV, overall and position rank, actionable label, evaluation date, confidence, trend, manager, and roster status.",
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
        methodology: {
          model: EVALUATION_MODEL_VERSION,
          horizon_weights: { short_term: 0.6, long_term: 0.4 },
          scoring_profile: DPRF_SCORING_PROFILE,
          movement_log_policy: "Append only when a rating changes; never log unchanged ratings."
        },
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
    "get_roster_cut_optimizer",
    {
      title: "Optimize the Purdy13Good roster",
      description:
        "Classifies every Purdy13Good QB, RB, WR, and TE as keep, cut now, hold through preseason, taxi, IR, or trade before cutting; identifies required roster reductions and the best available replacement.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => toolResult(await getRosterCutOptimizer())
  );

  server.registerTool(
    "get_depth_chart_opportunities",
    {
      title: "Get depth-chart and injury opportunities",
      description:
        "Maps Purdy13Good and available players to current depth-chart competition, starter and replacement paths, estimated roles, injury-away opportunity, handcuff alerts, and evidence-coverage flags.",
      inputSchema: {
        position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
        team: z.string().trim().toUpperCase().min(2).max(3).optional(),
        scope: z.enum(["purdy_and_available", "purdy", "available", "league"])
          .default("purdy_and_available"),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ position, team, scope, limit }) =>
      toolResult(await getDepthChartOpportunityEngine({ position, team, scope, limit }))
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
      "/api/player-ratings",
      "/api/roster-optimizer",
      "/api/opportunities",
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

app.get("/api/player-ratings", async (req, res) => {
  try {
    const players = await getLeaguePlayerRatings();
    res.json({
      refreshed_at: new Date().toISOString(),
      league_id: LEAGUE_ID,
      methodology: {
        model: EVALUATION_MODEL_VERSION,
        horizon_weights: { short_term: 0.6, long_term: 0.4 },
        scoring_profile: DPRF_SCORING_PROFILE,
        movement_log_policy: "Append only when a rating changes; never log unchanged ratings."
      },
      counts: {
        total: players.length,
        rostered: players.filter((player) => player.roster_status !== "available").length,
        available: players.filter((player) => player.roster_status === "available").length
      },
      players
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/roster-optimizer", async (req, res) => {
  try {
    res.json(await getRosterCutOptimizer());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/opportunities", async (req, res) => {
  try {
    const position = req.query.position
      ? String(req.query.position).toUpperCase()
      : undefined;
    const team = req.query.team ? String(req.query.team).toUpperCase() : undefined;
    const scope = req.query.scope ? String(req.query.scope) : "purdy_and_available";
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (position && !["QB", "RB", "WR", "TE"].includes(position)) {
      return res.status(400).json({ error: "Position must be QB, RB, WR, or TE." });
    }
    if (!["purdy_and_available", "purdy", "available", "league"].includes(scope)) {
      return res.status(400).json({ error: "Invalid scope." });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: "Limit must be a whole number from 1 through 500." });
    }
    res.json(await getDepthChartOpportunityEngine({ position, team, scope, limit }));
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
