# Advisory PR build-size report

Status: implemented by `.github/workflows/pr-build-size.yml` and
`.github/workflows/pr-build-size-comment.yml`. This document does not authorize
release, publishing, or deployment work.

Related discussion: <https://github.com/nyblnet/bento/discussions/178>

## Goal

Add one best-effort pull-request comment showing how the built single-file
shells changed relative to the PR's base commit.

This is a quality-of-life aid for good-faith contributors. It is not a merge
gate, an attestation, or a guarantee that a PR author could not fabricate the
reported values.

## Non-goals

- Do not fail a PR because its build grows.
- Do not replace the existing shell-size ceilings.
- Do not defend against a PR deliberately fabricating its measurements.
- Do not report build failures, cancellations, missing artifacts, or every
  workflow edge case in the PR comment.
- Do not guarantee that the comment always describes the newest workflow run.
  The displayed base and head SHAs make its measurement point explicit.
- Do not add a bot account, personal access token, external service, database,
  historical dashboard, release step, signing step, or deployment step.
- Do not block, delay, reopen, close, merge, label, or otherwise change a PR.

## Security boundary

Code from a PR is untrusted even though the reported number is advisory.

1. A job that checks out, installs, or executes PR code receives no secrets and
   no write-capable token.
2. A job with permission to comment never checks out or executes PR code,
   restores a PR-controlled cache, or invokes a script supplied by the PR.
3. Data crossing between the jobs is parsed as untrusted data. It never becomes
   shell code, JavaScript source, a file path, arbitrary Markdown, or an
   unverified mutation target.
4. The privileged workflow can only create or update its fixed-format advisory
   comment. It does not push code or change PR state.

Do not use `pull_request_target` to build the PR. Use GitHub's recommended
privilege separation: an unprivileged `pull_request` workflow measures, then a
trusted `workflow_run` workflow comments.

## Proposed design

### 1. Unprivileged measurement workflow

Trigger on the exact `pull_request` activity types `opened`, `reopened`,
`synchronize`, and `edited`. For `edited`, run only when
`github.event.changes.base` is present, so base retargeting is measured without
rebuilding for unrelated title or body edits. Declare only `contents: read` and
reference no repository secrets.

On one GitHub-hosted runner with a pinned Node version and a 20-minute job
timeout:

1. Check out the exact base SHA with `persist-credentials: false`.
2. Install and build the current single-file apps.
3. Record the generated HTML byte counts outside the checkout directory.
4. Clean the checkout.
5. Check out the exact head SHA with `persist-credentials: false`.
6. Repeat the installs, builds, and measurements.
7. If every build succeeds, use a full-SHA-pinned
   `actions/upload-artifact` action to upload one small, fixed-name JSON
   artifact with short retention.

Build the base first and measure both commits on the same runner to reduce
environmental noise. Measure the final `.bento.html` files directly; do not add
a second gzip metric.

The initial report covers:

- `bento/slides`
- `bento/spaces`
- `bento/dash`

The versioned artifact contains only:

- the integer PR number as an untrusted, read-only lookup hint;
- the measured base and head commit SHAs;
- fixed, allowlisted app identifiers;
- non-negative integer `baseBytes` and `headBytes` values.

If a build fails, the measurement workflow fails and produces no report
artifact. That is an accepted best-effort outcome.

### 2. Privileged comment workflow

Trigger with `workflow_run` when the named measurement workflow completes, but
continue only when its original event was `pull_request` and its conclusion was
`success`.

Grant only:

- `actions: read`, to download that exact run's artifact;
- `pull-requests: write`, to create or update the advisory comment.

Set a 5-minute timeout on the commenter job.

The workflow file lives on the default branch. The workflow must not check out
the repository, install dependencies, restore caches, build anything, or
execute artifact contents.

Serialize commenter runs using the head-repository ID and head branch from
GitHub's `workflow_run` metadata, never the artifact's untrusted PR-number
value. Set `cancel-in-progress: false`; this only sequences advisory comment
writes and does not delay or alter PR operations. It may conservatively
serialize multiple comments originating from the same fork branch, which is
acceptable for this best-effort feature. If the required head metadata is
missing, exit successfully without changing anything. Do not depend on
`workflow_run.pull_requests` being populated.

It should:

1. Take the repository, workflow-run ID, head-repository ID, head branch, and
   head SHA from GitHub's event metadata.
2. Find exactly one non-expired artifact with the expected name from that exact
   run. Require a small size limit, such as 16 KiB.
