import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import PLAYER_INTELLIGENCE from "./player-intelligence.js";

const app = express();
const PORT = process.env.PORT || 3000;

const LEAGUE_ID = "1313708661209600000";
const USER_ROSTER_ID = 2;
const SLEEPER_API = "https://api.sleeper.app/v1";
const EVALUATION_MODEL_VERSION = "dprf-ratings-v2";
const ROSTER_OPTIMIZER_VERSION = "dprf-roster-optimizer-v1";
const OPPORTUNITY_ENGINE_VERSION = "dprf-opportunity-engine-v1.3";
const ROSTER_VALUE_MODEL_VERSION = "dprf-roster-value-v1";
const TRADE_ENGINE_VERSION = "dprf-trade-engine-v1";
const MANAGER_TENDENCY_MODEL_VERSION = "dprf-manager-tendencies-v1";
const WEEKLY_PROJECTION_MODEL_VERSION = "dprf-weekly-projection-v1";
const USER_PROTECTED_PLAYERS = new Set();

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

async function sleeperProjectionFetch(season, week) {
  const response = await fetch(
    `https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular`
  );
  if (!response.ok) throw new Error(`Sleeper projections API returned ${response.status}`);
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

function hasLiveInjuryDesignation(player) {
  return Boolean(String(player.injury_status || "").trim());
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

function getVerifiedPlayerIntelligence(playerId) {
  const record = PLAYER_INTELLIGENCE.players[playerId] || {
    injury_episodes: [],
    usage_samples: [],
    role_reports: []
  };
  const hasSource = (item) =>
    Boolean(item.source_name) && /^https:\/\//.test(String(item.source_url || ""));
  return {
    injury_episodes: (record.injury_episodes || []).filter((item) =>
      hasSource(item) && item.start_date && item.source_published_at
    ),
    usage_samples: (record.usage_samples || []).filter((item) =>
      hasSource(item) && item.recorded_at
    ),
    role_reports: (record.role_reports || []).filter((item) =>
      hasSource(item) && item.published_at && item.summary
    )
  };
}

function ageInDays(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
}

function getFreshness(value, { currentDays = 14, recentDays = 45 } = {}) {
  const ageDays = ageInDays(value);
  if (ageDays === null) return { age_days: null, freshness: "unknown", active_for_scoring: false };
  if (ageDays <= currentDays) return { age_days: ageDays, freshness: "current", active_for_scoring: true };
  if (ageDays <= recentDays) return { age_days: ageDays, freshness: "recent", active_for_scoring: true };
  return { age_days: ageDays, freshness: "stale", active_for_scoring: false };
}

function decorateRoleReports(reports) {
  return reports.map((report) => ({ ...report, ...getFreshness(report.published_at) }));
}

function getIntelligenceRefreshStatus(intelligence) {
  const reports = decorateRoleReports(intelligence.role_reports);
  const latestReport = [...reports].sort((a, b) =>
    new Date(b.published_at) - new Date(a.published_at)
  )[0] || null;
  const latestUsage = [...intelligence.usage_samples].sort((a, b) =>
    new Date(b.recorded_at) - new Date(a.recorded_at)
  )[0] || null;
  return {
    evaluated_at: new Date().toISOString(),
    latest_report_at: latestReport?.published_at || null,
    report_freshness: latestReport?.freshness || "no_verified_report",
    report_age_days: latestReport?.age_days ?? null,
    latest_usage_at: latestUsage?.recorded_at || null,
    usage_freshness: latestUsage
      ? getFreshness(latestUsage.recorded_at, { currentDays: 8, recentDays: 28 }).freshness
      : "no_verified_usage",
    refresh_needed: Boolean(latestReport?.freshness === "stale")
  };
}

function summarizeInjuryWindow(episodes, years) {
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const matching = episodes.filter((episode) => new Date(episode.start_date) >= cutoff);
  return {
    window_years: years,
    verified_injuries: matching.length,
    known_games_missed: matching.reduce(
      (sum, episode) => sum + (Number(episode.games_missed) || 0),
      0
    ),
    major_injuries: matching.filter((episode) => episode.severity === "major").length,
    episodes: matching
  };
}

function summarizeUsage(samples) {
  const latest = [...samples]
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))
    .slice(0, 6);
  const average = (field) => {
    const values = latest
      .map((sample) => sample[field])
      .filter((value) => Number.isFinite(Number(value)));
    if (!values.length) return null;
    return Math.round(values.reduce((sum, value) => sum + Number(value), 0) / values.length * 100) / 100;
  };
  return {
    coverage: latest.length ? "verified_samples" : "no_verified_samples",
    sample_count: latest.length,
    latest_samples: latest,
    rolling_six: {
      average_snap_share: average("snap_share"),
      average_route_participation: average("route_participation"),
      average_targets: average("targets"),
      average_carries: average("carries"),
      average_goal_line_carries: average("goal_line_carries"),
      average_third_down_snaps: average("third_down_snaps")
    }
  };
}

function getRoleTags(playerId) {
  return [...new Set(
    decorateRoleReports(getVerifiedPlayerIntelligence(playerId).role_reports)
      .filter((report) => report.freshness !== "stale" || report.role_tags?.includes("unsigned"))
      .flatMap((report) => report.role_tags || [])
  )];
}

function findTaggedRolePlayer(group, tag) {
  return group
    .filter((player) => getRoleTags(player.player_id).includes(tag))
    .sort((a, b) =>
      (Number(a.depth_chart_order) || 99) - (Number(b.depth_chart_order) || 99)
    )[0] || null;
}

