Add a new search keyword or ICP keyword to the scoring pipeline.

Arguments: $ARGUMENTS — the keyword to add and where (search, strong, weak, exclude)

Examples:
- `/add-keyword "vue.js developer" strong` — adds to ICP strong keywords
- `/add-keyword "blockchain" exclude` — adds to hard excludes
- `/add-keyword "AI consultant" search` — adds to Upwork search keywords

Steps:

1. Parse the keyword and target from arguments
2. Based on target:
   - **search**: Add to `UPWORK_KEYWORDS` in `src/index.ts`
   - **strong**: Add to `ICP_STRONG_KEYWORDS` in `src/Agent/scorer.ts`
   - **weak**: Add to `ICP_WEAK_KEYWORDS` in `src/Agent/scorer.ts`
   - **exclude**: Add to `HARD_EXCLUDES` in `src/Agent/scorer.ts`
3. Run `npm test` to verify scorer tests still pass
4. Report what was added and where

If no target specified, suggest the best placement based on the keyword.
