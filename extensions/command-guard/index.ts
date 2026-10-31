/**
 * Command Guard Extension
 *
 * Guards the bash, write, and edit tools in layers:
 *
 *   1. Static rules: regex, host, and path tripwires (shipped set plus yours)
 *   2. A strict allowlist fast path for plain read-only commands
 *   3. An optional decision model (a classifier) that judges calls the rules
 *      flag with action "judge", and optionally every unmatched bash call
 *   4. The human, via a confirm dialog, whenever the outcome is "confirm"
 *
 * Config files (both optional, merged; the project file can only tighten):
 *   ~/.pi/agent/command-guard.json   global
 *   .pi/command-guard.json           project-local
 *
 * See README.md in this directory for the config schema. Reload with /reload
 * after changing it.
 *
 * === IMPORTANT: AI AGENT BEHAVIOR ===
 *
 * When the human is asked to confirm, the AI does not see the dialog. If the
 * user denies, the AI receives an error result stating that the user declined.
 * That result must be unambiguous: without it the AI cannot tell a refusal
 * from a platform failure, and may retry or rephrase the action to get around
 * a rule the user already rejected. Blocks are worded the same way.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildPolicy, loadConfigFile } from "./config.ts";
import { createGuard } from "./guard.ts";
import { type ClassifyFn, createJudge } from "./judge.ts";
import { createTurnBuffer } from "./turn-buffer.ts";
import { type GuardRule, TOOL_NAMES } from "./types.ts";

/**
 * Set to "1" by the subagent extension in the pi processes it starts. Their only
 * "user" message is a task written by another model, so it cannot show what the
 * user authorized.
 */
const DELEGATED_ENV = "PI_GOODIES_SUBAGENT";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The extension protects its own source, wherever it is installed. */
function selfProtectionRule(): GuardRule {
	const here = dirname(fileURLToPath(import.meta.url));
	let real = here;
	try {
		real = realpathSync(here);
	} catch {
		// keep the unresolved path
	}
	const dirs = [...new Set([here, real])];
	return {
		id: "protect-guard-extension",
		category: "protected",
		label: "command-guard's own source files",
		paths: dirs.map((dir) => `^${escapeRegExp(dir)}/`),
	};
}

export default function (pi: ExtensionAPI) {
	const home = process.env.HOME || homedir();
	const globalPath = join(home, ".pi", "agent", "command-guard.json");
	const selfProtection = selfProtectionRule();
	const turnBuffer = createTurnBuffer();
	const delegated = process.env[DELEGATED_ENV] === "1";

	/** The context of the latest tool call; the decision model is reached through it */
	let latestCtx: ExtensionContext | undefined;

	// Policies are built per working directory and cached until /reload
	const guards = new Map<string, ReturnType<typeof createGuard>>();

	function guardFor(cwd: string, ctx: ExtensionContext) {
		const cached = guards.get(cwd);
		if (cached) return cached;

		const warnings: string[] = [];
		const global = loadConfigFile(globalPath, warnings);
		const project = loadConfigFile(join(cwd, ".pi", "command-guard.json"), warnings);
		const policy = buildPolicy({ global, project }, { extraRules: [selfProtection] });
		warnings.push(...policy.warnings);

		let judge: ReturnType<typeof createJudge> | undefined;
		if (policy.judge) {
			const [provider, ...rest] = policy.judge.model.split("/");
			const modelId = rest.join("/");
			// Say so now rather than letting every judged call end in the onError outcome
			if (!ctx.modelRegistry.findOfType("classifier", provider, modelId)) {
				warnings.push(
					`classifier model ${policy.judge.model} is not available; judged actions will take the onError outcome (${policy.judge.onError})`,
				);
			}
			const classify: ClassifyFn = async (context, signal) => {
				const registry = latestCtx?.modelRegistry;
				const model = registry?.findOfType("classifier", provider, modelId);
				if (!registry || !model) {
					throw new Error(`classifier model ${policy.judge?.model} is not available`);
				}
				return registry.classify(model, context, { signal });
			};
			judge = createJudge(classify, policy.judge);
		}

		for (const warning of warnings) {
			if (ctx.hasUI) ctx.ui.notify(`command-guard: ${warning}`, "warning");
			else console.error(`[command-guard] ${warning}`);
		}

		const guard = createGuard({
			policy,
			home,
			turnBuffer,
			delegated,
			judge,
			audit: (entry) => pi.appendEntry("command-guard", entry),
		});
		guards.set(cwd, guard);
		return guard;
	}

	pi.on("session_start", () => {
		turnBuffer.reset();
	});

	pi.on("message_end", (event) => {
		turnBuffer.onMessage(event.message);
	});

	pi.on("agent_end", () => {
		turnBuffer.onAgentEnd();
	});

	pi.on("tool_call", async (event, ctx) => {
		// Tools the guard does not cover must not depend on (or be broken by) the policy
		if (!(TOOL_NAMES as readonly string[]).includes(event.toolName)) return undefined;
		latestCtx = ctx;

		let guard: ReturnType<typeof createGuard>;
		try {
			guard = guardFor(ctx.cwd, ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				block: true,
				reason: `Blocked by command-guard: the policy could not be built (${message}). Do not retry; tell the user to fix their command-guard config.`,
			};
		}
		return guard(
			{ toolName: event.toolName, toolCallId: event.toolCallId, input: event.input },
			ctx,
		);
	});
}
