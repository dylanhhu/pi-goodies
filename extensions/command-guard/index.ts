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
 * The human can switch the whole guard off for a session with `/permissions yolo`
 * (see modes.ts); `/permissions default` turns it back on.
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
import { buildPolicy, loadConfigFile, type Policy } from "./config.ts";
import { createGuard } from "./guard.ts";
import { type ClassifyFn, createJudge } from "./judge.ts";
import {
	DEFAULT_MODE,
	enforcedPolicy,
	getMode,
	MODE_ENTRY_TYPE,
	PERMISSION_MODES,
	type PermissionMode,
	restoreMode,
} from "./modes.ts";
import { AUDIT_ENTRY_TYPE, createTrace } from "./trace.ts";
import { createTurnBuffer } from "./turn-buffer.ts";
import { type GuardRule, isTraceLevel, TOOL_NAMES, TRACE_LEVELS } from "./types.ts";

/**
 * Set to "1" by the subagent extension in the pi processes it starts. Their only
 * "user" message is a task written by another model, so it cannot show what the
 * user authorized.
 */
const DELEGATED_ENV = "PI_GOODIES_SUBAGENT";

const STATUS_KEY = "command-guard";

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
	const trace = createTrace();
	const delegated = process.env[DELEGATED_ENV] === "1";

	/** The context of the latest tool call; the decision model is reached through it */
	let latestCtx: ExtensionContext | undefined;

	/** The permission mode of this session. Set by /permissions; never by config or the model */
	let mode: PermissionMode = DEFAULT_MODE;

	interface Base {
		policy: Policy;
		judge?: ReturnType<typeof createJudge>;
	}

	// Policies are built per working directory and cached until /reload; guards
	// are cached per mode as well, since a mode may change the enforced policy
	const bases = new Map<string, Base>();
	const guards = new Map<string, ReturnType<typeof createGuard>>();

	function baseFor(cwd: string, ctx: ExtensionContext): Base {
		const cached = bases.get(cwd);
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

		const base = { policy, judge };
		bases.set(cwd, base);
		return base;
	}

	function guardFor(cwd: string, ctx: ExtensionContext) {
		const key = `${mode.name}\0${cwd}`;
		const cached = guards.get(key);
		if (cached) return cached;

		const { policy, judge } = baseFor(cwd, ctx);
		const guard = createGuard({
			policy: enforcedPolicy(mode, policy),
			home,
			turnBuffer,
			delegated,
			judge,
			audit: (entry) => pi.appendEntry(AUDIT_ENTRY_TYPE, entry),
			trace: (entry) => trace.record(entry),
		});
		guards.set(key, guard);
		return guard;
	}

	function syncStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, mode.badge ? ctx.ui.theme.fg("warning", mode.badge) : undefined);
	}

	pi.registerCommand("permissions", {
		description: `Show or set the command-guard permission mode (${PERMISSION_MODES.map((m) => m.name).join(", ")})`,
		getArgumentCompletions: (prefix) => {
			const matches = PERMISSION_MODES.filter((m) =>
				m.name.startsWith(prefix.trim().toLowerCase()),
			);
			return matches.length > 0
				? matches.map((m) => ({ value: m.name, label: m.name, description: m.description }))
				: null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested) {
				const lines = PERMISSION_MODES.map(
					(m) => `${m === mode ? "*" : " "} ${m.name}: ${m.description}`,
				);
				ctx.ui.notify(`Permission mode: ${mode.name}\n${lines.join("\n")}`, "info");
				return;
			}
			const next = getMode(requested);
			if (!next) {
				const names = PERMISSION_MODES.map((m) => m.name).join(", ");
				ctx.ui.notify(`Unknown permission mode "${requested}". Modes: ${names}`, "error");
				return;
			}
			if (next === mode) {
				ctx.ui.notify(`Permission mode is already ${mode.name}`, "info");
				return;
			}
			mode = next;
			pi.appendEntry(MODE_ENTRY_TYPE, { mode: mode.name });
			syncStatus(ctx);
			ctx.ui.notify(
				mode.warning ?? `Permission mode: ${mode.name}`,
				mode.warning ? "warning" : "info",
			);
		},
	});

	pi.registerToolRenderer(trace.resolver);

	const TRACE_DESCRIPTIONS: Record<(typeof TRACE_LEVELS)[number], string> = {
		off: "No note under approved calls",
		scores: "Note under calls the decision model allowed or you approved after it flagged them",
		all: "Also a note under calls that never reached the decision model",
	};

	pi.registerCommand("guard-scores", {
		description: `Show how approved calls were decided, under each call (${TRACE_LEVELS.join(", ")})`,
		getArgumentCompletions: (prefix) => {
			const matches = TRACE_LEVELS.filter((level) => level.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0
				? matches.map((level) => ({
						value: level,
						label: level,
						description: TRACE_DESCRIPTIONS[level],
					}))
				: null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested) {
				const lines = TRACE_LEVELS.map(
					(level) => `${level === trace.level ? "*" : " "} ${level}: ${TRACE_DESCRIPTIONS[level]}`,
				);
				ctx.ui.notify(`Approved-call notes: ${trace.level}\n${lines.join("\n")}`, "info");
				return;
			}
			if (!isTraceLevel(requested)) {
				ctx.ui.notify(`Unknown level "${requested}". Levels: ${TRACE_LEVELS.join(", ")}`, "error");
				return;
			}
			trace.setLevel(requested);
			ctx.ui.notify(`Approved-call notes: ${requested}`, "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		turnBuffer.reset();
		// The starting level is the configured one; /guard-scores changes it for this session
		trace.setLevel(loadConfigFile(globalPath, [])?.display?.approved ?? "off");
		trace.load(ctx.sessionManager.getBranch());
		// Only a reload keeps the mode, since it re-runs this module in the same session.
		// A resumed or forked session file is not trusted to switch the guard off, and
		// without a UI nobody would see that it is off
		mode =
			event.reason === "reload" && ctx.hasUI
				? restoreMode(ctx.sessionManager.getBranch())
				: DEFAULT_MODE;
		syncStatus(ctx);
		if (mode.warning) ctx.ui.notify(`Permission mode restored: ${mode.warning}`, "warning");
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
		// The human switched the guard off: no part of it may run, so nothing in it can block
		if (mode.bypass) return undefined;
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
