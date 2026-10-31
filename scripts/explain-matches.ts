/**
 * Show the exact text each Layer 1 rule matched in recorded bash commands.
 *
 *   node scripts/explain-matches.ts <rule-id> [sessions-dir] [--samples N]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildPolicy } from "../extensions/command-guard/config.ts";

const [ruleId, ...rest] = process.argv.slice(2);
const sampleFlag = rest.indexOf("--samples");
const limit = sampleFlag >= 0 ? Number(rest[sampleFlag + 1]) : 8;
const dirArg = rest.find((a, i) => !a.startsWith("--") && i !== sampleFlag + 1);
const root = dirArg ?? join(homedir(), ".pi", "agent", "sessions");

const rule = buildPolicy({}).rules.find((r) => r.id === ruleId);
if (!rule?.pattern) {
	console.error(`rule ${ruleId} not found or has no pattern`);
	process.exit(1);
}
const pattern = rule.pattern;

function* jsonlFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* jsonlFiles(path);
		else if (name.endsWith(".jsonl")) yield path;
	}
}

let shown = 0;
for (const file of jsonlFiles(root)) {
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (!line.includes('"toolCall"') || shown >= limit) continue;
		try {
			const content = JSON.parse(line).message?.content;
			for (const block of Array.isArray(content) ? content : []) {
				const command = block?.name === "bash" ? block.arguments?.command : undefined;
				const m = typeof command === "string" ? pattern.exec(command) : null;
				if (m && shown < limit) {
					shown++;
					const at = m.index;
					console.log(
						`…${command.slice(Math.max(0, at - 40), at)}[[${m[0]}]]${command.slice(at + m[0].length, at + m[0].length + 40)}…`.replace(
							/\s+/g,
							" ",
						),
					);
				}
			}
		} catch {
			// skip malformed lines
		}
	}
}
