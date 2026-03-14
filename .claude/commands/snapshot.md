Run a full analytics snapshot and save to Supabase. This makes all analytics data available to external apps (podcast, YouTube, dashboards).

Run:
`curl -s -X POST http://localhost:3500/api/analytics/snapshot 2>/dev/null || echo "Server not running"`

Report the result:
- Snapshot ID
- Total jobs analyzed
- Win rate
- Top niches
- Recommendations

Also mention that the data is now available via:
- `GET /api/analytics/latest` — Latest snapshot
- `GET /api/content/briefs` — Content briefs
- Direct Supabase tables: `analytics_snapshots`, `content_briefs`
