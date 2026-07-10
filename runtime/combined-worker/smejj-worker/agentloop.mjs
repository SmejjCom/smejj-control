import crypto from "node:crypto";
import { readWorkspaceFile, runAllowed, writeWorkspaceFile } from "./sandbox.mjs";
import {
  applyUnifiedDiff,
  buildRepositorySummary,
  commitVerifiedChanges,
  prepareRepository,
  repositoryDiff,
  repositoryStatus
} from "./repository.mjs";
import { requestModelAction, validateWorkerSession } from "./model-client.mjs";
import { runVerification } from "./verification.mjs";
import { runBrowserVerification } from "./browser-verification.mjs";
import { publishDraftPullRequest } from "./publish.mjs";

const MAX_ITERATIONS = 25;
const MAX_TOOL_RESULT_CHARS = 24_000;

export async function runCodingJob(payload = {}, dependencies = {}) {
  const deadlineMs = Date.now() + runtimeLimitMs();
  const signal = dependencies.signal || null;
  throwIfAborted(signal);
  const task = String(payload.task || "").trim();
  const jobId = safeJobId(payload.jobId);
  if (!task) return failed("missing_task", jobId);

  const requestAction = dependencies.requestAction || requestModelAction;
  const validateSession = dependencies.validateSession || validateWorkerSession;
  const prepare = dependencies.prepareRepository || prepareRepository;
  const verify = dependencies.verify || runVerification;
  const browserCheck = dependencies.browserCheck || runBrowserVerification;
  const controlOrigin = process.env.SMEJJ_CONTROL_ORIGIN || payload.controlOrigin;
  const workerToken = payload.workerToken || "";
  if (dependencies.skipTokenValidation !== true) {
    await validateSession({ controlOrigin, token: workerToken, jobId, signal });
  }

  const repository = payload.repository
    ? { ...payload.repository, token: process.env.SMEJJ_GITHUB_TOKEN || "" }
    : payload.repository;
  const workspace = await prepare({ ...payload, repository }, { signal });
  const iterations = [];
  let verification = null;
  let browser = { required: false, ok: true, checks: [], screenshots: [] };
  let finished = false;
  let finishSummary = "";
  try {
    throwIfAborted(signal);
    if (payload.approvedDiff) await applyUnifiedDiff(workspace.root, payload.approvedDiff);
    else if (payload.followUpContext?.diff) {
      const followUpDiff = verifiedFollowUpDiff(payload.followUpContext, workspace.repository);
      await applyUnifiedDiff(workspace.root, followUpDiff);
      iterations.push({
        n: iterations.length + 1,
        action: "apply_follow_up_diff",
        ok: true,
        sourceJobId: payload.followUpContext.parentJobId,
        diffSha256: payload.followUpContext.diffSha256
      });
    }
    await applyExplicitEdits(workspace.root, payload.edits, iterations, signal);
    await runExplicitCommands(workspace.root, payload.commands, payload.allowedScripts, iterations, signal);

    throwIfAborted(signal);
    const repositorySummary = await buildRepositorySummary(workspace.root);
    const messages = initialMessages(task, repositorySummary, payload.previousErrors || [], followUpPromptContext(payload.followUpContext));
    const maxIterations = clampIterations(payload.maxIterations);

    if (payload.modelMode !== "disabled") {
      for (let index = 1; index <= maxIterations; index += 1) {
        throwIfAborted(signal);
        if (Date.now() >= deadlineMs) {
          iterations.push({ n: index, action: "stop", ok: false, error: "job_deadline_exceeded" });
          break;
        }
        const response = await requestAction({ controlOrigin, token: workerToken, jobId, messages, signal });
        const toolCall = normalizeToolCall(response.toolCall);
        messages.push(response.assistant || assistantMessage(toolCall));
        const result = await executeTool(workspace.root, toolCall, repositorySummary.packageScripts, signal);
        iterations.push({ n: index, action: toolCall.name, detail: safeDetail(toolCall.arguments), usage: response.usage || null, ...result.log });

        if (toolCall.name === "finish") {
          verification = await verify(workspace.root, { ...(payload.verification || {}), deadlineMs, signal });
          browser = Date.now() < deadlineMs
            ? await browserCheck(workspace.root, payload.preview || {}, { signal })
            : deadlineBrowserResult(payload.preview);
          const passed = verification.ok && browser.ok;
          messages.push(toolResultMessage(toolCall.id, { ok: passed, verification, browser: browserSummary(browser) }));
          if (passed) {
            finished = true;
            finishSummary = String(toolCall.arguments.summary || "Verified change completed").slice(0, 2_000);
            break;
          }
          continue;
        }
        messages.push(toolResultMessage(toolCall.id, result.modelResult));
      }
    } else {
      finished = true;
      finishSummary = "Explicit edits verified without model inference.";
    }

    throwIfAborted(signal);
    verification ||= await verify(workspace.root, { ...(payload.verification || {}), deadlineMs, signal });
    if (!browser.required) {
      browser = Date.now() < deadlineMs
        ? await browserCheck(workspace.root, payload.preview || {}, { signal })
        : deadlineBrowserResult(payload.preview);
    }
    throwIfAborted(signal);
    const diff = await repositoryDiff(workspace.root);
    const status = await repositoryStatus(workspace.root);
    const pipelinePassed = verification.ok && browser.ok;
    const codeVerified = finished && pipelinePassed;
    const diffSha256 = sha256(diff);
    const publicationRequested = payload.approval?.createDraftPr === true;
    const approvalMatches = publicationRequested && payload.approval?.approvedDiffSha256 === diffSha256;
    const commit = codeVerified ? await commitVerifiedChanges(workspace.root, `smejj.com agent: ${task.slice(0, 100)}`) : { changed: false, commit: workspace.repository.baseCommit };
    const publish = codeVerified && (!publicationRequested || approvalMatches)
      ? await publishDraftPullRequest(workspace.root, workspace.repository, {
          approved: publicationRequested,
          approvedDiffSha256: payload.approval?.approvedDiffSha256,
          actualDiffSha256: diffSha256,
          token: process.env.SMEJJ_GITHUB_TOKEN,
          signal,
          title: payload.approval?.title || task,
          body: verifierReport({ ok: codeVerified, verification, browser, diffSha256 })
        })
      : { ok: false, status: publicationRequested ? "approval_hash_mismatch" : "blocked_by_verification", mergePerformed: false };
    const publicationPassed = !publicationRequested || (publish.ok === true && publish.status === "draft_pr_created");
    const ok = codeVerified && publicationPassed;

    return {
      ok,
      jobId,
      status: ok ? "verified" : "failed",
      errors: collectErrors({ finished, verification, browser, publicationRequested, publish }),
      iterations,
      repository: {
        ...workspace.repository,
        resultCommit: commit.commit,
        changed: commit.changed,
        workingTreeStatus: status
      },
      diff,
      diffSha256,
      verification,
      browser,
      approval: {
        required: true,
        status: approvalMatches ? "human_approved" : "pending",
        bindsToDiffSha256: diffSha256,
        publish,
        mergePerformed: false
      },
      rollback: {
        baseCommit: workspace.repository.baseCommit,
        instruction: `Reset the isolated branch to ${workspace.repository.baseCommit}; main was not changed.`
      },
      finalReport: finishSummary || (ok ? "Verified change completed." : "Verification did not pass."),
      memoryUpdate: ok && !publicationRequested ? {
        ok: true,
        learn: true,
        source: "verified-smejj.com-worker",
        sourceJobId: jobId,
        diffSha256,
        summary: finishSummary
      } : null
    };
  } finally {
    await workspace.cleanup();
  }
}

