/**
 * Turns a decision into a tool_call result: runs the policy, opens a dialog
 * when needed, and words every refusal so the model cannot mistake it for a
 * transient failure.
 */

import { describeToolCall } from "./descriptor.ts";
import { decide } from "./policy.ts";
import type { Decision, Descriptor, Policy } from "./types.ts";

export interface AuditEntry {
	tool: string;
	toolCallId: string;
	outcome: Decision["outcome"];
	source: Decision["source"];
	cause: string;
	detail?: string;
	targets?: string[];
	hosts?: string[];
	/** Present when the human was asked */
	confirmed?: boolean;
}

export interface GuardDeps {
	policy: Policy;
	/** Receives an entry for every call that asked or was refused */
	audit: (entry: AuditEntry) => void;
}

export interface GuardToolCall {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

export interface GuardContext {
	cwd: string;
	hasUI: boolean;
	/** Aborted when the user cancels the run */
	signal?: AbortSignal;
	ui: {
		confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
	};
}

export type GuardResult = { block: true; reason: string } | undefined;

/** Longest action text handed back to the model. */
const DISPLAY_MAX = 2_000;

/** Keep the head and tail of long text for display. */
function clipForDisplay(text: string): string {
	if (text.length <= DISPLAY_MAX) return text;
	const head = Math.floor(DISPLAY_MAX * 0.6);
	const tail = DISPLAY_MAX - head;
	return `${text.slice(0, head)}\n[... ${(text.length - DISPLAY_MAX).toLocaleString("en-US")} characters omitted ...]\n${text.slice(-tail)}`;
}

/** The action as text, unclipped. */
function actionText(d: Descriptor): string {
	return d.tool === "bash" ? (d.command ?? "") : `${d.tool} ${d.paths.join(", ")}`;
}

function summarize(d: Descriptor): string {
	return clipForDisplay(actionText(d));
}

/**
 * The action shown in a confirm dialog. The transcript already holds the full
 * command, so the dialog shows only enough of its opening to tell apart calls
 * issued in parallel.
 */
const PREVIEW_LINES = 2;
const PREVIEW_LINE_MAX = 100;

function more(n: number, noun: string): string {
	return `${n.toLocaleString("en-US")} more ${noun}${n === 1 ? "" : "s"}`;
}

function previewForDialog(text: string): string {
	const trimmed = text.trimEnd();
	const lines = trimmed.split("\n");
	const head = lines.slice(0, PREVIEW_LINES);
	const shown = head.map((line) =>
		line.length > PREVIEW_LINE_MAX ? `${line.slice(0, PREVIEW_LINE_MAX - 1)}…` : line,
	);
	if (lines.length === head.length && shown.join("\n") === trimmed) return trimmed;

	const hiddenLines = lines.length - head.length;
	const hiddenChars = head.reduce((n, line, i) => n + line.length - shown[i].length, 0);
	const hidden = [
		hiddenLines > 0 ? more(hiddenLines, "line") : undefined,
		hiddenChars > 0 ? more(hiddenChars, "character") : undefined,
	];
	return [...shown, `[… ${hidden.filter(Boolean).join(", ")}]`].join("\n");
}

/** A sentence explaining why the effect matters, when the cause is not obvious. */
function explain(cause: string): string | undefined {
	if (cause.startsWith("write outside"))
		return "This is outside the project, so git cannot recover it.";
	if (cause.startsWith("changes directory")) {
		return "Relative paths in the command may point outside the project.";
	}
	if (cause === "sensitive path" || cause === "read a sensitive file") {
		return "This is a credential, key, or secret file.";
	}
	if (cause === "protected path") return "This file belongs to command-guard or pi credentials.";
	if (cause === "pi config or instructions") {
		return "This changes pi's settings, extensions, skills, or instructions, which take effect later.";
	}
	if (cause === "persistence or executable project configuration") {
		return "This changes something that can run later, such as a git hook, CI workflow, or editor task.";
	}
	if (cause.startsWith("network access")) {
		return "The host is not on the fetch list. Add it to fetchHosts to allow fetches.";
	}
	if (cause === "data upload") return "Data sent out cannot be recalled.";
	if (cause === "elevated privileges") return "This runs with root privileges.";
	if (cause === "package installation") return "This installs software outside the project.";
	if (cause.startsWith("persistence")) return "This changes something that runs later.";
	if (cause === "process signal") return "This can terminate another process.";
	if (cause === "remote shell or file transfer") return "This reaches another machine.";
	if (cause === "service change" || cause === "scheduled task change") {
		return "This changes something that runs later.";
	}
	if (cause === "system defaults change") return "This changes system-wide preferences.";
	if (cause === "docker state change" || cause === "docker compose state change") {
		return "This changes local containers, images, or volumes.";
	}
	if (cause === "GitHub state change" || cause === "API write") {
		return "This changes state on a remote service.";
	}
	if (cause === "credential change") return "This changes stored credentials.";
	if (cause.startsWith("mutation target")) {
		return "The command mutates state but the guard could not tell where.";
	}
	if (cause === "force push") return "This rewrites history on the remote.";
	if (cause.startsWith("git ")) return "This can discard work that git cannot recover.";
	return undefined;
}

function titleFor(cause: string): string {
	return cause.charAt(0).toUpperCase() + cause.slice(1);
}

function blockReason(decision: Decision, d: Descriptor): string {
	return [
		`Blocked by command-guard: ${decision.cause}${decision.detail ? ` (${decision.detail})` : ""}.`,
		"This is a policy block, not a transient or environment error. Do not retry it, and do not retry the same operation rewritten to avoid the match. If the action is truly needed, explain why to the user and let them decide.",
		`Action that was blocked:\n${summarize(d)}`,
	].join("\n\n");
}

function declineReason(decision: Decision, d: Descriptor): string {
	return [
		`The user declined to run this action (${decision.cause}); it did not execute.`,
		"This is a refusal by the user, not an environment, permission, or syntax error, and not a temporary failure.",
		"Do not retry it, and do not retry the same operation rewritten to avoid the check.",
		`Action that was refused:\n${summarize(d)}`,
	].join("\n\n");
}

function confirmMessage(decision: Decision, d: Descriptor): string {
	const lines = [
		decision.detail ? `${titleFor(decision.cause)}: ${decision.detail}` : titleFor(decision.cause),
	];
	const note = explain(decision.cause);
	if (note) lines.push(note);
	lines.push("", previewForDialog(actionText(d)), "", "Allow?");
	return lines.join("\n");
}

const ABORTED: GuardResult = { block: true, reason: "Operation aborted." };

export function createGuard(deps: GuardDeps) {
	/** Recording is best effort: a failing log must neither block nor allow a call. */
	const audit = (entry: AuditEntry) => {
		try {
			deps.audit(entry);
		} catch {
			// ignore
		}
	};

	async function evaluate(event: GuardToolCall, ctx: GuardContext): Promise<GuardResult> {
		if (ctx.signal?.aborted) return ABORTED;
		const d = describeToolCall(event, ctx.cwd, deps.policy.home);
		if (!d) {
			return {
				block: true,
				reason:
					"Blocked by command-guard: the tool input could not be understood, so it cannot be checked. Do not retry; tell the user.",
			};
		}

		const decision = decide(d, deps.policy);
		const entry: AuditEntry = {
			tool: d.tool,
			toolCallId: event.toolCallId,
			outcome: decision.outcome,
			source: decision.source,
			cause: decision.cause,
			detail: decision.detail,
			targets: decision.targets,
			hosts: decision.hosts,
		};

		if (decision.outcome === "allow") return undefined;

		if (decision.outcome === "block") {
			audit(entry);
			return { block: true, reason: blockReason(decision, d) };
		}

		// ask
		if (ctx.signal?.aborted) return ABORTED;
		if (!ctx.hasUI) {
			audit(entry);
			return {
				block: true,
				reason: `Blocked by command-guard: ${decision.cause}. This action needs the user's confirmation, but no UI is available to ask (non-interactive mode), so it cannot be confirmed. Do not retry.`,
			};
		}
		const confirmed = await ctx.ui.confirm(titleFor(decision.cause), confirmMessage(decision, d), {
			signal: ctx.signal,
		});
		if (ctx.signal?.aborted) return ABORTED;
		audit({ ...entry, confirmed });
		return confirmed ? undefined : { block: true, reason: declineReason(decision, d) };
	}

	return async function onToolCall(event: GuardToolCall, ctx: GuardContext): Promise<GuardResult> {
		try {
			return await evaluate(event, ctx);
		} catch (err) {
			// Fail closed: an unexpected error must not become a silent allow
			const message = err instanceof Error ? err.message : String(err);
			return {
				block: true,
				reason: `Blocked by command-guard: internal error while evaluating the call (${message}). Do not retry; tell the user.`,
			};
		}
	};
}