function getIntelligenceAdjustment(intelligence) {
  const activeReports = decorateRoleReports(intelligence.role_reports)
    .filter((report) => report.active_for_scoring);
  const reportAdjustment = activeReports.reduce((sum, report) => {
    const weight = report.freshness === "current" ? 3 : 1;
    return sum + (report.signal === "positive" ? weight : report.signal === "negative" ? -weight : 0);
  }, 0);
  const latestUsage = [...intelligence.usage_samples]
    .sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at))[0];
  const usageFreshness = latestUsage
    ? getFreshness(latestUsage.recorded_at, { currentDays: 8, recentDays: 28 })
    : null;
  const usageAdjustment = latestUsage && usageFreshness?.active_for_scoring && (
    Number(latestUsage.rushing_yards) >= 50 ||
    Number(latestUsage.snap_share) >= 0.5 ||
    Number(latestUsage.route_participation) >= 0.5
  ) ? (usageFreshness.freshness === "current" ? 3 : 1) : 0;
  const openRecentInjuries = intelligence.injury_episodes.filter((episode) =>
    !episode.end_date && (ageInDays(episode.start_date) ?? Infinity) <= 120
  ).length;
  return Math.max(-12, Math.min(12, reportAdjustment + usageAdjustment - openRecentInjuries * 2));
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
      const intelligence = getVerifiedPlayerIntelligence(player.player_id);
      const intelligenceAdjustment = getIntelligenceAdjustment(intelligence);
      const opportunityScore = clampRating(
        calculateOpportunityScore(player, starter) + intelligenceAdjustment
      );
      const starterInjured = starter && starter.player_id !== player.player_id && isMeaningfullyInjured(starter);
      const passingDownPlayer = player.position === "RB"
        ? findTaggedRolePlayer(group, "passing_down")
        : null;
      const goalLinePlayer = player.position === "RB"
        ? findTaggedRolePlayer(group, "goal_line")
        : null;
      const verifiedRoleTags = getRoleTags(player.player_id);
      const refreshStatus = getIntelligenceRefreshStatus(intelligence);

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
        intelligence_adjustment: intelligenceAdjustment,
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
            ? compactOpportunityPlayer(passingDownPlayer || directReplacement)
            : null,
          goal_line_replacement: player.position === "RB"
            ? compactOpportunityPlayer(goalLinePlayer || directReplacement)
            : null,
          verified_role_tags: verifiedRoleTags,
          evidence_level: passingDownPlayer || goalLinePlayer || verifiedRoleTags.length
            ? "sourced_role_reporting"
            : "depth_chart_inference_only"
        },
        injury_history: {
          one_year: summarizeInjuryWindow(intelligence.injury_episodes, 1),
          three_year: summarizeInjuryWindow(intelligence.injury_episodes, 3),
          five_year: summarizeInjuryWindow(intelligence.injury_episodes, 5),
          coverage: intelligence.injury_episodes.length
            ? "partial_verified_history"
            : "no_verified_history"
        },
        usage: summarizeUsage(intelligence.usage_samples),
        live_refresh: {
          source: "Sleeper NFL player data",
          observed_at: new Date().toISOString(),
          team: player.team || null,
          depth_chart_position: player.depth_chart_position || null,
          depth_chart_order: player.depth_chart_order ?? null,
          injury_status: player.injury_status || null,
          has_injury_designation: hasLiveInjuryDesignation(player),
          current_injury_designation: isMeaningfullyInjured(player),
          starter_injury_designation: Boolean(starterInjured),
          change_detection_key: [
            player.team || "FA",
            player.depth_chart_position || player.position,
            player.depth_chart_order ?? "NA",
            player.injury_status || "healthy"
          ].join(":")
        },
        intelligence_refresh: refreshStatus,
        sourced_role_reports: decorateRoleReports(intelligence.role_reports),
        reporting_coverage: intelligence.role_reports.length
          ? "verified_reports"
          : "no_verified_reports"
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

  for (const player of results) {
    const lowSeverityAlertIsActionable =
      player.roster_id === USER_ROSTER_ID ||
      (player.roster_status === "available" && Number(player.depth_chart_order) <= 3);
    if (hasLiveInjuryDesignation(player) && (
      isMeaningfullyInjured(player) || lowSeverityAlertIsActionable
    )) {
      const meaningful = isMeaningfullyInjured(player);
      alerts.push({
        alert_type: "live_player_injury_designation",
        priority: meaningful && player.roster_id === USER_ROSTER_ID
          ? "high"
          : meaningful ? "medium" : "low",
        player: compactOpportunityPlayer(player),
        detected_at: new Date().toISOString(),
        recommendation: meaningful && player.roster_id === USER_ROSTER_ID
          ? "Reassess lineup, IR eligibility, and the direct replacement chain."
          : meaningful
            ? "Reassess availability and the next healthy player in the replacement chain."
            : "Monitor the current designation; no major opportunity penalty is applied yet."
      });
    }
    if (player.roster_id === USER_ROSTER_ID && player.intelligence_refresh.refresh_needed) {
      alerts.push({
        alert_type: "stale_intelligence_review",
        priority: "low",
        player: compactOpportunityPlayer(player),
        last_verified_report_at: player.intelligence_refresh.latest_report_at,
        report_age_days: player.intelligence_refresh.report_age_days,
        recommendation: "Refresh role reporting before relying on the prior signal."
      });
    }
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
      role_inference_warning: "Passing-down and goal-line roles remain provisional for any player without a matching source-backed usage sample or role report.",
      intelligence_store_schema: PLAYER_INTELLIGENCE.schema_version,
      intelligence_policy: PLAYER_INTELLIGENCE.policy,
      injury_history_coverage: "source-gated per player",
      sourced_reporting_coverage: "source-gated per player",
      usage_coverage: "source-gated per player",
      dynamic_refresh: "Sleeper status and depth-chart fields refresh on every request; dated reports and usage automatically decay out of scoring."
    },
    alert_count: alerts.length,
    alerts,
    total_matching_players: results.length,
    players: results.slice(0, limit)
  };
}

const DPRF_STARTER_SLOTS = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  RB_WR: 2,
  WR_TE: 2,
  SUPER_FLEX: 1
};

function average(values) {
  const valid = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function normalizeAcrossTeams(value, values) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (high === low) return 50;
  return clampRating(((value - low) / (high - low)) * 100);
}

function selectBest(players, count, eligiblePositions, selectedIds) {
  return players
    .filter((player) => eligiblePositions.includes(player.position) && !selectedIds.has(player.player_id))
    .sort((a, b) => b.short_term_value - a.short_term_value || b.combined_trade_value - a.combined_trade_value)
    .slice(0, count);
}

function buildOptimalDprfLineup(players) {
  const active = players.filter((player) => player.roster_status === "active");
  const selected = [];
  const selectedIds = new Set();
  const addSlot = (slot, count, positions) => {
    const picks = selectBest(active, count, positions, selectedIds);
    for (const player of picks) {
      selected.push({ slot, ...player });
      selectedIds.add(player.player_id);
    }
  };
  addSlot("QB", DPRF_STARTER_SLOTS.QB, ["QB"]);
  addSlot("RB", DPRF_STARTER_SLOTS.RB, ["RB"]);
  addSlot("WR", DPRF_STARTER_SLOTS.WR, ["WR"]);
  addSlot("TE", DPRF_STARTER_SLOTS.TE, ["TE"]);
  addSlot("RB/WR", DPRF_STARTER_SLOTS.RB_WR, ["RB", "WR"]);
  addSlot("WR/TE", DPRF_STARTER_SLOTS.WR_TE, ["WR", "TE"]);
  addSlot("SUPER_FLEX", DPRF_STARTER_SLOTS.SUPER_FLEX, ["QB", "RB", "WR", "TE"]);
  return {
    starters: selected,
    starter_ids: selectedIds,
    filled_slots: selected.length,
    open_slots: Math.max(0, 11 - selected.length),
    raw_starter_value: selected.reduce((sum, player) => sum + player.short_term_value, 0),
    average_starter_stv: Math.round(average(selected.map((player) => player.short_term_value)) * 10) / 10
  };
}

function buildFuturePickInventory(rosters, tradedPicks, seasons = ["2027", "2028", "2029"], rounds = 6) {
  const inventory = new Map(rosters.map((roster) => [roster.roster_id, []]));
  const ownership = new Map();
  for (const season of seasons) {
    for (const roster of rosters) {
      for (let round = 1; round <= rounds; round += 1) {
        ownership.set(`${season}:${round}:${roster.roster_id}`, roster.roster_id);
      }
    }
  }
  for (const pick of tradedPicks) {
    const season = String(pick.season);
    const round = Number(pick.round);
    if (!seasons.includes(season) || round < 1 || round > rounds) continue;
    ownership.set(`${season}:${round}:${pick.roster_id}`, Number(pick.owner_id));
  }
  for (const [key, ownerId] of ownership.entries()) {
    if (!inventory.has(ownerId)) continue;
    const [season, round, originalRosterId] = key.split(":").map(Number);
    inventory.get(ownerId).push({ season, round, original_roster_id: originalRosterId, owner_roster_id: ownerId });
  }
  return inventory;
}

function pickBaseValue(round, slotBand) {
  const base = { 1: 34, 2: 20, 3: 12, 4: 7, 5: 4, 6: 2 }[round] || 0;
  const multiplier = slotBand === "early" ? 1.25 : slotBand === "late" ? 0.8 : 1;
  return Math.round(base * multiplier * 10) / 10;
}

