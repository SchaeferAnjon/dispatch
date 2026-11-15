# Evidence levels and release end states

## Risk decides how much evidence is needed

| Claim | Minimum evidence |
|---|---|
| "The doc links work" | the project's own doc-link or index check, or each link's target exists |
| "The rules share one source" | realpath / readlink / import plus the platform's real load order |
| "The code does X" | code, schema, configuration and related tests on the current target branch |
| "The PR is done" | PR state=merged plus the merge commit; it does not imply deployed |
| "Deployed" | the deploy marker or release points at the target commit and the service is active |
| "The person sees the new version" | a real response from the canonical user URL or API, compared with origin or cache when needed |
| "Safe to clean up" | merged + production contains the change + knowledge receipt + lane clean + no file whose only copy is unmerged |
| "Cleanup approved" | the full result was reported to the person + the person explicitly confirmed cleanup after that report + the receipt the local rules ask for |
| "The whole project is clean" | every applicable surface in the project verified; warnings, pending and out-of-scope listed separately |

Intuition about the code, old memory, commit messages and cache-buster URLs are leads only; none of them alone proves the production end state.

## Truth matrix

For each finding record at least:

```text
topic: <the fact>
authority: <the current authoritative source>
code: verified-current | stale | n/a
runtime: verified-current | stale | unverified | n/a
docs: verified-current | stale | changed
rules: verified-current | stale | changed | n/a
memory: verified-current | stale | generated-read-only | changed | n/a
action: <proposed change; after phase 2, what was done or why not>
verification: <command, page or gate>
```

The person does not need to see the whole matrix, but the final summary must keep every state that is not closed.

## Release state machine

```text
implemented
  -> locally verified
  -> pushed / PR opened
  -> CI + required backtest/visual review passed
  -> merged
  -> deployed
  -> live verified
  -> knowledge closed + receipt recorded
  -> full result reported while evidence is preserved
  -> user explicitly approved cleanup after the report
  -> workspace cleaned
  -> post-cleanup audit passed
  -> cleanup result appended
```

A skipped state needs a reason the project rules allow. Wherever it fails, report that state; "basically done" never covers it.

## Caches and products with several surfaces

When what the person sees passes through a CDN, an edge cache, a search index, asynchronous workers or several clients, identify at least:

- whether origin has the new content;
- whether the canonical URL still serves an old cached copy;
- whether the API, pages, notifications and RSS share one data source;
- whether the deploy marker is written only after every asynchronous process has really switched;
- whether a cache-buster is only a diagnostic and not the person's real acceptance.

When only one surface was verified, state that limit in the conclusion.

## Gate before cleanup

Cleanup destroys the evidence for a retrospective and for the person's review, so the order is fixed:

1. verify the target work is merged and live;
2. sync docs, rules and the memory you may keep;
3. record the knowledge closeout receipt the project asks for;
4. preview the worktrees, branches, databases and artifacts to be deleted;
5. check dirty files and patch equivalence;
6. report the full result to the person and keep all of the above in place;
7. wait until the person, after reading the report, explicitly confirms cleanup;
8. record the confirmation the project asks for and do the authorized cleanup;
9. run the workspace audit again and append the cleanup result to the report.

A pre-authorization in the first request ("close it out and clean up", "delete it when done") does not replace step 7: the confirmation must come after the full report, because the person has to see the result before deciding whether to keep the evidence for more review.

A folder name, a branch's age or whether an agent session is closed never prove something may be deleted.

## When verification fails

- When the same failure happens a second time, stop retrying blindly; check the assumptions, the environment and the command names again.
- When a gate needs machine-readable metadata, add the right record and trigger a new event; do not bypass a fixable format problem with a manual confirmation.
- When the failure happens before anything was written to production, say clearly "production is not affected yet"; after traffic switched, first confirm the active release and the rollback boundary.
- Anything unverified stays `pending`; do not downgrade it to a warning to make the summary look better.
