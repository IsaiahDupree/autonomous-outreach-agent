Generate content briefs from Upwork market analytics. Arguments: $ARGUMENTS

Based on the argument:

**"podcast"** or no argument — Generate a podcast episode brief:
`curl -s -X POST http://localhost:3500/api/content/brief -H "Content-Type: application/json" -d '{"type":"podcast_episode"}' 2>/dev/null || echo "Server not running"`

**"youtube"** — Generate a YouTube video script:
`curl -s -X POST http://localhost:3500/api/content/brief -H "Content-Type: application/json" -d '{"type":"youtube_script"}' 2>/dev/null || echo "Server not running"`

**"list"** — List recent content briefs:
`curl -s http://localhost:3500/api/content/briefs 2>/dev/null || echo "Server not running"`

Present the result with title, word count, and a preview of the content.