async function getLiveRosterValues() {
  const [league, users, rosters, tradedPicks, rankedPlayers] = await Promise.all([
    sleeperFetch(`/league/${LEAGUE_ID}`),
    sleeperFetch(`/league/${LEAGUE_ID}/users`),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
    sleeperFetch(`/league/${LEAGUE_ID}/traded_picks`),
    getLeaguePlayerRatings()
  ]);
  const userMap = Object.fromEntries(users.map((user) => [user.user_id, {
    username: user.username,
    display_name: user.display_name,
    team_name: user.metadata?.team_name || user.display_name
  }]));
  const rosterLimit = getActiveRosterLimit(league);
  const preliminary = rosters.map((roster) => {
    const players = rankedPlayers.filter((player) => player.roster_id === roster.roster_id);
    const lineup = buildOptimalDprfLineup(players);
    const bench = players.filter((player) => !lineup.starter_ids.has(player.player_id));
    const activeCount = players.filter((player) => player.roster_status === "active").length;
    const positionRaw = Object.fromEntries(["QB", "RB", "WR", "TE"].map((position) => {
      const depthCount = { QB: 3, RB: 6, WR: 8, TE: 4 }[position];
      const pool = players.filter((player) => player.position === position)
        .sort((a, b) => b.combined_trade_value - a.combined_trade_value)
        .slice(0, depthCount);
      return [position, Math.round(pool.reduce((sum, player) => sum + player.combined_trade_value, 0) * 10) / 10];
    }));
    const core = [...players].sort((a, b) => b.combined_trade_value - a.combined_trade_value).slice(0, 15);
    return {
      roster_id: roster.roster_id,
      owner_id: roster.owner_id,
      manager: userMap[roster.owner_id] || null,
      players,
      lineup,
      bench,
      active_count: activeCount,
      roster_limit: rosterLimit,
      roster_pressure: Math.max(0, activeCount - rosterLimit),
      raw_bench_value: bench.reduce((sum, player) => sum + player.combined_trade_value * (player.roster_status === "active" ? 1 : 0.75), 0),
      raw_total_ctv: players.reduce((sum, player) => sum + player.combined_trade_value, 0),
      average_core_age: Math.round(average(core.map((player) => player.age)) * 10) / 10,
      youth_raw: average(core.map((player) => Math.max(0, 35 - Number(player.age || 35)))),
      position_raw: positionRaw
    };
  });
  const positionRanks = {};
  for (const position of ["QB", "RB", "WR", "TE"]) {
    positionRanks[position] = [...preliminary]
      .sort((a, b) => b.position_raw[position] - a.position_raw[position])
      .map((team, index) => [team.roster_id, index + 1]);
  }
  const rankMap = Object.fromEntries(Object.entries(positionRanks).map(([position, rows]) => [position, Object.fromEntries(rows)]));
  const starterValues = preliminary.map((team) => team.lineup.raw_starter_value);
  const benchValues = preliminary.map((team) => team.raw_bench_value);
  const totalValues = preliminary.map((team) => team.raw_total_ctv);
  const youthValues = preliminary.map((team) => team.youth_raw);
  const withoutPicks = preliminary.map((team) => {
    const lineupScore = normalizeAcrossTeams(team.lineup.raw_starter_value, starterValues);
    const benchScore = normalizeAcrossTeams(team.raw_bench_value, benchValues);
    const rosterValueScore = normalizeAcrossTeams(team.raw_total_ctv, totalValues);
    const youthScore = normalizeAcrossTeams(team.youth_raw, youthValues);
    const contenderCore = clampRating(lineupScore * 0.65 + benchScore * 0.25 + Math.min(100, rosterValueScore) * 0.1);
    return { ...team, lineup_score: lineupScore, bench_score: benchScore, roster_value_score: rosterValueScore, youth_score: youthScore, contender_core: contenderCore };
  });
  const originBand = Object.fromEntries(withoutPicks.map((team) => [team.roster_id,
    team.contender_core >= 67 ? "late" : team.contender_core <= 33 ? "early" : "middle"
  ]));
  const pickInventory = buildFuturePickInventory(rosters, tradedPicks);
  const pickValues = withoutPicks.map((team) => (pickInventory.get(team.roster_id) || []).reduce((sum, pick) => sum + pickBaseValue(pick.round, originBand[pick.original_roster_id]), 0));
  const finalTeams = withoutPicks.map((team, teamIndex) => {
    const picks = (pickInventory.get(team.roster_id) || []).map((pick) => ({
      ...pick,
      projected_slot: originBand[pick.original_roster_id],
      value: pickBaseValue(pick.round, originBand[pick.original_roster_id]),
      fragile_origin: originBand[pick.original_roster_id] === "early"
    })).sort((a, b) => a.season - b.season || a.round - b.round);
    const draftCapitalScore = normalizeAcrossTeams(pickValues[teamIndex], pickValues);
    const contenderScore = clampRating(team.contender_core * 0.9 + draftCapitalScore * 0.1);
    const dynastyScore = clampRating(team.roster_value_score * 0.45 + team.youth_score * 0.3 + draftCapitalScore * 0.25);
    const competitiveWindow = contenderScore >= 55
      ? "CONTENDER"
      : contenderScore <= 35
        ? "REBUILDER"
        : "IN_TRANSITION";
    const positionRanksForTeam = Object.fromEntries(["QB", "RB", "WR", "TE"].map((position) => [position, rankMap[position][team.roster_id]]));
    const needs = Object.entries(positionRanksForTeam).filter(([, rank]) => rank >= 8).map(([position]) => position);
    const surpluses = Object.entries(positionRanksForTeam).filter(([, rank]) => rank <= 3).map(([position]) => position);
    const buyLowCandidates = team.roster_id === USER_ROSTER_ID
      ? []
      : [...team.players]
        .filter((player) => player.long_term_value - player.short_term_value >= 8 && player.combined_trade_value >= 35)
        .sort((a, b) => (b.long_term_value - b.short_term_value) - (a.long_term_value - a.short_term_value))
        .slice(0, 3)
        .map((player) => ({ player_id: player.player_id, full_name: player.full_name, position: player.position, short_term_value: player.short_term_value, long_term_value: player.long_term_value, combined_trade_value: player.combined_trade_value, rationale: "Long-term value materially exceeds current short-term value." }));
    const sellHighCandidates = team.roster_id === USER_ROSTER_ID
      ? [...team.players]
        .filter((player) => !USER_PROTECTED_PLAYERS.has(player.full_name) && player.short_term_value - player.long_term_value >= 8 && player.combined_trade_value >= 35)
        .sort((a, b) => (b.short_term_value - b.long_term_value) - (a.short_term_value - a.long_term_value))
        .slice(0, 5)
        .map((player) => ({ player_id: player.player_id, full_name: player.full_name, position: player.position, short_term_value: player.short_term_value, long_term_value: player.long_term_value, combined_trade_value: player.combined_trade_value, rationale: "Short-term value materially exceeds long-term value; test the trade market before decline risk increases." }))
      : [];
    return {
      roster_id: team.roster_id,
      manager: team.manager,
      is_purdy13good: team.roster_id === USER_ROSTER_ID,
      competitive_window: competitiveWindow,
      contender_score: contenderScore,
      dynasty_score: dynastyScore,
      lineup_score: team.lineup_score,
      bench_score: team.bench_score,
      roster_value_score: team.roster_value_score,
      youth_score: team.youth_score,
      draft_capital_score: draftCapitalScore,
      average_core_age: team.average_core_age,
      position_ranks: positionRanksForTeam,
      needs,
      surpluses,
      trade_posture: {
        opponent_buy_low_candidates: buyLowCandidates,
        purdy13good_sell_high_candidates: sellHighCandidates,
        protected_players_excluded_from_sell_high: team.roster_id === USER_ROSTER_ID ? [...USER_PROTECTED_PLAYERS] : []
      },
      roster_construction: {
        active_players: team.active_count,
        active_limit: team.roster_limit,
        required_reductions: team.roster_pressure,
        taxi_players: team.players.filter((player) => player.roster_status === "taxi").length,
        reserve_players: team.players.filter((player) => player.roster_status === "reserve").length
      },
      optimal_lineup: {
        filled_slots: team.lineup.filled_slots,
        open_slots: team.lineup.open_slots,
        average_starter_stv: team.lineup.average_starter_stv,
        starters: team.lineup.starters.map((player) => ({ slot: player.slot, player_id: player.player_id, full_name: player.full_name, position: player.position, short_term_value: player.short_term_value, combined_trade_value: player.combined_trade_value }))
      },
      top_assets: [...team.players].sort((a, b) => b.combined_trade_value - a.combined_trade_value).slice(0, 8).map((player) => ({ player_id: player.player_id, full_name: player.full_name, position: player.position, age: player.age, short_term_value: player.short_term_value, long_term_value: player.long_term_value, combined_trade_value: player.combined_trade_value, actionable_label: player.actionable_label })),
      draft_capital: {
        seasons: [2027, 2028, 2029],
        total_picks: picks.length,
        first_round_picks: picks.filter((pick) => pick.round === 1).length,
        estimated_value: Math.round(pickValues[teamIndex] * 10) / 10,
        picks
      }
    };
  }).sort((a, b) => b.contender_score - a.contender_score || b.dynasty_score - a.dynasty_score);
  return {
    generated_at: new Date().toISOString(),
    league_id: LEAGUE_ID,
    model: ROSTER_VALUE_MODEL_VERSION,
    methodology: {
      format: "10-team dynasty; 1 QB, 2 RB, 2 WR, 1 TE, 2 RB/WR, 2 WR/TE, 1 Superflex",
      scoring_profile: DPRF_SCORING_PROFILE,
      contender_weights: { optimized_starting_lineup: 0.585, bench_depth: 0.225, total_roster_value: 0.09, draft_capital: 0.1 },
      dynasty_weights: { total_roster_value: 0.45, youth: 0.3, draft_capital: 0.25 },
      pick_inventory: "2027-2029, six rounds per season, adjusted by Sleeper traded-pick ownership",
      pick_slot_projection: "Origin roster strength estimates early, middle, or late; it is not a guaranteed draft slot."
    },
    team_count: finalTeams.length,
    teams: finalTeams
  };
}

