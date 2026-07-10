const REQUIRED_STAGES = Object.freeze([
  "build",
  "typecheck",
  "lint",
  "security",
  "repository-hygiene",
  "security-scan"
]);

export function evaluateMemoryEligibility(outcome = {}) {
  const reasons = [];
  const candidate = outcome.memoryUpdate || {};
  if (outcome.ok !== true || candidate.learn !== true) reasons.push("verified_memory_proposal_missing");
  requireEvidence(candidate, "providerRightsCleared", "providerRightsEvidenceId", "memory_provider_rights_not_cleared", reasons);
  requireEvidence(candidate, "privacySanitized", "privacyEvidenceId", "memory_privacy_not_cleared", reasons);
  requireEvidence(candidate, "repositoryRightsCleared", "repositoryRightsEvidenceId", "memory_repository_rights_not_cleared", reasons);

  const verification = outcome.verification || {};
  if (verification.ok !== true || !Array.isArray(verification.checks)) {
    reasons.push("memory_verification_missing");
  } else {
    const passed = new Set(verification.checks
      .filter((check) => check?.required === true && check?.ok === true && check?.skipped !== true)
      .map((check) => check.stage));
    for (const stage of REQUIRED_STAGES) {
      if (!passed.has(stage)) reasons.push(`memory_quality_${stage}_missing`);
    }
    const testsPassed = passed.has("tests") || (passed.has("unit") && passed.has("integration"));
    if (!testsPassed) reasons.push("memory_quality_tests_missing");
  }

  if (outcome.browser?.required === true && outcome.browser?.ok !== true) reasons.push("memory_browser_evidence_missing");
  if (!String(outcome.diff || "").trim() || !/^[a-f0-9]{64}$/.test(String(outcome.diffSha256 || ""))) {
    reasons.push("memory_diff_evidence_missing");
  }
  if (!String(outcome.rollback?.baseCommit || "").trim()) reasons.push("memory_rollback_evidence_missing");

  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function requireEvidence(candidate, flag, evidenceKey, reason, reasons) {
  if (candidate?.[flag] !== true || !safeEvidenceId(candidate?.[evidenceKey])) reasons.push(reason);
}

function safeEvidenceId(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{5,240}$/.test(String(value || ""));
}
