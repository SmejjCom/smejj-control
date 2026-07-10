// smejj.com — Server-AI-Verfuegbarkeit fuer Health/Status: EIN Ort fuer die
// Wahrheit "ist serverseitige AI nutzbar?". Fail-closed: ai=true gilt nur wenn
// die aufgeloeste Provider-Kette mindestens ein verwendbares Backend enthaelt
// UND entweder das klassische Server-AI-Gate mit positivem Budget aktiv ist
// ODER ein BYOK/pay-per-use Z.ai/Zhipu-Provider konfiguriert ist. Der zweite
// Fall bildet den Live-Stand ab: Z.ai verwaltet das Guthaben ausserhalb des
// Control-Servers, smejj.com startet dabei keinen versteckten Fallback.
// Keine Secrets in der Ausgabe: nur Provider-Name und Modell-ID
// (z. B. "zhipu:glm-5.2") — niemals Keys, Base-URLs oder Header.
import { getPublicModelRegistry } from "../../../src/shared/modelRegistry.js";
import { resolveModelRequest } from "./modelRouter.js";
import { getModelRuntimeHealthSnapshot } from "./modelRuntimeHealth.js";

/**
 * Bewertet die serverseitige AI-Verfuegbarkeit rein aus der Umgebung (pur, ohne I/O).
 * Input:  env (Objekt wie process.env), optional profile fuer die Kette.
 * Output: { ai, aiBackend, gateEnabled, budgetOk, providerOk, activationMode }
 *   - ai: true nur bei verwendbarer Provider-Kette und erlaubtem Aktivierungsmodus
 *   - aiBackend: "provider:modell" des primaeren Backends der Kette, sonst ""
 */
export function evaluateAiAvailability(env = process.env, profile = "default", requestedModel = "") {
  const gateEnabled = env.SMEJJ_SERVER_AI_ENABLED === "true";
  const remaining = Number(env.SMEJJ_SERVER_AI_REMAINING || 0);
  const budgetOk = Number.isFinite(remaining) && remaining > 0;
  const { chain, selection } = resolveModelRequest(profile, requestedModel, env);
  const providerOk = chain.length > 0;
  const primary = chain[0] || null;
  const registryByokOk = ["zhipu", "kimi"].includes(primary?.name)
    && primary?.logicalModelId !== "provider-fallback";
  const classicGateOk = gateEnabled && budgetOk;
  const ai = providerOk && (classicGateOk || registryByokOk);
  return {
    ai,
    aiBackend: ai ? `${chain[0].name}:${chain[0].model}` : "",
    activeModelId: ai ? chain[0].logicalModelId : "",
    requestedModelId: selection.requestedModelId,
    gateEnabled,
    budgetOk,
    providerOk,
    activationMode: ai ? (classicGateOk ? "server-budget-gate" : `${chain[0].name}-byok`) : "disabled",
    registry: getPublicModelRegistry(env, getModelRuntimeHealthSnapshot())
  };
}