function compactTradeAsset(player) {
  return {
    asset_type: "player",
    player_id: player.player_id,
    full_name: player.full_name,
    position: player.position,
    team: player.team,
    age: player.age,
    short_term_value: player.short_term_value,
    long_term_value: player.long_term_value,
    combined_trade_value: player.combined_trade_value,
    confidence: player.confidence,
    trend: player.trend,
    actionable_label: player.actionable_label
  };
}

function normalizeTradePick(pick) {
  const projectedSlot = pick.projected_slot || "middle";
  const value = pickBaseValue(Number(pick.round), projectedSlot);
  return {
    asset_type: "pick",
    season: Number(pick.season),
    round: Number(pick.round),
    original_roster_id: pick.original_roster_id ? Number(pick.original_roster_id) : null,
    projected_slot: projectedSlot,
    combined_trade_value: value,
    short_term_value: Math.round(value * 0.35 * 10) / 10,
    long_term_value: value
  };
}

function summarizeTradeSide(players, picks) {
  const assets = [...players.map(compactTradeAsset), ...picks.map(normalizeTradePick)];
  return {
    assets,
    player_count: players.length,
    pick_count: picks.length,
    short_term_value: Math.round(assets.reduce((sum, asset) => sum + Number(asset.short_term_value || 0), 0) * 10) / 10,
    long_term_value: Math.round(assets.reduce((sum, asset) => sum + Number(asset.long_term_value || 0), 0) * 10) / 10,
    combined_trade_value: Math.round(assets.reduce((sum, asset) => sum + Number(asset.combined_trade_value || 0), 0) * 10) / 10
  };
}

function getTradeRisk(players) {
  if (!players.length) return { score: 0, level: "none", drivers: [] };
  const drivers = [];
  let score = 0;
  for (const player of players) {
    if (player.injury_status) {
      score += 18;
      drivers.push(`${player.full_name}: ${player.injury_status} designation`);
    }
    if (Number(player.age) >= ({ QB: 34, RB: 28, WR: 30, TE: 31 }[player.position] || 30)) {
      score += 12;
      drivers.push(`${player.full_name}: age-curve risk`);
    }
    if (player.confidence === "low") {
      score += 10;
      drivers.push(`${player.full_name}: low-confidence valuation`);
    }
  }
  const normalized = clampRating(score / players.length);
  return { score: normalized, level: normalized >= 25 ? "high" : normalized >= 12 ? "medium" : "low", drivers };
}

async function evaluateDprfTrade({
  opponent_roster_id,
  user_gives_player_ids = [],
  user_receives_player_ids = [],
  user_gives_picks = [],
  user_receives_picks = []
}) {
  const [rankedPlayers, rosterValues] = await Promise.all([getLeaguePlayerRatings(), getLiveRosterValues()]);
  const opponentRosterId = Number(opponent_roster_id);
  if (!rosterValues.teams.some((team) => team.roster_id === opponentRosterId) || opponentRosterId === USER_ROSTER_ID) {
    throw new Error("opponent_roster_id must identify another DPRF team.");
  }
  const byId = Object.fromEntries(rankedPlayers.map((player) => [String(player.player_id), player]));
  const resolvePlayers = (ids, expectedRosterId, label) => ids.map(String).map((id) => {
    const player = byId[id];
    if (!player) throw new Error(`${label} includes unknown player_id ${id}.`);
    if (player.roster_id !== expectedRosterId) throw new Error(`${player.full_name} is not currently on roster ${expectedRosterId}.`);
    return player;
  });
  const givesPlayers = resolvePlayers(user_gives_player_ids, USER_ROSTER_ID, "user_gives_player_ids");
  const receivesPlayers = resolvePlayers(user_receives_player_ids, opponentRosterId, "user_receives_player_ids");
  const protectedOutgoing = givesPlayers.filter((player) => USER_PROTECTED_PLAYERS.has(player.full_name));
  const gives = summarizeTradeSide(givesPlayers, user_gives_picks);
  const receives = summarizeTradeSide(receivesPlayers, user_receives_picks);
  const userRoster = rankedPlayers.filter((player) => player.roster_id === USER_ROSTER_ID);
  const opponentRoster = rankedPlayers.filter((player) => player.roster_id === opponentRosterId);
  const beforeUser = buildOptimalDprfLineup(userRoster);
  const afterUser = buildOptimalDprfLineup([
    ...userRoster.filter((player) => !user_gives_player_ids.map(String).includes(String(player.player_id))),
    ...receivesPlayers.map((player) => ({ ...player, roster_id: USER_ROSTER_ID, roster_status: "active" }))
  ]);
  const beforeOpponent = buildOptimalDprfLineup(opponentRoster);
  const afterOpponent = buildOptimalDprfLineup([
    ...opponentRoster.filter((player) => !user_receives_player_ids.map(String).includes(String(player.player_id))),
    ...givesPlayers.map((player) => ({ ...player, roster_id: opponentRosterId, roster_status: "active" }))
  ]);
  const lineupDelta = afterUser.raw_starter_value - beforeUser.raw_starter_value;
  const opponentLineupDelta = afterOpponent.raw_starter_value - beforeOpponent.raw_starter_value;
  const ctvDelta = receives.combined_trade_value - gives.combined_trade_value;
  const stvDelta = receives.short_term_value - gives.short_term_value;
  const ltvDelta = receives.long_term_value - gives.long_term_value;
  const rosterSpotsFreed = gives.player_count - receives.player_count;
  const receiveRisk = getTradeRisk(receivesPlayers);
  const giveRisk = getTradeRisk(givesPlayers);
  const upsideDelta = Math.round((receivesPlayers.reduce((sum, player) => sum + Math.max(player.short_term_value, player.long_term_value), 0) - givesPlayers.reduce((sum, player) => sum + Math.max(player.short_term_value, player.long_term_value), 0)) * 10) / 10;
  let recommendation = "COUNTER";
  if (!protectedOutgoing.length && ctvDelta >= -3 && (lineupDelta > 0 || ltvDelta >= 0) && receiveRisk.score <= giveRisk.score + 15) recommendation = "ACCEPT";
  if (ctvDelta < -12 || (lineupDelta < -8 && ltvDelta < 0) || protectedOutgoing.length) recommendation = "REJECT";
  const counterGap = Math.max(0, Math.round((gives.combined_trade_value - receives.combined_trade_value) * 10) / 10);
  return {
    generated_at: new Date().toISOString(),
    league_id: LEAGUE_ID,
    model: TRADE_ENGINE_VERSION,
    user_roster_id: USER_ROSTER_ID,
    opponent_roster_id: opponentRosterId,
    recommendation,
    confidence: Math.abs(ctvDelta) >= 12 || Math.abs(lineupDelta) >= 8 ? "high" : "medium",
    user_gives: gives,
    user_receives: receives,
    evaluation: {
      current_lineup_improvement: Math.round(lineupDelta * 10) / 10,
      opponent_lineup_improvement: Math.round(opponentLineupDelta * 10) / 10,
      short_term_value_delta: Math.round(stvDelta * 10) / 10,
      long_term_value_delta: Math.round(ltvDelta * 10) / 10,
      combined_trade_value_delta: Math.round(ctvDelta * 10) / 10,
      roster_spots_freed: rosterSpotsFreed,
      upside_delta: upsideDelta,
      incoming_risk: receiveRisk,
      outgoing_risk: giveRisk,
      protected_asset_violation: protectedOutgoing.map((player) => player.full_name)
    },
    counter_guidance: recommendation === "COUNTER"
      ? { additional_value_needed: counterGap, instruction: counterGap > 0 ? "Ask the opponent to add value or reduce the outgoing package." : "Restructure for a clearer lineup or dynasty gain without increasing the maximum outgoing value." }
      : null,
    methodology: {
      player_foundation: "DPRF STV, LTV, CTV, position scarcity, confidence, trend, age, and injury status",
      roster_fit: "Exact 11-slot optimized starting lineup before and after the trade",
      protected_players: [...USER_PROTECTED_PLAYERS],
      posture: "Win now while preserving long-term dynasty value; draft picks are tradable assets."
    }
  };
}

