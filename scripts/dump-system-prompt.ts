#!/usr/bin/env tsx
/**
 * Diagnostic: print the effective system prompt the agent receives.
 * Usage: tsx scripts/dump-system-prompt.ts [persona-name]
 */

import { loadPersonas } from "../src/core/personas.ts";

const personas = loadPersonas();
const targetName = process.argv[2] ?? "senior";
const persona = personas.find((p) => p.name === targetName);
if (!persona) {
	console.error(`Persona "${targetName}" not found. Available: ${personas.map((p) => p.name).join(", ")}`);
	process.exit(1);
}

console.log("=== System prompt for:", persona.name, "===");
console.log(persona.systemPrompt);
console.log("=== END ===");
console.log("Chars:", persona.systemPrompt.length);
console.log("Approx tokens (chars/4):", Math.round(persona.systemPrompt.length / 4));