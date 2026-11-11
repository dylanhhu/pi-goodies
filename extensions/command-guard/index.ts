/**
 * Command Guard Extension
 *
 * Guards bash, write, edit, and read with one stateless policy:
 *
 *   - read-only and unclassified commands run
 *   - workspace, scratch, and configured-root mutations run
 *   - everything outside those roots, plus network sends, privilege,
 *     persistence, package installs, and destructive git, asks the human
 *   - a small floor is blocked outright
 *
 * An optional classifier model can tighten opaque code or suppress an ask
 * when the task clearly requests the effect. There is no approval memory and no
 * project config. The global file is `~/.pi/agent/command-guard.json`; see
 * README.md.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGuard } from "./guard.ts";
import { type ClassifyFn, createModel, type GuardModel } from "./model.ts";
import {
	DEFAULT_MODE,
	getMode,
	MODE_ENTRY_TYPE,
	PERMISSION_MODES,
	type PermissionMode,
	restoreMode,
} from "./modes.ts";
import { buildPolicy, loadConfigFile } from "./policy.ts";
import { createTurnBuffer } from "./turn-buffer.ts";
import { type Policy, TOOL_NAMES } from "./types.ts";

/** Session entry type the guard records decisions under. */
const AUDIT_ENTRY_TYPE = "command-guard";

const STATUS_KEY = "command-guard";

/** Set by the subagent extension: its only "user" message is another model's task. */
const DELEGATED_ENV = "PI_GOODIES_SUBAGENT";

/** The extension protects its own source, wherever it is installed. */
function guardDirs(): string[] {
	const here = dirname(fileURLToPath(import.meta.url));
	let real = here;
	try {
		real = realpathSync(here);
	} catch {
		// keep the unresolved path
	}
	return [...new Set([here, real])];
}

export default function (pi: ExtensionAPI) {
	const home = process.env.HOME || homedir();
	const globalPath = join(home, ".pi", "agent", "command-guard.json");
	const protectedDirs = guardDirs();
	const turnBuffer = createTurnBuffer();
	const delegated = process.env[DELEGATED_ENV] === "1";

	/** The permission mode of this session. Set by /permissions; never by config or the model */
	let mode: PermissionMode = DEFAULT_MODE;

	const policies = new Map<string, Policy>();
	const guards = new Map<string, ReturnType<typeof createGuard>>();

	function policyFor(cwd: string, ctx: ExtensionContext): Policy {
		const cached = policies.get(cwd);
		if (cached) return cached;

		const warnings: string[] = [];
		const config = loadConfigFile(globalPath, warnings);
		const policy = buildPolicy({
			config,
			cwd,
			home,
			protectedDirs,
			guardConfigPath: globalPath,
		});
		policy.warnings.unshift(...warnings);
		if (policy.classifier) {
			const [provider, ...rest] = policy.classifier.model.split("/");
			const modelId = rest.join("/");
			let available: unknown;
			try {
				available =
					provider && modelId
						? ctx.modelRegistry.findOfType("classifier", provider, modelId)
						: undefined;
			} catch {
				available = undefined;
			}
			if (!available) {
				policy.warnings.push(
					`classifier model ${policy.classifier.model} is not available; static policy only`,
				);
				policy.classifier = undefined;
			}
		}

		for (const warning of policy.warnings) {
			if (ctx.hasUI) ctx.ui.notify(`command-guard: ${warning}`, "warning");
			else console.error(`[command-guard] ${warning}`);
		}
		policies.set(cwd, policy);
		return policy;
	}

	function guardFor(cwd: string, ctx: ExtensionContext) {
		const cached = guards.get(cwd);
		if (cached) return cached;
		const policy = policyFor(cwd, ctx);
		let model: GuardModel | undefined;
		if (policy.classifier) {
			const settings = policy.classifier;
			const [provider, ...rest] = settings.model.split("/");
			const modelId = rest.join("/");
			const classify: ClassifyFn = async (context, signal) => {
				const registry = ctx.modelRegistry;
				const available = registry.findOfType("classifier", provider, modelId);
				if (!available) throw new Error(`classifier model ${settings.model} is not available`);
				return registry.classify(available, context, { signal });
			};
			model = createModel(classify, settings);
		}
		const guard = createGuard({
			policy,
			audit: (entry) => pi.appendEntry(AUDIT_ENTRY_TYPE, entry),
			model,
			userMessages: () => turnBuffer.messages(),
			delegated,
		});
		guards.set(cwd, guard);
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

	pi.registerCommand("guard", {
		description: "Show the current command-guard policy",
		handler: async (_args, ctx) => {
			let policy: Policy;
			try {
				policy = policyFor(ctx.cwd, ctx);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`command-guard: the policy could not be built (${message})`, "error");
				return;
			}
			const roots = policy.writeRoots.length > 0 ? policy.writeRoots.join(", ") : "none";
			const classifier = policy.classifier
				? `${policy.classifier.model} (opaque risk ${policy.classifier.opaqueRisk.enabled ? `${policy.classifier.opaqueRisk.ask}/${policy.classifier.opaqueRisk.block}` : "off"}, scope ${policy.classifier.scope.enabled ? policy.classifier.scope.threshold : "off"})`
				: "off";
			const lines = [
				`Permission mode: ${mode.name}`,
				`Workspace: ${policy.workspace}${policy.workspaceWritable ? "" : " (not writable)"}`,
				`Write roots: ${roots}`,
				`Fetch hosts: ${policy.fetchHosts.join(", ")}`,
				`Classifier: ${classifier}`,
				`Protected: ${policy.protectedDirs.join(", ")}`,
				`Config: ${policy.guardConfigPath}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		// A new session may have a different config on disk
		policies.clear();
		guards.clear();
		turnBuffer.reset();
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
