import crypto from "node:crypto";

const MAX_MODULE_BYTES = 1_000_000;
const MODULES = Object.freeze({
  idrive: Object.freeze({
    file: "bootstrap-idrive-control.mjs",
    sha256: "96f9db87bbc144d0984bb2667d08c8fe4f66182006dad42862e7ea876b17ac03"
  }),
  overlay: Object.freeze({
    file: "bootstrap-control-overlay.mjs",
    sha256: "1738982d5528568acb4f3ad5c2039f93b34ff7c2f9ce360216ede91715c4a3df"
  })
});

export async function runBootstrap({
  env = process.env,
  processEnv = process.env,
  fetchImpl = fetch,
  importModule = (url) => import(url),
  loadModule = loadVerifiedRuntimeModule,
  chdir = process.chdir,
  logger = console.log
} = {}) {
  const runtimeBase = controlRuntimeBase(env.SMEJJ_CONTROL_BOOTSTRAP_URL);
  const [idrive, overlay] = await Promise.all([
    loadModule(runtimeBase, "idrive", { fetchImpl, importModule }),
    loadModule(runtimeBase, "overlay", { fetchImpl, importModule })
  ]);
  assertModuleContract(idrive, ["readBootstrapConfig", "downloadVerifiedArtifact", "extractVerifiedArtifact"]);
  assertModuleContract(overlay, ["applyControlOverlay"]);

  const config = idrive.readBootstrapConfig(env);
  const { archive, actualSha256 } = await idrive.downloadVerifiedArtifact(config, fetchImpl);
  const { releaseRoot } = await idrive.extractVerifiedArtifact(archive);
  logger(JSON.stringify({
    app: "smejj.com",
    event: "control_artifact_verified_for_overlay",
    key: config.key,
    bytes: archive.length,
    sha256: actualSha256
  }));

  chdir(releaseRoot);
  processEnv.PROJECT_ROOT = releaseRoot;
  return overlay.applyControlOverlay({
    sourceBase: `${runtimeBase}/control-overlay`,
    appRoot: releaseRoot,
    fetchImpl,
    importModule
  });
}

export function controlRuntimeBase(value) {
  const source = String(value || "").trim();
  if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/runtime\/bootstrap-control-release\.mjs$/i.test(source)) {
    throw new Error("control_release_bootstrap_must_be_commit_pinned");
  }
  return source.slice(0, -"/bootstrap-control-release.mjs".length);
}

export async function loadVerifiedRuntimeModule(runtimeBase, name, {
  fetchImpl = fetch,
  importModule = (url) => import(url)
} = {}) {
  const spec = MODULES[name];
  if (!spec) throw new Error("unknown_control_runtime_module");
  const response = await fetchImpl(`${runtimeBase}/${spec.file}`, { redirect: "error", cache: "no-store" });
  if (!response.ok) throw new Error(`control_runtime_module_fetch_failed:${spec.file}:${response.status}`);
  const source = await response.text();
  if (!source || source.length > MAX_MODULE_BYTES) throw new Error(`control_runtime_module_size_invalid:${spec.file}`);
  if (sha256(source) !== spec.sha256) throw new Error(`control_runtime_module_sha256_mismatch:${spec.file}`);
  return importModule(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function assertModuleContract(module, names) {
  if (!module || names.some((name) => typeof module[name] !== "function")) {
    throw new Error("control_runtime_module_contract_invalid");
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

if (process.argv[1]?.endsWith("bootstrap-control-release.mjs")) await runBootstrap();
