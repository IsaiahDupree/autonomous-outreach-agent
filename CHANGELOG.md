# Changelog


## 2026-05-12 — 5e0554e

feat(dashboard): KPI/Sparkline/ScoreChip components; AI fallback service

Files changed:
   dashboard/src/components/KPI.tsx       |  61 +++++++++++
   dashboard/src/components/KPIStrip.tsx  |  74 +++++++++++++
   dashboard/src/components/ScoreChip.tsx |  40 +++++++
   dashboard/src/components/Sparkline.tsx |  36 +++++++
   dashboard/src/pages/Queue.tsx          |   9 +-
   docs/REQUIREMENTS.md                   |  99 +++++++++++++++++
   src/client/Upwork.ts                   |   9 +-
   src/secret/index.ts                    |   4 +
   src/services/ai-fallback.ts            | 192 ++++++++++++++++++++++-----------
   tests/agent.test.ts                    |   2 +
   tests/ai-fallback.test.ts              |  98 ++++++++++++++++-
   11 files changed, 554 insertions(+), 70 deletions(-)
