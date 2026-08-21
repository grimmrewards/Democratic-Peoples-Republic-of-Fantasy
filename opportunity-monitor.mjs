import fs from "node:fs/promises";

const ENDPOINT = process.env.DPRF_OPPORTUNITY_URL ||
  "https://democratic-peoples-republic-of-fant.vercel.app/api/opportunities?scope=purdy_and_available&limit=500";
const SNAPSHOT_PATH = process.env.DPRF_SNAPSHOT_PATH || "opportunity-monitor-snapshot.json";
const LOG_PATH = process.env.DPRF_EVENT_LOG_PATH || "opportunity-monitor-events.jsonl";
const ALERT_PATH = process.env.DPRF_ALERT_PATH || "opportunity-monitor-alert.md";
const SCORE_THRESHOLD = Number(process.env.DPRF_SCORE_CHANGE_THRESHOLD || 5);

function compactPlayer(player) {
  return {
    player_id: String(player.player_id),
    full_name: player.full_name || player.name || String(player.player_id),
    position: player.position || null,
    team: player.team || null,
    roster_id: player.roster_id ?? null,
    roster_status: player.roster_status || null,
    depth_chart_position: player.live_refresh?.depth_chart_position || null,
    depth_chart_order: player.live_refresh?.depth_chart_order ?? null,
    injury_status: player.live_refresh?.injury_status || null,
    change_detection_key: player.live_refresh?.change_detection_key || null,
    estimated_role: player.estimated_role || null,
    opportunity_score: Number(player.opportunity_score) || 0,
    actionable_label: player.actionable_label || null,
    overall_rank: player.overall_rank ?? null,
    position_rank: player.position_rank ?? null
  };
}

function compactAlert(alert) {
  const player = alert.opportunity_player || alert.player || alert.starter || {};
  return {
    key: [alert.alert_type, player.player_id || player.full_name || "unknown"].join(":"),
    alert_type: alert.alert_type,
    priority: alert.priority || "low",
    player_id: player.player_id || null,
    player_name: player.full_name || player.name || null,
    recommendation: alert.recommendation || null
  };
}

export function buildSnapshot(payload, observedAt = new Date().toISOString()) {
  return {
    schema_version: "1.0",
    observed_at: observedAt,
    source_endpoint: ENDPOINT,
    model: payload.model || null,
    players: Object.fromEntries((payload.players || []).map((player) => {
      const compact = compactPlayer(player);
      return [compact.player_id, compact];
    })),
    alerts: Object.fromEntries((payload.alerts || []).map((alert) => {
      const compact = compactAlert(alert);
      return [compact.key, compact];
    }))
  };
}

function addChange(changes, player, field, before, after, severity, reason) {
  changes.push({
    event_type: "opportunity_monitor_change",
    player_id: player.player_id,
    player_name: player.full_name,
    position: player.position,
    team: player.team,
    field,
    before,
    after,
    severity,
    reason
  });
}

export function compareSnapshots(previous, current) {
  const changes = [];
  for (const [playerId, player] of Object.entries(current.players)) {
    const prior = previous.players?.[playerId];
    if (!prior) {
      if (player.roster_id === 2 || (player.roster_status === "available" && Number(player.depth_chart_order) <= 3)) {
        addChange(changes, player, "monitoring_coverage", null, "added", "low", "New actionable player entered the monitored universe.");
      }
      continue;
    }
    if (prior.team !== player.team) addChange(changes, player, "team", prior.team, player.team, "high", "NFL team changed.");
    if (prior.roster_status !== player.roster_status || prior.roster_id !== player.roster_id) {
      addChange(changes, player, "roster_status", prior.roster_status, player.roster_status, "high", "DPRF roster availability changed.");
    }
    if (prior.injury_status !== player.injury_status) {
      const severity = player.injury_status ? "high" : "medium";
      addChange(changes, player, "injury_status", prior.injury_status, player.injury_status, severity, "Live Sleeper injury designation changed.");
    }
    if (prior.depth_chart_order !== player.depth_chart_order) {
      addChange(changes, player, "depth_chart_order", prior.depth_chart_order, player.depth_chart_order, "high", "Listed depth-chart order changed.");
    }
    if (prior.estimated_role !== player.estimated_role) {
      addChange(changes, player, "estimated_role", prior.estimated_role, player.estimated_role, "medium", "Estimated role changed.");
    }
    const scoreDelta = player.opportunity_score - prior.opportunity_score;
    if (Math.abs(scoreDelta) >= SCORE_THRESHOLD) {
      addChange(changes, player, "opportunity_score", prior.opportunity_score, player.opportunity_score, "medium", `Opportunity score moved ${scoreDelta > 0 ? "+" : ""}${scoreDelta}.`);
    }
    if (prior.actionable_label !== player.actionable_label) {
      addChange(changes, player, "actionable_label", prior.actionable_label, player.actionable_label, "medium", "Actionable dynasty label changed.");
    }
  }
  for (const [key, alert] of Object.entries(current.alerts)) {
    if (!previous.alerts?.[key] && ["high", "medium"].includes(alert.priority)) {
      changes.push({
        event_type: "new_opportunity_alert",
        player_id: alert.player_id,
        player_name: alert.player_name,
        field: alert.alert_type,
        before: null,
        after: alert.priority,
        severity: alert.priority,
        reason: alert.recommendation || "New actionable opportunity alert."
      });
    }
  }
  return changes;
}