function findClosestAssets(candidates, targetValue, maxCount = 2, ceilingMultiplier = 1.1) {
  const valid = candidates.filter((player) => player.combined_trade_value <= targetValue * ceilingMultiplier);
  const packages = valid.map((player) => ({ players: [player], value: player.combined_trade_value }));
  if (maxCount >= 2) {
    for (let i = 0; i < valid.length; i += 1) {
      for (let j = i + 1; j < valid.length; j += 1) {
        packages.push({ players: [valid[i], valid[j]], value: valid[i].combined_trade_value + valid[j].combined_trade_value });
      }
    }
  }
  return packages.sort((a, b) => Math.abs(a.value - targetValue) - Math.abs(b.value - targetValue))[0] || null;
}

function findAssetPackage(candidates, targetValue, { exactCount, minMultiplier = 0, maxMultiplier = 1.1 } = {}) {
  const packages = [];
  for (const player of candidates) packages.push({ players: [player], value: player.combined_trade_value });
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      packages.push({ players: [candidates[i], candidates[j]], value: candidates[i].combined_trade_value + candidates[j].combined_trade_value });
    }
  }
  return packages
    .filter((item) => !exactCount || item.players.length === exactCount)
    .filter((item) => item.value >= targetValue * minMultiplier && item.value <= targetValue * maxMultiplier)
    .sort((a, b) => Math.abs(a.value - targetValue) - Math.abs(b.value - targetValue))[0] || null;
}

function findPickPackage(picks, targetValue) {
  const candidates = [];
  for (const pick of picks) candidates.push({ picks: [pick], value: pick.value });
  for (let i = 0; i < picks.length; i += 1) {
    for (let j = i + 1; j < picks.length; j += 1) {
      candidates.push({ picks: [picks[i], picks[j]], value: picks[i].value + picks[j].value });
      for (let k = j + 1; k < picks.length; k += 1) {
        candidates.push({ picks: [picks[i], picks[j], picks[k]], value: picks[i].value + picks[j].value + picks[k].value });
      }
    }
  }
  return candidates
    .filter((item) => item.value >= targetValue * 0.68 && item.value <= targetValue * 1.08)
    .sort((a, b) => Math.abs(a.value - targetValue) - Math.abs(b.value - targetValue))[0] || null;
}

function describeGeneratedPackage(style, target, outgoingPlayers = [], outgoingPicks = [], maxValue = null) {
  const outgoingValue = outgoingPlayers.reduce((sum, player) => sum + player.combined_trade_value, 0) + outgoingPicks.reduce((sum, pick) => sum + pick.value, 0);
  return {
    style,
    user_sends: [...outgoingPlayers.map(compactTradeAsset), ...outgoingPicks.map((pick) => ({ asset_type: "pick", ...pick }))],
    user_receives: [compactTradeAsset(target)],
    outgoing_value: Math.round(outgoingValue * 10) / 10,
    target_value: target.combined_trade_value,
    value_delta: Math.round((target.combined_trade_value - outgoingValue) * 10) / 10,
    maximum_acceptable_outgoing_value: maxValue,
    requires_manager_review: true
  };
}

async function getAutomatedTradeTargets({ position, limit = 25 } = {}) {
  const [rosterValues, rankedPlayers] = await Promise.all([getLiveRosterValues(), getLeaguePlayerRatings()]);
  const userTeam = rosterValues.teams.find((team) => team.roster_id === USER_ROSTER_ID);
  const userPlayers = rankedPlayers.filter((player) => player.roster_id === USER_ROSTER_ID && !USER_PROTECTED_PLAYERS.has(player.full_name));
  const defaultNeeds = userTeam.needs.length ? userTeam.needs : ["RB"];
  const targetPositions = position ? [position] : [...new Set(["RB", ...defaultNeeds])];
  const userSurpluses = new Set(userTeam.surpluses);
  const userPicks = userTeam.draft_capital.picks;
  const results = rosterValues.teams
    .filter((team) => team.roster_id !== USER_ROSTER_ID)
    .flatMap((seller) => rankedPlayers
      .filter((player) => player.roster_id === seller.roster_id && targetPositions.includes(player.position))
      .filter((player) => player.combined_trade_value >= 35)
      .map((target) => {
        const sellerSurplus = seller.surpluses.includes(target.position);
        const sellerPressure = seller.roster_construction.required_reductions > 0;
        const buyLowGap = Math.max(0, target.long_term_value - target.short_term_value);
        const needFit = target.position === "RB" ? 18 : userTeam.needs.includes(target.position) ? 14 : 0;
        const availabilityScore = (sellerSurplus ? 12 : 0) + (sellerPressure ? 8 : 0) + (seller.competitive_window === "REBUILDER" && Number(target.age) >= 27 ? 8 : 0);
        const targetScore = clampRating(target.combined_trade_value * 0.4 + target.short_term_value * 0.15 + target.long_term_value * 0.1 + needFit + availabilityScore + Math.min(8, buyLowGap));
        const sellerNeeds = new Set(seller.needs);
        const outgoingPool = [...userPlayers]
          .filter((player) => sellerNeeds.has(player.position) || userSurpluses.has(player.position) || ["Trade Candidate", "Roster Bubble"].includes(player.actionable_label))
          .sort((a, b) => b.combined_trade_value - a.combined_trade_value)
          .slice(0, 14);
        const fair = findClosestAssets(outgoingPool, target.combined_trade_value, 2, 1.05);
        const aggressive = findAssetPackage(outgoingPool, target.combined_trade_value * 0.88, { minMultiplier: 0.72, maxMultiplier: 1 });
        const consolidationPool = [...userPlayers]
          .filter((player) => player.combined_trade_value >= 10 && player.combined_trade_value <= target.combined_trade_value)
          .sort((a, b) => b.combined_trade_value - a.combined_trade_value)
          .slice(0, 20);
        const consolidation = findAssetPackage(consolidationPool, target.combined_trade_value, { exactCount: 2, minMultiplier: 0.65, maxMultiplier: 1.08 });
        const pickPool = userPicks
          .filter((pick) => pick.season <= 2028)
          .sort((a, b) => b.value - a.value);
        const pickPackage = findPickPackage(pickPool, target.combined_trade_value);
        const maxAcceptable = Math.round(target.combined_trade_value * (target.position === "RB" ? 1.05 : 1.02) * 10) / 10;
        const packages = [];
        if (aggressive) packages.push(describeGeneratedPackage("AGGRESSIVE_VALUE", target, aggressive.players));
        if (fair) packages.push(describeGeneratedPackage("FAIR_OPENING", target, fair.players));
        if (consolidation && consolidation.players.length > 1) packages.push(describeGeneratedPackage("CONSOLIDATION", target, consolidation.players));
        if (pickPackage) packages.push(describeGeneratedPackage("PICK_BASED", target, [], pickPackage.picks));
        if (fair) packages.push(describeGeneratedPackage("MAXIMUM_ACCEPTABLE", target, fair.players, [], maxAcceptable));
        return {
          target_rank_score: targetScore,
          target: compactTradeAsset(target),
          seller: {
            roster_id: seller.roster_id,
            manager: seller.manager,
            competitive_window: seller.competitive_window,
            needs: seller.needs,
            surpluses: seller.surpluses,
            roster_reductions_required: seller.roster_construction.required_reductions
          },
          fit: {
            fills_user_need: userTeam.needs.includes(target.position) || target.position === "RB",
            seller_has_position_surplus: sellerSurplus,
            seller_under_roster_pressure: sellerPressure,
            buy_low_gap: buyLowGap,
            rationale: `${target.position} target matched to Purdy13Good need; seller context and DPRF STV/LTV determine priority.`
          },
          generated_offers: packages
        };
      }))
    .sort((a, b) => b.target_rank_score - a.target_rank_score || b.target.combined_trade_value - a.target.combined_trade_value)
    .slice(0, limit);
  return {
    generated_at: new Date().toISOString(),
    league_id: LEAGUE_ID,
    model: TRADE_ENGINE_VERSION,
    user_roster_id: USER_ROSTER_ID,
    filters: { position: position || null, limit },
    user_context: {
      competitive_window: userTeam.competitive_window,
      contender_score: userTeam.contender_score,
      dynasty_score: userTeam.dynasty_score,
      needs: userTeam.needs,
      surpluses: userTeam.surpluses,
      protected_players: [...USER_PROTECTED_PLAYERS]
    },
    target_count: results.length,
    targets: results,
    disclaimer: "Generated packages are valuation starting points. Confirm current news, manager preferences, and lineup consequences before sending."
  };
}

