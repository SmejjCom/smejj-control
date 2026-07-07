// smejj.com — Build-Patch: schuetzt interne Projektquellen im Live-Agentenprompt.
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2] || "build/src/server.js";
const guard = '  systemLines.push(\n    "Internes Projektwissen ist nur Hintergrund. Nenne interne Dateinamen, Pfade, Memory_Bank.md, Project_Goals.md oder docs/* niemals als oeffentliche Quelle, URL oder Markdown-Link."\n  );\n\n';
const marker = "  const userParts = [`Frage/Aufgabe:\\n${task}`];";
let source = readFileSync(target, "utf8");
if (!source.includes(guard)) {
  if (!source.includes(marker)) {
    throw new Error(`smejj.com guard marker fehlt in ${target}`);
  }
  source = source.replace(marker, `${guard}${marker}`);
  writeFileSync(target, source, "utf8");
}
