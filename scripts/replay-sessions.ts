/**
 * Replay bash/write/edit calls from pi session logs through the Layer 1 rules
 * and report how often each rule fires, with samples. Used to calibrate the
 * shipped rules against real usage (false positives especially).
 *
 *   node scripts/replay-sessions.ts [sessions-dir] [--samples N]
 *
 * Read-only: it never executes any recorded command.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAllowlisted } from "../extensions/command-guard/allowlist.ts";
import { buildPolicy } from "../extensions/command-guard/config.ts";
import { describeToolCall } from "../extensions/command-guard/descriptor.ts";
import { matchRules } from "../extensions/command-guard/match.ts";

const args = process.argv.slice(2);
const sampleFlag = args.indexOf("--samples");
const samples = sampleFlag >= 0 ? Number(args[sampleFlag + 1]) : 3;
const positional = args.filter((a, i) => !a.startsWith("--") && i !== sampleFlag + 1);
const root = positional[0] ?? join(homedir(), ".pi", "agent", "sessions");
const home = homedir();

function* jsonlFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* jsonlFiles(path);
		else if (name.endsWith(".jsonl")) yield path;
	}
}

const policy = buildPolicy({});
const counts = new Map<string, number>();
const examples = new Map<string, string[]>();
let total = 0;
let allowlisted = 0;
let flagged = 0;

for (const file of jsonlFiles(root)) {
	let cwd = home;
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry: { cwd?: string; message?: { role?: string; content?: unknown } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry.cwd === "string") cwd = entry.cwd;
		const content = entry.message?.content;
		if (entry.message?.role !== "assistant" || !Array.isArray(content)) continue;

		for (const block of content) {
			if (block?.type !== "toolCall") continue;
			const d = describeToolCall({ toolName: block.name, input: block.arguments }, cwd, home);
			if (!d) continue;
			total++;
			const matched = matchRules(policy.rules, d, { allowedHosts: policy.allowedHosts, home });
			if (matched.length === 0) {
				if (
					d.tool === "bash" &&
					isAllowlisted(d.command ?? "", { cwd, home, entries: policy.allowlist.entries })
				) {
					allowlisted++;
				}
				continue;
			}
			flagged++;
			for (const m of matched) {
				counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
				const list = examples.get(m.id) ?? [];
				if (list.length < samples) {
					list.push((d.command ?? `${d.tool} ${d.paths[0]}`).replace(/\s+/g, " ").slice(0, 160));
				}
				examples.set(m.id, list);
			}
		}
	}
}

console.log(`calls: ${total}, flagged by rules: ${flagged}, allowlist fast-path: ${allowlisted}`);
for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
	const rule = policy.rules.find((r) => r.id === id);
	console.log(`\n${String(n).padStart(4)}  ${id}  [${rule?.rule.category}]`);
	for (const ex of examples.get(id) ?? []) console.log(`        ${ex}`);
}