function transactionRosterIds(transaction) {
  return [...new Set([
    ...(transaction.roster_ids || []),
    ...Object.values(transaction.adds || {}),
    ...Object.values(transaction.drops || {}),
    ...(transaction.draft_picks || []).flatMap((pick) => [pick.owner_id, pick.previous_owner_id])
  ].map(Number).filter(Boolean))];
}

function getManagerSampleConfidence({ trades, moves, draftPicks, lineupWeeks }) {
  const evidencePoints = trades * 5 + Math.min(20, moves) + Math.min(12, draftPicks) + Math.min(18, lineupWeeks);
  const score = clampRating(evidencePoints * 1.8);
  return { score, level: score >= 75 ? "high" : score >= 45 ? "medium" : "low" };
}

function summarizeLineupBehavior(matchups, priorRosterId) {
  if (!priorRosterId) return { coverage: "no_linked_prior_roster", weeks_observed: 0 };
  const weekly = matchups
    .map((week, index) => ({ week: index + 1, entry: week.find((row) => Number(row.roster_id) === Number(priorRosterId)) }))
    .filter((row) => row.entry && Array.isArray(row.entry.starters));
  let changes = 0;
  let comparisons = 0;
  for (let index = 1; index < weekly.length; index += 1) {
    const prior = new Set(weekly[index - 1].entry.starters.filter((id) => id && id !== "0"));
    const current = new Set(weekly[index].entry.starters.filter((id) => id && id !== "0"));
    changes += [...current].filter((id) => !prior.has(id)).length;
    comparisons += 1;
  }
  const incompleteWeeks = weekly.filter((row) => row.entry.starters.some((id) => !id || id === "0")).length;
  return {
    coverage: weekly.length ? "linked_2025_lineups" : "no_lineup_records",
    weeks_observed: weekly.length,
    average_starter_changes_per_week: comparisons ? Math.round(changes / comparisons * 10) / 10 : 0,
    incomplete_lineup_weeks: incompleteWeeks,
    lineup_management_style: incompleteWeeks > 1
      ? "INCONSISTENT_LINEUP_COMPLETION"
      : comparisons && changes / comparisons >= 2.5
        ? "ACTIVE_MATCHUP_MANAGER"
        : weekly.length ? "STABLE_LINEUP_MANAGER" : "INSUFFICIENT_EVIDENCE"
  };
}