function markdown(changes, observedAt) {
  const actionable = changes.filter((change) => ["high", "medium"].includes(change.severity));
  const lines = [
    "# DPRF opportunity changes",
    "",
    `Detected: ${observedAt}`,
    "",
    ...actionable.map((change) => `- **${change.severity.toUpperCase()} — ${change.player_name || change.player_id}:** ${change.reason} (${change.field}: ${change.before ?? "none"} → ${change.after ?? "none"})`),
    "",
    `[Open the live opportunity engine](${ENDPOINT})`
  ];
  return lines.join("\n");
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function run() {
  const response = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Opportunity endpoint returned ${response.status}.`);
  const payload = await response.json();
  const current = buildSnapshot(payload);
  let previous = { players: {}, alerts: {} };
  let baseline = false;
  try {
    previous = JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8"));
    baseline = !previous.observed_at;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    baseline = true;
  }
  const changes = baseline ? [] : compareSnapshots(previous, current);
  await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`);
  if (changes.length) {
    const events = changes.map((change) => JSON.stringify({ ...change, detected_at: current.observed_at, source: ENDPOINT })).join("\n");
    await fs.appendFile(LOG_PATH, `${events}\n`);
  }
  const actionable = changes.filter((change) => ["high", "medium"].includes(change.severity));
  await fs.writeFile(ALERT_PATH, markdown(changes, current.observed_at));
  await setOutput("baseline", String(baseline));
  await setOutput("change_count", String(changes.length));
  await setOutput("actionable_count", String(actionable.length));
  await setOutput("observed_at", current.observed_at);
  console.log(JSON.stringify({ baseline, change_count: changes.length, actionable_count: actionable.length }));
}

async function selfTest() {
  const base = buildSnapshot({ players: [{ player_id: "1", full_name: "Test RB", position: "RB", team: "AAA", roster_id: 2, roster_status: "rostered", opportunity_score: 60, actionable_label: "KEEP", estimated_role: "backup", live_refresh: { depth_chart_order: 2, injury_status: null } }], alerts: [] }, "2026-08-21T00:00:00Z");
  const next = buildSnapshot({ players: [{ player_id: "1", full_name: "Test RB", position: "RB", team: "AAA", roster_id: 2, roster_status: "rostered", opportunity_score: 68, actionable_label: "KEEP", estimated_role: "starter", live_refresh: { depth_chart_order: 1, injury_status: "Questionable" } }], alerts: [] }, "2026-08-22T00:00:00Z");
  const changes = compareSnapshots(base, next);
  const fields = new Set(changes.map((change) => change.field));
  for (const expected of ["injury_status", "depth_chart_order", "estimated_role", "opportunity_score"]) {
    if (!fields.has(expected)) throw new Error(`Self-test missing ${expected}.`);
  }
  console.log(`monitor self-test passed (${changes.length} meaningful changes)`);
}

if (process.argv.includes("--self-test")) await selfTest();
else await run();
