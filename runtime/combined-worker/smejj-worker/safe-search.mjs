import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isSensitiveRelativePath } from "./path-policy.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".pnpm-store", "dist", "build", "coverage", "model-files"]);
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 500_000;
const MAX_OUTPUT = 200_000;

export async function runSafeSearch(root, args = []) {
  const options = parseOptions(args);
  const files = [];
  for (const target of options.targets) await collectFiles(root, target, files);
  if (options.filesOnly) return result(files.join("\n") + (files.length ? "\n" : ""), options.label);

  let matcher;
  try {
    if (!options.fixed && unsafeRegex(options.pattern)) throw new Error("unsafe_search_pattern");
    matcher = options.fixed
      ? (line) => options.ignoreCase ? line.toLowerCase().includes(options.pattern.toLowerCase()) : line.includes(options.pattern)
      : (line) => new RegExp(options.pattern, options.ignoreCase ? "i" : "").test(line);
  } catch {
    return { ok: false, command: options.label, code: 2, stdout: "", stderr: "invalid_search_pattern" };
  }

  const output = [];
  let outputChars = 0;
  for (const file of files) {
    let content;
    try {
      content = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES || content.includes("\0")) continue;
    let matchedFile = false;
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!matcher(line)) continue;
      matchedFile = true;
      if (!options.filesWithMatches) {
        const entry = `${file}:${options.lineNumber ? `${index + 1}:` : ""}${line}`;
        output.push(entry);
        outputChars += entry.length + 1;
      }
      if (outputChars > MAX_OUTPUT) break;
    }
    if (matchedFile && options.filesWithMatches) {
      output.push(file);
      outputChars += file.length + 1;
    }
    if (outputChars > MAX_OUTPUT) break;
  }
  return result(output.join("\n") + (output.length ? "\n" : ""), options.label, output.length ? 0 : 1);
}

function parseOptions(args) {
  const options = { filesOnly: false, filesWithMatches: false, lineNumber: false, ignoreCase: false, fixed: false, pattern: "", targets: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "--files") options.filesOnly = true;
    else if (arg === "-n" || arg === "--line-number") options.lineNumber = true;
    else if (arg === "-l" || arg === "--files-with-matches") options.filesWithMatches = true;
    else if (arg === "-i" || arg === "--ignore-case") options.ignoreCase = true;
    else if (arg === "-F" || arg === "--fixed-strings") options.fixed = true;
    else if (arg === "--hidden") continue;
    else if (arg.startsWith("-")) throw new Error("unsupported_search_option");
    else if (!options.filesOnly && !options.pattern) options.pattern = arg;
    else options.targets.push(arg);
  }
  if (!options.filesOnly && !options.pattern) throw new Error("search_pattern_required");
  options.targets = options.targets.length ? options.targets : ["."];
  options.label = ["rg", ...args].join(" ");
  return options;
}

async function collectFiles(root, target, output) {
  const relative = normalizeTarget(target);
  if (relative !== "." && isSensitiveRelativePath(relative)) return;
  const absolute = path.join(root, relative);
  let info;
  try { info = await lstat(absolute); } catch { return; }
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    output.push(relative);
    return;
  }
  if (!info.isDirectory()) return;
  let entries;
  try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= MAX_FILES || entry.isSymbolicLink()) break;
    const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
    if (isSensitiveRelativePath(child)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(root, child, output);
    } else if (entry.isFile()) output.push(child);
  }
}

function unsafeRegex(pattern) {
  const value = String(pattern || "");
  return value.length > 120 || /[(){}\\]/.test(value) || /[*+?].*[*+?]/.test(value);
}

function normalizeTarget(value) {
  const normalized = path.posix.normalize(String(value || ".").replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) throw new Error("unsafe_search_target");
  return normalized || ".";
}

function result(stdout, command, code = 0) {
  const capped = stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) : stdout;
  return { ok: code === 0, command, code, stdout: capped, stderr: "" };
}