async function getManagerTendencies({ roster_id } = {}) {
  const [league, users, rosters, players, rosterValues, drafts] = await Promise.all([
    sleeperFetch(`/league/${LEAGUE_ID}`),
    sleeperFetch(`/league/${LEAGUE_ID}/users`),
    sleeperFetch(`/league/${LEAGUE_ID}/rosters`),
    sleeperFetch("/players/nfl"),
    getLiveRosterValues(),
    sleeperFetch(`/league/${LEAGUE_ID}/drafts`)
  ]);
  const currentWeek = Math.max(1, Math.min(18, Number(league.settings?.leg) || 1));
  const currentTransactionWeeks = await Promise.all(
    Array.from({ length: currentWeek }, (_, index) => sleeperFetch(`/league/${LEAGUE_ID}/transactions/${index + 1}`).catch(() => []))
  );
  const transactions = currentTransactionWeeks.flat().filter((transaction) => transaction.status === "complete");
  const draftResults = (await Promise.all(drafts.map((draft) => sleeperFetch(`/draft/${draft.draft_id}/picks`).catch(() => [])))).flat();
  let priorUsers = [];
  let priorRosters = [];
  let priorMatchups = [];
  if (league.previous_league_id) {
    [priorUsers, priorRosters, priorMatchups] = await Promise.all([
      sleeperFetch(`/league/${league.previous_league_id}/users`).catch(() => []),
      sleeperFetch(`/league/${league.previous_league_id}/rosters`).catch(() => []),
      Promise.all(Array.from({ length: 18 }, (_, index) => sleeperFetch(`/league/${league.previous_league_id}/matchups/${index + 1}`).catch(() => [])))
    ]);
  }
  const currentUserMap = Object.fromEntries(users.map((user) => [user.user_id, user]));
  const currentRosterById = Object.fromEntries(rosters.map((roster) => [roster.roster_id, roster]));
  const priorRosterByOwner = Object.fromEntries(priorRosters.map((roster) => [roster.owner_id, roster.roster_id]));
  const positionCounts = rosters.map((roster) => {
    const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const playerId of roster.players || []) {
      const position = players[playerId]?.position;
      if (position in counts) counts[position] += 1;
    }
    return counts;
  });
  const leaguePositionAverage = Object.fromEntries(["QB", "RB", "WR", "TE"].map((position) => [
    position,
    average(positionCounts.map((counts) => counts[position]))
  ]));
  const profiles = rosterValues.teams.map((team) => {
    const roster = currentRosterById[team.roster_id];
    const user = currentUserMap[roster.owner_id] || {};
    const managerTransactions = transactions.filter((transaction) => transactionRosterIds(transaction).includes(team.roster_id));
    const trades = managerTransactions.filter((transaction) => transaction.type === "trade");
    const waivers = managerTransactions.filter((transaction) => transaction.type === "waiver");
    const freeAgents = managerTransactions.filter((transaction) => transaction.type === "free_agent");
    const commissionerMoves = managerTransactions.filter((transaction) => transaction.type === "commissioner");
    const playerAssetsPerTrade = trades.map((transaction) => Object.values(transaction.adds || {}).filter((ownerId) => Number(ownerId) === team.roster_id).length + Object.values(transaction.drops || {}).filter((ownerId) => Number(ownerId) === team.roster_id).length);
    const pickTrades = trades.filter((transaction) => (transaction.draft_picks || []).some((pick) => Number(pick.owner_id) === team.roster_id || Number(pick.previous_owner_id) === team.roster_id));
    const picksAcquired = trades.flatMap((transaction) => transaction.draft_picks || []).filter((pick) => Number(pick.owner_id) === team.roster_id);
    const picksSent = trades.flatMap((transaction) => transaction.draft_picks || []).filter((pick) => Number(pick.previous_owner_id) === team.roster_id);
    const drafted = draftResults.filter((pick) => String(pick.picked_by || "") === String(roster.owner_id) || Number(pick.roster_id) === team.roster_id);
    const draftedPositions = Object.fromEntries(["QB", "RB", "WR", "TE"].map((position) => [position, drafted.filter((pick) => players[pick.player_id]?.position === position).length]));
    const counts = positionCounts[rosters.findIndex((item) => item.roster_id === team.roster_id)] || { QB: 0, RB: 0, WR: 0, TE: 0 };
    const positionalHoarding = Object.entries(counts).filter(([position, count]) => count >= leaguePositionAverage[position] + 1.5).map(([position]) => position);
    const lineupBehavior = summarizeLineupBehavior(priorMatchups, priorRosterByOwner[roster.owner_id]);
    const totalMoves = trades.length + waivers.length + freeAgents.length;
    const confidence = getManagerSampleConfidence({ trades: trades.length, moves: totalMoves, draftPicks: drafted.length, lineupWeeks: lineupBehavior.weeks_observed || 0 });
    const tradeReceptiveness = clampRating(15 + trades.length * 14 + Math.min(20, totalMoves) * 1.2);
    const pressureIndex = clampRating(team.roster_construction.required_reductions * 18 + team.needs.length * 8 + (team.competitive_window === "CONTENDER" ? 10 : 0) + (team.competitive_window === "REBUILDER" ? 6 : 0));
    const leverageScore = clampRating(team.surpluses.length * 15 + team.draft_capital.first_round_picks * 8 + Math.max(0, 55 - pressureIndex) * 0.5);
    const avgAssets = average(playerAssetsPerTrade);
    const packagePreference = pickTrades.length >= Math.max(1, Math.ceil(trades.length / 2))
      ? "PICK_INCLUSIVE"
      : avgAssets >= 3 ? "MULTI_ASSET_PACKAGES" : trades.length ? "PLAYER_FOR_PLAYER" : "INSUFFICIENT_EVIDENCE";
    const ageBias = team.average_core_age <= 25.5 ? "YOUTH_LEAN" : team.average_core_age >= 28 ? "VETERAN_LEAN" : "BALANCED_AGE_PROFILE";
    const openingStrategy = pressureIndex >= 55
      ? "Open below fair value and emphasize immediate roster relief."
      : tradeReceptiveness >= 60
        ? "Use a fair but favorable opening offer with two clear structures."
        : "Lead with a simple player-for-player concept before adding picks or secondary assets.";
    const walkAway = "Do not exceed the trade engine's maximum-acceptable outgoing value; preserve a positive lineup or long-term value case.";
    return {
      roster_id: team.roster_id,
      manager: team.manager,
      is_user_team: team.roster_id === USER_ROSTER_ID,
      competitive_window: team.competitive_window,
      evidence_period: {
        current_league_transactions_through_week: currentWeek,
        prior_lineup_season: league.previous_league_id ? String(Number(league.season) - 1) : null,
        prior_manager_match: priorRosterByOwner[roster.owner_id] ? "matched_by_owner_id" : "not_matched"
      },
      observed_behavior: {
        completed_trades: trades.length,
        waiver_claims: waivers.length,
        free_agent_transactions: freeAgents.length,
        commissioner_transactions: commissionerMoves.length,
        total_observed_moves: totalMoves,
        trades_with_picks: pickTrades.length,
        average_player_assets_per_trade: Math.round(avgAssets * 10) / 10,
        picks_acquired_in_observed_trades: picksAcquired.length,
        picks_sent_in_observed_trades: picksSent.length,
        rookie_draft_selections_observed: drafted.length,
        drafted_positions: draftedPositions,
        lineup_behavior: lineupBehavior
      },
      roster_tendencies: {
        roster_position_counts: counts,
        league_position_averages: Object.fromEntries(Object.entries(leaguePositionAverage).map(([position, value]) => [position, Math.round(value * 10) / 10])),
        positional_hoarding: positionalHoarding,
        age_bias: ageBias,
        needs: team.needs,
        surpluses: team.surpluses,
        injury_selling: "INSUFFICIENT_EVIDENCE"
      },
      negotiation_index: {
        trade_receptiveness: tradeReceptiveness,
        pressure_index: pressureIndex,
        leverage_score: leverageScore,
        confidence
      },
      inferred_preferences: {
        package_preference: packagePreference,
        rookie_vs_veteran_bias: ageBias,
        preferred_incoming_positions: team.needs,
        likely_movable_positions: team.surpluses,
        inference_warning: "Preferences are inferred from observed transactions and current construction; they are not direct statements from the manager."
      },
      negotiation_plan: {
        opening_strategy: openingStrategy,
        best_timing: team.roster_construction.required_reductions > 0 ? "Before required roster cuts." : team.competitive_window === "CONTENDER" ? "After an injury or lineup need becomes urgent." : "During market-value or draft-pick consolidation windows.",
        recommended_offer_shapes: packagePreference === "PICK_INCLUSIVE" ? ["FAIR_OPENING", "PICK_BASED", "MAXIMUM_ACCEPTABLE"] : packagePreference === "MULTI_ASSET_PACKAGES" ? ["AGGRESSIVE_VALUE", "CONSOLIDATION", "FAIR_OPENING"] : ["AGGRESSIVE_VALUE", "FAIR_OPENING", "MAXIMUM_ACCEPTABLE"],
        walk_away_rule: walkAway
      },
      future_pick_strategy: {
        current_2027_2029_inventory: team.draft_capital,
        observed_picks_acquired: picksAcquired,
        observed_picks_sent: picksSent
      }
    };
  }).filter((profile) => !roster_id || profile.roster_id === Number(roster_id));
  return {
    generated_at: new Date().toISOString(),
    league_id: LEAGUE_ID,
    model: MANAGER_TENDENCY_MODEL_VERSION,
    filters: { roster_id: roster_id ? Number(roster_id) : null },
    methodology: {
      observed_sources: ["Sleeper current-league transactions", "Sleeper rookie draft results", "Sleeper current rosters", "Sleeper linked 2025 lineups", "DPRF roster-value calculator"],
      evidence_policy: "Observed behavior is separated from inference; low samples reduce confidence.",
      current_history_limit: "Transaction tendency metrics cover the current 2026 league through the current Sleeper week; linked 2025 data currently supplies lineup behavior only."
    },
    profile_count: profiles.length,
    profiles
  };
}
const WEEKLY_VOLATILITY = {
  QB: { floor: 0.78, upside: 1.25 }, RB: { floor: 0.65, upside: 1.45 },
  WR: { floor: 0.60, upside: 1.55 }, TE: { floor: 0.58, upside: 1.60 }
};

