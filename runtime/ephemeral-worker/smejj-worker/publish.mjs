/**
 * Draft-PR publication is deliberately unavailable inside the coding worker.
 *
 * Repository code and its child processes share the worker security boundary.
 * A future publisher therefore needs a separate trusted service that receives
 * only an attested patch, independently verifies the remote base and final PR,
 * and owns a short-lived repository-scoped credential. Until that boundary is
 * deployed and reviewed, this function must not perform network or Git writes.
 */
export async function publishDraftPullRequest(_root, _repository, options = {}) {
  if (options.approved !== true) {
    return {
      ok: true,
      status: "awaiting_human_approval",
      draftPullRequest: null,
      mergePerformed: false
    };
  }

  return {
    ok: false,
    status: "blocked",
    error: "trusted_publisher_boundary_required",
    draftPullRequest: null,
    mergePerformed: false
  };
}