async function executeTool(root, toolCall, allowedScripts, signal) {
  throwIfAborted(signal);
  const args = toolCall.arguments;
  if (toolCall.name === "read_file") {
    const file = await readWorkspaceFile(root, args.path, { startLine: args.startLine, endLine: args.endLine });
    return { modelResult: file, log: { path: file.path, ok: true, lineCount: file.endLine - file.startLine + 1 } };
  }
  if (toolCall.name === "write_file") {
    const path = await writeWorkspaceFile(root, args.path, args.content);
    return { modelResult: { ok: true, path, bytes: Buffer.byteLength(String(args.content || "")) }, log: { path, ok: true } };
  }
  if (toolCall.name === "run_cmd") {
    const result = await runAllowed(root, args.command, { allowedScripts, timeoutMs: 300_000, signal });
    return {
      modelResult: { ok: result.ok, command: result.command, code: result.code, stdout: cap(result.stdout), stderr: cap(result.stderr) },
      log: { command: result.command, code: result.code, ok: result.ok, stdout: cap(result.stdout), stderr: cap(result.stderr) }
    };
  }
  if (toolCall.name === "finish") return { modelResult: { ok: true }, log: { ok: true, summary: String(args.summary || "").slice(0, 500) } };
  throw new Error("unsupported_tool_call");
}

async function applyExplicitEdits(root, edits, iterations, signal) {
  for (const edit of Array.isArray(edits) ? edits.slice(0, 100) : []) {
    throwIfAborted(signal);
    const path = await writeWorkspaceFile(root, edit.path, edit.content);
    iterations.push({ n: iterations.length + 1, action: "write_file", path, ok: true, source: "explicit" });
  }
}

async function runExplicitCommands(root, commands, allowedScripts, iterations, signal) {
  for (const command of Array.isArray(commands) ? commands.slice(0, 20) : []) {
    throwIfAborted(signal);
    const result = await runAllowed(root, command, { allowedScripts: allowedScripts || [], timeoutMs: 300_000, signal });
    iterations.push({ n: iterations.length + 1, action: "run_cmd", command: result.command, code: result.code, ok: result.ok, stdout: cap(result.stdout), stderr: cap(result.stderr), source: "explicit" });
    if (!result.ok) throw new Error(`explicit_command_failed:${result.command}:${result.stderr || result.stdout}`);
  }
}

