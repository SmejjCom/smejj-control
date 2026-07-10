import { gitAuthEnvironment } from "./repository.mjs";
import { runTrusted } from "./sandbox.mjs";

export async function publishDraftPullRequest(root, repository, options = {}) {
  if (options.approved !== true) {
    return { ok: true, status: "awaiting_human_approval", draftPullRequest: null, mergePerformed: false };
  }
  if (repository.publishMode !== "draft-pr") return { ok: false, status: "blocked", error: "repository_publish_mode_forbids_pr", mergePerformed: false };
  if (!options.approvedDiffSha256 || options.approvedDiffSha256 !== options.actualDiffSha256) {
    return { ok: false, status: "blocked", error: "approved_diff_hash_mismatch", mergePerformed: false };
  }
  const token = String(options.token || "").trim();
  if (!token) return { ok: false, status: "blocked", error: "github_publish_token_missing", mergePerformed: false };
  const target = githubTarget(repository.url);
  const branch = repository.branch;
  const push = await runTrusted(root, ["git", "push", "origin", `HEAD:refs/heads/${branch}`], {
    timeoutMs: 120_000,
    env: gitAuthEnvironment(token),
    signal: options.signal || null
  });
  if (!push.ok) return { ok: false, status: "blocked", error: `git_push_failed:${push.stderr}`, mergePerformed: false };

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`https://api.github.com/repos/${target.owner}/${target.repo}/pulls`, {
    method: "POST",
    signal: options.signal || null,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      title: String(options.title || "Verified smejj.com agent change").slice(0, 180),
      body: String(options.body || "Verified by the smejj.com worker pipeline. Merge requires human review.").slice(0, 8_000),
      head: branch,
      base: repository.baseRef,
      draft: true
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, status: "blocked", error: `pull_request_failed:${response.status}`, mergePerformed: false };
  return {
    ok: true,
    status: "draft_pr_created",
    draftPullRequest: { number: data.number, url: data.html_url, draft: true },
    mergePerformed: false,
    humanApprovalRequiredForMerge: true
  };
}

function githubTarget(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (url.hostname !== "github.com" || !match) throw new Error("github_repository_invalid");
  return { owner: match[1], repo: match[2] };
}
