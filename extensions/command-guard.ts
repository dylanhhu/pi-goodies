/**
 * Command Guard Extension
 *
 * Blocks or requires confirmation for dangerous bash commands.
 *
 * Config file: ~/.pi/agent/command-guard.json  (global)
 *              .pi/command-guard.json            (project-local)
 *
 * Actions:
 *   "block"   - command is denied outright
 *   "confirm" - prompts user for confirmation before executing
 *
 * Reload the extension with /reload after changing the config.
 *
 * === IMPORTANT: AI AGENT BEHAVIOR ===
 *
 * When a rule with action "confirm" is triggered, a confirmation dialog
 * appears in the TUI for the human user. The AI agent does NOT see the
 * dialog or the user's choice directly.
 *
 * If the user CONFIRMS: the command executes normally and the AI sees
 * its stdout/stderr as usual.
 *
 * If the user DENIES: the command does not run, and the AI receives an
 * error tool result stating that the user declined. That result is the
 * only signal the AI gets, so it must be unambiguous: without it the AI
 * cannot distinguish a refused command from a platform failure or a
 * policy block, and may retry or rephrase the same command to get around
 * a rule the user already rejected.
 *
 * `message` is dual-purpose and reads differently per action:
 *   "confirm" - shown to the human in the dialog (e.g. "... Proceed?");
 *               never used as the reason handed to the AI on denial
 *   "block"   - shown to the AI as the block reason, though it is noted
 *               in the TUI as well
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GuardRule {
	/** Regex pattern to match against the full command string */
	pattern: string;
	/** "block" = deny outright, "confirm" = ask user first */
	action: "block" | "confirm";
	/** Optional friendly label shown in UI */
	label?: string;
	/**
	 * Custom text, interpreted by action:
	 *   "confirm" - the question shown to the human in the dialog
	 *   "block"   - the reason handed to the AI
	 */
	message?: string;
	/** Optional replacement for the default "the user declined" reason ("confirm" only) */
	denyMessage?: string;
}

interface CommandGuardConfig {
	rules: GuardRule[];
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadRules(): GuardRule[] {
	const globalPath = join(process.env.HOME ?? "", ".pi", "agent", "command-guard.json");
	const projectPath = join(process.cwd(), ".pi", "command-guard.json");

	const configPath = existsSync(projectPath) ? projectPath : globalPath;

	if (!existsSync(configPath)) {
		return [];
	}

	try {
		const raw = readFileSync(configPath, "utf-8");
		const config: CommandGuardConfig = JSON.parse(raw);
		return config.rules ?? [];
	} catch (err) {
		console.error(`[command-guard] Failed to load config from ${configPath}: ${err}`);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Denial reason
// ---------------------------------------------------------------------------

/**
 * Model-facing reason for a command the human refused at the confirm dialog.
 *
 * `ctx.ui.confirm` returns false both when the user answers No and when the
 * dialog is dismissed (Esc, timeout, abort), so the wording covers both. An
 * optional `denyMessage` on the rule replaces the whole message; otherwise the
 * template states plainly that the user refused and must not be re-asked.
 */
function declineReason(rule: GuardRule, cmd: string): string {
	if (rule.denyMessage) return rule.denyMessage;

	const label = rule.label ?? rule.pattern;
	return [
		`The user declined to run this command (${label}); it did not execute.`,
		"This is a refusal by the user, not an environment, permission, or syntax error, and not a temporary failure.",
		"Do not retry it, and do not retry the same operation rewritten to avoid the matched pattern.",
		`Command that was refused:\n${cmd}`,
	].join("\n\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Load rules at init time. On /reload the extension re-runs and picks up
	// the new config.
	const rules = loadRules();

	if (rules.length === 0) return;

	// Pre-compile regexes for efficiency
	const compiled: Array<{ regex: RegExp; rule: GuardRule }> = rules.map((r) => ({
		regex: new RegExp(r.pattern, "i"), // case-insensitive
		rule: r,
	}));

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command ?? "";

		for (const { regex, rule } of compiled) {
			if (regex.test(cmd)) {
				if (rule.action === "block") {
					return {
						block: true,
						reason: rule.message ?? `Blocked by command-guard: ${rule.label ?? rule.pattern}`,
					};
				}

				if (rule.action === "confirm") {
					const ok = await ctx.ui.confirm(
						rule.label ?? "Dangerous command",
						rule.message ??
							`Command matches rule: ${rule.pattern}\n\nFull command:\n${cmd}\n\nAllow?`,
					);
					if (!ok) {
						return { block: true, reason: declineReason(rule, cmd) };
					}
				}
			}
		}
	});
}
