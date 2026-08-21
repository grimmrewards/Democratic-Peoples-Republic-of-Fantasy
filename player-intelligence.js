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
    },
    "5995": {
      injury_episodes: [{
        injury_id: "5995-2025-neck", body_part: "neck", start_date: "2025-11-01", end_date: "2026-06-15", games_missed: null, severity: "major",
        source_name: "Baltimore Ravens", source_url: "https://www.baltimoreravens.com/news/derrick-henry-justice-hill-adam-randall-rasheen-ali-training-camp-competion-preview-ravens-2026", source_published_at: "2026-07-15T00:00:00Z"
      }],
      usage_samples: [],
      role_reports: [{
        report_id: "5995-2026-07-15-ravens", published_at: "2026-07-15T00:00:00Z", source_name: "Baltimore Ravens",
        source_url: "https://www.baltimoreravens.com/news/derrick-henry-justice-hill-adam-randall-rasheen-ali-training-camp-competion-preview-ravens-2026", source_type: "official_team",
        summary: "Baltimore reported that Hill looked fully healthy in offseason work and remains Derrick Henry's versatile backup as a runner, receiver, and blocker.",
        role_tags: ["direct_backup", "passing_down", "pass_protection"], signal: "positive"
      }]
    },
    "12476": {
      injury_episodes: [], usage_samples: [],
      role_reports: [{
        report_id: "12476-2026-08-19-reuters", published_at: "2026-08-19T00:00:00Z", source_name: "Reuters",
        source_url: "https://www.reuters.com/sports/saints-rb-alvin-kamara-knee-expected-miss-4-6-weeks--flm-2026-08-19/", source_type: "news_service",
        summary: "Neal returned from a hamstring absence for the August 18 scrimmage while New Orleans prepared to use a committee during Alvin Kamara's absence.",
        role_tags: ["committee_depth", "riser"], signal: "positive"
      }]
    },
    "12544": {
      injury_episodes: [{
        injury_id: "12544-2026-soft-tissue", body_part: "soft_tissue", start_date: "2026-08-17", end_date: null, games_missed: null, severity: "moderate",
        source_name: "NBC Sports", source_url: "https://www.nbcsports.com/fantasy/football/player-news/2026-08-18/lequint-allen-soft-tissue-out-for-rest-of-camp", source_published_at: "2026-08-18T00:00:00Z"
      }],
      usage_samples: [],
      role_reports: [{
        report_id: "12544-2026-08-18-nbcs", published_at: "2026-08-18T00:00:00Z", source_name: "NBC Sports",
        source_url: "https://www.nbcsports.com/fantasy/football/player-news/2026-08-18/lequint-allen-soft-tissue-out-for-rest-of-camp", source_type: "news_report",
        summary: "Allen was ruled out for the rest of camp with a soft-tissue injury, clouding Week 1 availability despite an expected receiving-back role.",
        role_tags: ["passing_down", "receiving_back"], signal: "negative"
      }]
    },
    "4988": {
      injury_episodes: [
        { injury_id: "4988-2025-rib", body_part: "rib", start_date: "2025-12-07", end_date: "2025-12-15", games_missed: 1, severity: "minor", source_name: "Draft Sharks", source_url: "https://www.draftsharks.com/fantasy/injury-history/nick-chubb/9980", source_published_at: "2026-08-21T00:00:00Z" },
        { injury_id: "4988-2024-foot", body_part: "foot", start_date: "2024-12-15", end_date: "2025-01-06", games_missed: 3, severity: "moderate", source_name: "Draft Sharks", source_url: "https://www.draftsharks.com/fantasy/injury-history/nick-chubb/9980", source_published_at: "2026-08-21T00:00:00Z" },
        { injury_id: "4988-2023-knee", body_part: "knee", start_date: "2023-09-18", end_date: "2024-10-20", games_missed: 15, severity: "major", source_name: "Draft Sharks", source_url: "https://www.draftsharks.com/fantasy/injury-history/nick-chubb/9980", source_published_at: "2026-08-21T00:00:00Z" },
        { injury_id: "4988-2021-calf", body_part: "calf", start_date: "2021-10-10", end_date: "2021-10-31", games_missed: 2, severity: "moderate", source_name: "Draft Sharks", source_url: "https://www.draftsharks.com/fantasy/injury-history/nick-chubb/9980", source_published_at: "2026-08-21T00:00:00Z" }
      ],
      usage_samples: [],
      role_reports: [{
        report_id: "4988-2026-07-23-si", published_at: "2026-07-23T00:00:00Z", source_name: "Sports Illustrated",
        source_url: "https://www.si.com/nfl/texans/onsi/8-texans-free-agents-still-unsigned-as-training-camps-kick-off", source_type: "news_report",
        summary: "Chubb remained unsigned as training camps opened after losing Houston's lead role during the 2025 season.",
        role_tags: ["unsigned", "declining_role"], signal: "negative"
      }]
    },
    "12471": {
      injury_episodes: [{
        injury_id: "12471-2026-hamstring", body_part: "hamstring", start_date: "2026-08-09", end_date: null, games_missed: null, severity: "moderate",
        source_name: "CBS Sports", source_url: "https://www.cbssports.com/fantasy/football/news/colts-dj-giddens-nursing-hamstring-injury/", source_published_at: "2026-08-09T00:00:00Z"
      }],
      usage_samples: [],
      role_reports: [{
        report_id: "12471-2026-08-09-cbs", published_at: "2026-08-09T00:00:00Z", source_name: "CBS Sports",
        source_url: "https://www.cbssports.com/fantasy/football/news/colts-dj-giddens-nursing-hamstring-injury/", source_type: "news_report",
        summary: "Giddens entered camp as Indianapolis' second running back but missed practice with a hamstring injury, opening backup reps for competitors.",
        role_tags: ["direct_backup"], signal: "negative"
      }]
    },
    "11199": {
      injury_episodes: [], usage_samples: [],
      role_reports: [{
        report_id: "11199-2026-08-06-arrowhead-pride", published_at: "2026-08-06T00:00:00Z", source_name: "Arrowhead Pride",
        source_url: "https://www.arrowheadpride.com/kansas-city-chiefs-training-camp/206998/emari-demarcado-embracing-niche-league-chiefs", source_type: "beat_report",
        summary: "Demercado drew praise for pass protection, decisiveness, route ability, and experience while competing for Kansas City's third-down role.",
        role_tags: ["passing_down", "pass_protection"], signal: "positive"
      }]
    },
    "6039": {
      injury_episodes: [], usage_samples: [],
      role_reports: [{
        report_id: "6039-2026-08-13-espn", published_at: "2026-08-13T00:00:00Z", source_name: "ESPN",
        source_url: "https://www.espn.com/nfl/story/_/id/49574464/2026-nfl-training-camp-updates-buzz-notes-news-fantasy-football", source_type: "camp_report",
        summary: "Buffalo continued to value Johnson as a third-down receiver, but he pulled up with an unspecified injury during stadium practice.",
        role_tags: ["passing_down"], signal: "negative"
      }]
    }
  }
};

export default PLAYER_INTELLIGENCE;
