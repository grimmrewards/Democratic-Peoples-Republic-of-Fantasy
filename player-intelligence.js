const PLAYER_INTELLIGENCE = {
  schema_version: "1.0",
  policy: "Only source-dated injury, usage, and role records may affect the opportunity engine.",
  players: {
    "5892": {
      injury_episodes: [],
      usage_samples: [],
      role_reports: [
        {
          report_id: "5892-2026-08-18-texans",
          published_at: "2026-08-18T00:00:00Z",
          source_name: "Houston Texans",
          source_url: "https://www.houstontexans.com/news/harris-hits-david-montgomery-runs-wild-as-texans-and-raiders-open-joint-practices",
          source_type: "official_team",
          summary: "Team practice reporting highlighted Montgomery running through contact and contributing as a receiver.",
          role_tags: ["featured", "passing_down"],
          signal: "positive"
        }
      ]
    },
    "11643": {
      injury_episodes: [],
      usage_samples: [],
      role_reports: [
        {
          report_id: "11643-2026-07-16-dolphins",
          published_at: "2026-07-16T00:00:00Z",
          source_name: "Miami Dolphins",
          source_url: "https://www.miamidolphins.com/news/training-camp-preview-2026-running-backs",
          source_type: "official_team",
          summary: "The team described Wright as the back who filled in for De'Von Achane, while Ollie Gordon handled more short-yardage work.",
          role_tags: ["direct_backup", "change_of_pace"],
          signal: "positive"
        }
      ]
    },
    "13414": {
      injury_episodes: [
        {
          injury_id: "13414-2026-adductor",
          body_part: "adductor",
          start_date: "2026-08-03",
          end_date: "2026-08-18",
          games_missed: 1,
          severity: "minor",
          source_name: "NBC Sports Bay Area",
          source_url: "https://www.49erswebzone.com/news/202452-rookie-running-kaelon-practice-chargers/",
          source_published_at: "2026-08-18T00:00:00Z"
        }
      ],
      usage_samples: [],
      role_reports: [
        {
          report_id: "13414-2026-08-18-nbcs",
          published_at: "2026-08-18T00:00:00Z",
          source_name: "NBC Sports Bay Area",
          source_url: "https://www.49erswebzone.com/news/202452-rookie-running-kaelon-practice-chargers/",
          source_type: "beat_report",
          summary: "Black returned from an adductor injury and was praised by Brock Purdy for hitting the hole and running hard in joint practice.",
          role_tags: ["direct_backup", "riser"],
          signal: "positive"
        }
      ]
    },
    "13337": {
      injury_episodes: [],
      usage_samples: [
        {
          sample_id: "13337-2026-preseason-1",
          season: 2026,
          week: 1,
          season_type: "preseason",
          rushing_yards: 59,
          source_name: "Arrowhead Pride",
          source_url: "https://www.arrowheadpride.com/kansas-city-chiefs-game-information/207703/final-score-rams-defeat-chiefs-20-12-nfl-preseason-week-1",
          recorded_at: "2026-08-16T00:00:00Z"
        }
      ],
      role_reports: [
        {
          report_id: "13337-2026-08-16-preseason",
          published_at: "2026-08-16T00:00:00Z",
          source_name: "Arrowhead Pride",
          source_url: "https://www.arrowheadpride.com/kansas-city-chiefs-game-information/207703/final-score-rams-defeat-chiefs-20-12-nfl-preseason-week-1",
          source_type: "game_report",
          summary: "Johnson led Kansas City with 59 rushing yards in the preseason opener.",
          role_tags: ["riser"],
          signal: "positive"
        }
      ]
    }
  }
};

export default PLAYER_INTELLIGENCE;