3. Use a full-SHA-pinned `actions/download-artifact` action to download it into
   the runner's temporary directory and read only the expected JSON file, also
   capped at 16 KiB.
4. Validate the schema version, integer PR number, commit SHAs, complete app
   allowlist, and non-negative integer sizes.
5. Use the artifact PR number only for a read-only API lookup. Before any write,
   continue only when the fetched PR targets this repository, its head-
   repository ID and head branch match the workflow-run metadata, its current
   head SHA matches both the artifact and workflow run, and its current base SHA
   matches the artifact.
6. If the PR is closed or merged, exit successfully without changing anything.
   This observes PR state but never constrains normal PR operations.
7. Generate the comment from a fixed Markdown template. Only validated numbers,
   formatted allowlisted app names, safely HTML-escaped branch names from the
   revalidated PR, and a workflow-generated UTC timestamp enter the template.
8. Paginate PR comments and locate the exact
   `<!-- bento-build-size-report -->` marker on a comment authored by
   `github-actions[bot]`. Update that comment, or create it if none exists.

Any missing, duplicate, malformed, oversized, stale, or otherwise unexpected
input causes a successful no-op. Same-PR commenter runs are serialized; a later
valid run may overwrite the earlier report because this report is advisory.

### 3. Comment format

Use a small table:

| app | base | PR | change |
| --- | ---: | ---: | ---: |
| `bento/slides` | 560.0 KiB | 561.2 KiB | +1.2 KiB (+0.21%) |

Use one deterministic rounding rule, handle a zero-byte base without division
by zero, and show the safely escaped base and head branch names with their short
SHAs. End with the workflow-generated update time in ISO 8601 UTC format.

## Implementation constraints

- Use only GitHub-maintained actions. The only additions to the actions already
  used by the repository are `actions/upload-artifact` and
  `actions/download-artifact`, solely for the bounded JSON transfer.
- Pin every `uses:` reference to a verified full-length commit SHA and record
  its release tag in a same-line comment.
- Pass untrusted values through action inputs or environment variables. Never
  splice them into generated shell or JavaScript source.
- Keep the measurement and commenting workflows separate from the existing
  `CI` workflow so their permissions remain obvious.
- Add PR-scoped concurrency to cancel superseded measurement runs.
- Add separate commenter concurrency keyed by the workflow run's head-
  repository ID and head branch, with `cancel-in-progress: false`. This applies
  only to advisory comment publication, never to PR operations or existing CI.
- Keep the report informational and optional; it must not become a required
  status check.
- Bound the measurement and commenter jobs with 20-minute and 5-minute
  `timeout-minutes` values, respectively.
- Never add signing, release, publishing, or deployment permissions.

## Verification plan

1. Compare reported byte counts with local file sizes.
2. Test successful same-repository and fork PRs, including a fork run whose
   `workflow_run.pull_requests` array is empty.
3. Confirm `synchronize` and base-changing `edited` events run measurement,
   while unrelated `edited` events do not.
4. Confirm a later successful push normally updates the existing bot comment.
5. Confirm failed builds and missing, malformed, duplicate, oversized, or stale
   artifacts safely produce no comment update.
6. Confirm incorrect PR numbers, repositories, app identifiers, and base or head
   SHAs safely produce no comment update.
7. Confirm a closed or merged PR causes a successful no-op and no PR state
   change.
8. Confirm both checkouts use `persist-credentials: false`.
9. Inspect the effective permissions of both workflows.
10. Confirm the privileged workflow never checks out or executes PR-controlled
   content and receives no secrets.
11. Confirm every action is pinned to its intended upstream full commit SHA.
12. Trigger overlapping commenter runs for one PR and confirm they update one
    marker comment without affecting the PR or its existing checks.
13. Confirm the measurement and commenter jobs declare 20-minute and 5-minute
    timeouts, respectively.
14. Confirm existing CI, size ceilings, shell gates, and release behavior remain
    unchanged.

## Acceptance criteria

- A successful good-faith PR measurement produces one advisory comparison
  comment containing its measured base and head SHAs.
- Fork PR code runs without secrets or write permission.
- The commenting workflow runs no PR code and has only artifact-read and
  PR-comment permissions.
- Untrusted artifact values cannot cause a write to an unverified PR or become
  executable code or arbitrary Markdown.
- Exceptional, invalid, stale, failed, cancelled, or closed cases safely do
  nothing and never interfere with PR operations.
- The feature never blocks merging or changes release artifacts.
