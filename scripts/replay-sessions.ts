/**
 * Replay recorded tool calls from pi session logs through the effect policy and
 * report what would be allowed, asked, or blocked.
 *
 *   node scripts/replay-sessions.ts [sessions-dir] [--samples N]
 *
 * Read-only: it never executes any recorded command.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeToolCall } from "../extensions/command-guard/descriptor.ts";
import { buildPolicy, decide } from "../extensions/command-guard/policy.ts";
import type { Policy } from "../extensions/command-guard/types.ts";

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

const policies = new Map<string, Policy>();
function policyFor(cwd: string): Policy {
	const cached = policies.get(cwd);
	if (cached) return cached;
	const policy = buildPolicy({ cwd, home });
	policies.set(cwd, policy);
	return policy;
}

const counts = new Map<string, number>();
const examples = new Map<string, string[]>();
let total = 0;
let allow = 0;
let ask = 0;
let blocked = 0;

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
			const decision = decide(d, policyFor(cwd));
			if (decision.outcome === "allow") allow++;
			else if (decision.outcome === "ask") ask++;
			else blocked++;
			const key = `${decision.outcome}: ${decision.cause}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
			const list = examples.get(key) ?? [];
			if (list.length < samples) {
				list.push((d.command ?? `${d.tool} ${d.paths[0]}`).replace(/\s+/g, " ").slice(0, 160));
			}
			examples.set(key, list);
		}
	}
}

console.log(`calls: ${total}, allow: ${allow}, ask: ${ask}, block: ${blocked}`);
for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`\n${String(n).padStart(4)}  ${key}`);
	for (const ex of examples.get(key) ?? []) console.log(`        ${ex}`);
}
