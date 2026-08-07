# M2 Mutation Security Gate

Status: **M2_MUTATION_GATE_PASS**

Reviewed against SPEC FR-M / FR-S before Phase B mutation code was enabled.

## Evidence

| # | Requirement | Evidence | Result |
|---|-------------|----------|--------|
| 1 | Mutation always uses acting-user PAT/OAuth | `MrMutationService.actingWriteClient` loads `GitLabConnection` by `{ userId, gitlabInstanceId, status: active }` then `credentials.getAccessToken(connection.id)` → `createGitLabWriteClient({ auth: createPatAuthAdapter(() => pat) })`. No other credential source. | PASS |
| 2 | No admin / other-user / shared credential fallback | Source scan of `mr-mutations.ts` / `mr-workspace.ts` — no `adminPat`, `sharedPat`, `serviceAccount`, impersonation. Fail closed via `ConnectionPolicyError` when no active connection. | PASS |
| 3 | Authz re-checked on mutation | Every `comment` / `approve` / `merge` starts with `workspace.getDetail(userId, ref)` which re-runs `authorizedProjectIds` and returns `not_found` if unauthorized. | PASS |
| 4 | Project/MR must belong to current user scope | List filters authorized projects first; detail/mutation deny outside enable ∩ membership. Unauthorized direct URL → `not_found` (no existence leak). | PASS |
| 5 | CSRF on mutations | `/api/merge-requests/{comment,approve,merge}` call `assertOrigin` + `assertCsrf` before `requireUser` / mutation. Confirm dialogs include CSRF hidden field. | PASS |
| 6 | Audit excludes PAT and diff | Actions `mr_comment` / `mr_approve` / `mr_merge` write meta: actor, project, iid, SHA, result, safe category. `AuditWriter` forbids `pat`, `token`, `authorization`, `private-token`, `diff`, `fulldiff`, `requestbody`. Diff never passed to audit. | PASS |
| 7 | Head SHA live before approve/merge | Approve/merge re-load detail live; compare `reviewedHeadSha` vs `currentHeadSha`; stale → block + audit failure. | PASS |
| 8 | No bypass of GitLab protected branch / approval / pipeline | Merge calls GitLab `PUT .../merge` with acting-user PAT after local `evaluateMergeSafety` gate. GitLab 403/409 remain failures (never remapped to success). Local gate checks conflicts, pipeline, approvals, draft, permission, confirmation. | PASS |

## Notes

- Write verbs live only in `packages/gitlab-client/src/write-client.ts`; read client remains GET-only.
- Mutation HTTP retries only on HTTP 429; transport errors after send fail closed (no double-submit).
- Real GitLab mutation smoke: **REAL_MUTATION_NOT_RUN** until user approves an explicit test target.