function initialMessages(task, repositorySummary, previousErrors, followUpContext) {
  return [
    {
      role: "system",
      content: [
        "You are the coding planner for the stateless smejj.com worker.",
        "Use exactly one provided tool per response. Read before writing.",
        "Keep changes scoped, never access secrets, and call finish only when the change is ready for verification.",
        "Commands are argument arrays and must pass the worker allowlist. Never request shell syntax.",
        "The built-in rg command supports --files, line numbers, file-only results, ignore-case, fixed strings, and repository-relative targets."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({ task, repository: repositorySummary, previousErrors: previousErrors.slice(0, 20), followUpContext })
    }
  ];
}

function normalizeToolCall(value = {}) {
  const name = String(value.name || "");
  if (!new Set(["read_file", "write_file", "run_cmd", "finish"]).has(name)) throw new Error("model_tool_not_allowed");
  const args = value.arguments && typeof value.arguments === "object" ? value.arguments : {};
  if ((name === "read_file" || name === "write_file") && !args.path) throw new Error("model_tool_path_missing");
  if (name === "write_file" && typeof args.content !== "string") throw new Error("model_tool_content_missing");
  if (name === "run_cmd" && !Array.isArray(args.command)) throw new Error("model_tool_command_invalid");
  return { id: String(value.id || `call_${crypto.randomUUID()}`), name, arguments: args };
}

function assistantMessage(toolCall) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }]
  };
}

function toolResultMessage(toolCallId, value) {
  return { role: "tool", tool_call_id: toolCallId, content: cap(JSON.stringify(value)) };
}

function collectErrors({ finished, verification, browser, publicationRequested, publish }) {
  return [
    ...(!finished ? [{ source: "agent", detail: "model_iteration_limit_or_no_finish" }] : []),
    ...(verification?.errors || []),
    ...(!browser.ok ? [{ source: "browser", detail: browser.error || "browser_verification_failed" }] : []),
    ...(publicationRequested && publish?.status !== "draft_pr_created" ? [{ source: "publish", detail: publish?.error || publish?.status || "draft_pr_failed" }] : [])
  ];
}

function verifierReport({ ok, verification, browser, diffSha256 }) {
  return [
    `Verification: ${ok ? "passed" : "failed"}`,
    `Diff SHA-256: ${diffSha256}`,
    `Checks: ${(verification.checks || []).map((check) => `${check.stage}=${check.ok ? "ok" : "failed"}`).join(", ")}`,
    `Browser: ${browser.required ? (browser.ok ? "passed" : "failed") : "not-required"}`,
    "No merge was performed. Human review remains required."
  ].join("\n");
}

function browserSummary(browser) {
  return { required: browser.required, ok: browser.ok, error: browser.error, checks: browser.checks };
}

function safeDetail(value) {
  const copy = { ...(value || {}) };
  if (typeof copy.content === "string") copy.content = `<${Buffer.byteLength(copy.content)} bytes>`;
  return copy;
}

function safeJobId(value) {
  const jobId = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,120}$/.test(jobId)) throw new Error("job_id_invalid");
  return jobId;
}

function clampIterations(value) {
  const number = Number(value || MAX_ITERATIONS);
  return Math.min(MAX_ITERATIONS, Math.max(1, Number.isFinite(number) ? number : MAX_ITERATIONS));
}

function runtimeLimitMs() {
  const value = Number(process.env.SMEJJ_WORKER_MAX_RUNTIME_MS || 55 * 60_000);
  return Math.min(60 * 60_000, Math.max(5 * 60_000, Number.isFinite(value) ? value : 55 * 60_000));
}

function verifiedFollowUpDiff(context, repository) {
  const diff = String(context?.diff || "");
  const expectedHash = String(context?.diffSha256 || "");
  const sourceRepository = context?.repository || {};
  if (!diff || !/^[a-f0-9]{64}$/.test(expectedHash) || sha256(diff) !== expectedHash) {
    throw new Error("follow_up_diff_hash_mismatch");
  }
  if (!repository?.url || repository.url !== sourceRepository.url || repository.baseRef !== sourceRepository.baseRef) {
    throw new Error("follow_up_repository_mismatch");
  }
  return diff;
}

function followUpPromptContext(context) {
  if (!context) return null;
  return {
    parentJobId: context.parentJobId,
    diffSha256: context.diffSha256,
    finalReport: String(context.finalReport || "").slice(0, 4_000),
    repository: context.repository || null,
    appliedToWorkspace: Boolean(context.diff)
  };
}

function deadlineBrowserResult(preview = {}) {
  return preview.required === true
    ? { required: true, ok: false, error: "job_deadline_exceeded", checks: [], screenshots: [] }
    : { required: false, ok: true, checks: [], screenshots: [] };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function cap(value) {
  const text = String(value || "");
  return text.length > MAX_TOOL_RESULT_CHARS ? text.slice(-MAX_TOOL_RESULT_CHARS) : text;
}

function failed(reason, jobId = "") {
  return { ok: false, jobId, status: "failed", errors: [{ source: "worker", detail: reason }], iterations: [], memoryUpdate: null };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error("job_cancelled");
}
