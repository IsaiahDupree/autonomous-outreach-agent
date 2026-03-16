Research a job or topic using Perplexity APIs via the MCP server.

If the user provides a job title/description, use the `research_job` MCP tool to get a technical brief.
If the user provides a general topic, use `sonar_search` for quick lookups or `sonar_pro_search` for deeper research.
If the user asks for academic/scholarly research, use `academic_search`.
If the user asks for comprehensive/deep research, use `deep_research`.
If the user just wants raw links/URLs, use `web_search`.

For job research, format the output as:
- Summary of what the job needs
- Key technologies and best practices
- Recommended implementation approach
- Pitfalls to watch for
- Industry context
- Source citations

If the Perplexity MCP tools are not available, fall back to the REST API:
`curl -s -X POST http://localhost:4000/api/upwork/research -H "Content-Type: application/json" -d '{"title":"...","description":"..."}'`

Arguments: $ARGUMENTS