function roundProjection(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function scoreWeeklyStats(stats, scoringSettings) {
  return roundProjection(Object.entries(scoringSettings || {}).reduce((total, [stat, points]) => {
    const projectedStat = Number(stats?.[stat]);
    return total + (Number.isFinite(projectedStat) ? projectedStat * Number(points || 0) : 0);
  }, 0));
}

function selectWeeklyLineup(players, valueField) {
  const available = players.filter((player) => player.roster_status === "active");
  const selected = [];
  const selectedIds = new Set();
  const pick = (slot, count, eligiblePositions) => {
    const choices = available
      .filter((player) => eligiblePositions.includes(player.position) && !selectedIds.has(player.player_id))
      .sort((a, b) => Number(b[valueField] ?? -1) - Number(a[valueField] ?? -1) || b.short_term_value - a.short_term_value)
      .slice(0, count);
    for (const player of choices) {
      selected.push({ slot, ...player });
      selectedIds.add(player.player_id);
    }
  };
  pick("QB", 1, ["QB"]); pick("RB", 2, ["RB"]); pick("WR", 2, ["WR"]);
  pick("TE", 1, ["TE"]); pick("RB/WR", 2, ["RB", "WR"]); pick("WR/TE", 2, ["WR", "TE"]);
  pick("SUPER_FLEX", 1, ["QB", "RB", "WR", "TE"]);
  return {
    starters: selected, starter_ids: [...selectedIds], filled_slots: selected.length,
    open_slots: Math.max(0, 11 - selected.length),
    projected_total: roundProjection(selected.reduce((sum, player) => sum + Number(player[valueField] || 0), 0))
  };
}

async function getWeeklyLineupProjections({ season, week } = {}) {
  const [league, ratings] = await Promise.all([sleeperFetch(`/league/${LEAGUE_ID}`), getLeaguePlayerRatings()]);
  const selectedSeason = Number(season || league.season || 2026);
  const selectedWeek = Number(week || league.settings?.leg || 1);
  const projections = await sleeperProjectionFetch(selectedSeason, selectedWeek);
  const projectionMap = new Map(projections.map((projection) => [String(projection.player_id), projection]));
  const roster = ratings.filter((player) => player.roster_id === USER_ROSTER_ID);
  const players = roster.map((player) => {
    const source = projectionMap.get(String(player.player_id));
    if (!source) return {
      ...player, projection_status: "PROVISIONAL_NO_PROVIDER_PROJECTION", projection_source: null,
      opponent: null, game_date: null, projected_floor: null, projected_median: null,
      projected_upside: null, projection_confidence: "LOW", scoring_components: null
    };
    const median = scoreWeeklyStats(source.stats, league.scoring_settings);
    const volatility = WEEKLY_VOLATILITY[player.position] || { floor: 0.6, upside: 1.5 };
    const injuryStatus = String(source.player?.injury_status || player.injury_status || "").toLowerCase();
    const injuryMultiplier = injuryStatus === "out" ? 0 : injuryStatus === "doubtful" ? 0.65 : injuryStatus === "questionable" ? 0.85 : 1;
    return {
      ...player, projection_status: "VERIFIED_PROVIDER_MEDIAN_MODELED_RANGE",
      projection_source: source.company || "Sleeper projection feed",
      source_updated_at: source.updated_at ? new Date(Number(source.updated_at)).toISOString() : null,
      opponent: source.opponent || null, game_date: source.date || null,
      projected_floor: roundProjection(median * volatility.floor * injuryMultiplier),
      projected_median: roundProjection(median * injuryMultiplier),
      projected_upside: roundProjection(median * volatility.upside * injuryMultiplier),
      projection_confidence: injuryMultiplier < 1 ? "MEDIUM" : "HIGH",
      injury_adjustment: injuryMultiplier, scoring_components: source.stats
    };
  });
  const missing = players.filter((player) => player.projection_status.startsWith("PROVISIONAL"));
  return {
    generated_at: new Date().toISOString(), league_id: LEAGUE_ID, roster_id: USER_ROSTER_ID,
    season: selectedSeason, week: selectedWeek, model: WEEKLY_PROJECTION_MODEL_VERSION,
    scoring_source: "Live Sleeper league scoring_settings", scoring_settings: league.scoring_settings,
    methodology: {
      provider_median: "Sleeper weekly projection feed; the provider is named in each player record.",
      floor_upside: "Modeled position-volatility bands around the provider median; not provider-supplied percentiles.",
      injury_policy: "Questionable receives a 15% availability discount, doubtful 35%, and out 100%.",
      lineup_slots: DPRF_STARTER_SLOTS,
      missing_data_policy: "No provider projection means no invented point estimate."
    },
    coverage: {
      roster_players: players.length, provider_projections: players.length - missing.length,
      provisional_players: missing.length, weather: "NOT_CONFIGURED",
      betting_game_environment: "NOT_CONFIGURED", historical_projection_accuracy: "PENDING_COMPLETED_2026_GAMES",
      kickoff_window_contingencies: "GAME_DATE_ONLY_NO_VERIFIED_KICKOFF_TIME"
    },
    recommended_posture: "Use median by default, safest when favored, and highest-upside when chasing points.",
    lineups: {
      safest: selectWeeklyLineup(players, "projected_floor"),
      median: selectWeeklyLineup(players, "projected_median"),
      highest_upside: selectWeeklyLineup(players, "projected_upside")
    },
    player_projections: [...players].sort((a, b) => Number(b.projected_median ?? -1) - Number(a.projected_median ?? -1)),
    warnings: missing.map((player) => `${player.full_name}: no verified weekly provider projection.`)
  };
}

function createMcpServer() {
  const server = new McpServer(
    {
      name: "democratic-peoples-republic-of-fantasy",
      version: "1.10.0"
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
        "Maps Purdy13Good and available players to current depth-chart competition, sourced injury history, verified role reports, usage samples, replacement paths, recalculated opportunity, and handcuff alerts.",
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
    "get_live_roster_values",
    {
      title: "Grade every DPRF roster",
      description:
        "Grades all 10 DPRF teams using optimized starting-lineup strength, bench depth, total roster value, age, positional scarcity, roster pressure, and 2027-2029 draft capital; classifies each team as contender, rebuilder, or in transition.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => toolResult(await getLiveRosterValues())
  );

  server.registerTool(
    "get_automated_trade_targets",
    {
      title: "Find DPRF trade targets and offers",
      description:
        "Finds opponent trade targets by Purdy13Good need, seller surplus, roster pressure, competitive window, and DPRF STV/LTV; generates aggressive-value, fair, consolidation, pick-based, and maximum-acceptable offer structures.",
      inputSchema: {
        position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
        limit: z.number().int().min(1).max(50).default(25)
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ position, limit }) => toolResult(await getAutomatedTradeTargets({ position, limit }))
  );

  server.registerTool(
    "evaluate_dprf_trade",
    {
      title: "Evaluate a DPRF trade",
      description:
        "Evaluates a proposed trade for Purdy13Good using lineup improvement, STV, LTV, CTV, roster-space impact, risk, upside, and opponent impact; recommends accept, reject, or counter.",
      inputSchema: {
        opponent_roster_id: z.number().int().min(1).max(10),
        user_gives_player_ids: z.array(z.string()).default([]),
        user_receives_player_ids: z.array(z.string()).default([]),
        user_gives_picks: z.array(z.object({
          season: z.number().int().min(2027).max(2029),
          round: z.number().int().min(1).max(6),
          projected_slot: z.enum(["early", "middle", "late"]).default("middle"),
          original_roster_id: z.number().int().min(1).max(10).optional()
        })).default([]),
        user_receives_picks: z.array(z.object({
          season: z.number().int().min(2027).max(2029),
          round: z.number().int().min(1).max(6),
          projected_slot: z.enum(["early", "middle", "late"]).default("middle"),
          original_roster_id: z.number().int().min(1).max(10).optional()
        })).default([])
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async (input) => toolResult(await evaluateDprfTrade(input))
  );

  server.registerTool(
    "get_manager_tendencies",
    {
      title: "Profile DPRF manager tendencies",
      description:
        "Profiles trade, waiver, free-agent, draft, lineup, positional-hoarding, and future-pick behavior; returns trade receptiveness, pressure, leverage, inferred package preferences, negotiation timing, opening strategy, and walk-away guidance.",
      inputSchema: {
        roster_id: z.number().int().min(1).max(10).optional()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ roster_id }) => toolResult(await getManagerTendencies({ roster_id }))
  );

  server.registerTool(
    "get_weekly_lineup_projections",
    {
      title: "Get DPRF weekly projections and lineups",
      description: "Converts weekly projections through live DPRF scoring and returns safest, median, and highest-upside Purdy13Good lineups with confidence and missing-data warnings.",
      inputSchema: {
        season: z.number().int().min(2026).max(2030).optional(),
        week: z.number().int().min(1).max(18).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    async ({ season, week }) => toolResult(await getWeeklyLineupProjections({ season, week }))
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
      "/api/roster-values",
      "/api/trade-targets",
      "/api/trade-evaluator",
      "/api/manager-tendencies",
      "/api/weekly-lineup?season=2026&week=1",
      "/api/waivers",
      "/api/live"
    ]
  });
});

app.get("/api/roster-values", async (req, res) => {
  try {
    res.json(await getLiveRosterValues());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/trade-targets", async (req, res) => {
  try {
    const position = req.query.position ? String(req.query.position).toUpperCase() : undefined;
    const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
    if (position && !["QB", "RB", "WR", "TE"].includes(position)) return res.status(400).json({ error: "Position must be QB, RB, WR, or TE." });
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return res.status(400).json({ error: "Limit must be a whole number from 1 through 50." });
    res.json(await getAutomatedTradeTargets({ position, limit }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/trade-evaluator", async (req, res) => {
  try {
    res.json(await evaluateDprfTrade(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/manager-tendencies", async (req, res) => {
  try {
    const rosterId = req.query.roster_id === undefined ? undefined : Number(req.query.roster_id);
    if (rosterId !== undefined && (!Number.isInteger(rosterId) || rosterId < 1 || rosterId > 10)) {
      return res.status(400).json({ error: "roster_id must be a whole number from 1 through 10." });
    }
    res.json(await getManagerTendencies({ roster_id: rosterId }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/weekly-lineup", async (req, res) => {
  try {
    const season = req.query.season === undefined ? undefined : Number(req.query.season);
    const week = req.query.week === undefined ? undefined : Number(req.query.week);
    if (season !== undefined && (!Number.isInteger(season) || season < 2026 || season > 2030)) {
      return res.status(400).json({ error: "season must be a whole number from 2026 through 2030." });
    }
    if (week !== undefined && (!Number.isInteger(week) || week < 1 || week > 18)) {
      return res.status(400).json({ error: "week must be a whole number from 1 through 18." });
    }
    res.json(await getWeeklyLineupProjections({ season, week }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
