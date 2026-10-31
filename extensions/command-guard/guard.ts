/**
 * Turns decisions into tool_call results: runs the pipeline, asks the human
 * when needed, and words every refusal so the model cannot mistake it for a
 * transient failure.
 */

import type { Policy } from "./config.ts";
import { type Decision, decide } from "./decide.ts";
import { describeToolCall } from "./descriptor.ts";
import type { JudgeInput, JudgeVerdict } from "./judge.ts";
import type { TurnBuffer } from "./turn-buffer.ts";
import type { Descriptor } from "./types.ts";

export interface AuditEntry {
	tool: string;
	/** Correlates the entry with the tool call in the session */
	toolCallId: string;
	outcome: Decision["outcome"];
	source: Decision["source"];
	rules: string[];
	scores?: Record<string, number>;
	judgeError?: true;
	/** Present when the human was asked */
	confirmed?: boolean;
}

export interface GuardDeps {
	policy: Policy;
	home: string;
	turnBuffer: TurnBuffer;
	/** Receives an entry for every decision worth recording */
	audit: (entry: AuditEntry) => void;
	/** Undefined when no decision model is configured */
	judge?: (input: JudgeInput) => Promise<JudgeVerdict>;
	/** This process was started by another model (a subagent), so its "user" messages are not the user's */
	delegated?: boolean;
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

/** Longest action text shown in a dialog or handed back to the model. */
const DISPLAY_MAX = 2_000;

/** Keep the head and tail of long text for display; the full action is still what was judged. */
function clipForDisplay(text: string): string {
	if (text.length <= DISPLAY_MAX) return text;
	const head = Math.floor(DISPLAY_MAX * 0.6);
	const tail = DISPLAY_MAX - head;
	return `${text.slice(0, head)}\n[... ${(text.length - DISPLAY_MAX).toLocaleString("en-US")} characters omitted ...]\n${text.slice(-tail)}`;
}

function summarize(d: Descriptor): string {
	return clipForDisplay(d.tool === "bash" ? (d.command ?? "") : `${d.tool} ${d.paths.join(", ")}`);
}

/** Why the call was flagged, in a few words. */
function cause(decision: Decision): string {
	if (decision.source === "oversize" && decision.reason) return decision.reason;
	if (decision.verdict) return decision.verdict.reason;
	const labels = decision.matched.map((m) => m.rule.label ?? m.rule.pattern ?? m.id);
	if (labels.length > 0) return [...new Set(labels)].join("; ");
	return `policy for unmatched ${decision.source === "unmatched" ? "calls" : "actions"}`;
}

function blockReason(decision: Decision, d: Descriptor): string {
	// Legacy rules carry the model-facing reason in `message`
	if (decision.source === "rule" && decision.rule?.rule.message) return decision.rule.rule.message;
	const advice =
		decision.source === "oversize"
			? "This action is too large to be reviewed automatically. If it is truly needed, explain why to the user and let them run or approve it; do not split it up just to get under the limit."
			: "This is a policy block, not a transient or environment error. Do not retry it, and do not retry the same operation rewritten to avoid the match. If the action is truly needed, explain why to the user and let them decide.";
	return [
		`Blocked by command-guard: ${cause(decision)}.`,
		advice,
		`Action that was blocked:\n${summarize(d)}`,
	].join("\n\n");
}

function confirmMessage(decision: Decision, d: Descriptor): string {
	// Legacy rules carry the human-facing question in `message`
	if (decision.source === "rule" && decision.rule?.rule.message && !decision.verdict) {
		return decision.rule.rule.message;
	}
	const lines = [cause(decision)];
	if (decision.reason && decision.source !== "oversize") lines.push(`(${decision.reason})`);
	if (decision.verdict && Object.keys(decision.verdict.scores).length > 0) {
		const scores = Object.entries(decision.verdict.scores)
			.map(([k, v]) => `${k} ${v.toFixed(2)}`)
			.join(", ");
		lines.push(`Scores: ${scores}`);
	}
	for (const note of decision.verdict?.notes ?? []) lines.push(`Note: ${note}`);
	lines.push("", summarize(d), "", "Allow?");
	return lines.join("\n");
}

function declineReason(decision: Decision, d: Descriptor): string {
	if (decision.rule?.rule.denyMessage) return decision.rule.rule.denyMessage;
	return [
		`The user declined to run this action (${cause(decision)}); it did not execute.`,
		"This is a refusal by the user, not an environment, permission, or syntax error, and not a temporary failure.",
		"Do not retry it, and do not retry the same operation rewritten to avoid the matched pattern.",
		`Action that was refused:\n${summarize(d)}`,
	].join("\n\n");
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
		const d = describeToolCall(event, ctx.cwd, deps.home);
		if (!d) return undefined;

		const decision = await decide(d, deps.policy, {
			home: deps.home,
			userMessages: () => deps.turnBuffer.messages(),
			delegated: deps.delegated,
			judge: deps.judge,
			signal: ctx.signal,
		});
		// The user cancelled while the decision model was thinking: do not open a dialog now
		if (ctx.signal?.aborted) return ABORTED;

		const entry: AuditEntry = {
			tool: d.tool,
			toolCallId: event.toolCallId,
			outcome: decision.outcome,
			source: decision.source,
			rules: decision.matched.map((m) => m.id),
			scores: decision.verdict?.scores,
			judgeError: decision.verdict?.error,
		};
		const worthLogging =
			decision.source === "rule" || decision.source === "judge" || decision.source === "oversize";

		if (decision.outcome === "allow") {
			if (worthLogging) audit(entry);
			return undefined;
		}

		if (decision.outcome === "block") {
			audit(entry);
			return { block: true, reason: blockReason(decision, d) };
		}

		// confirm
		if (!ctx.hasUI) {
			audit(entry);
			return {
				block: true,
				reason: `Blocked by command-guard: ${cause(decision)}. This action needs the user's confirmation, but no UI is available to ask (non-interactive mode), so it cannot be confirmed. Do not retry.`,
			};
		}
		const title =
			decision.source === "oversize"
				? "Oversized action"
				: (decision.rule?.rule.label ?? "command-guard");
		const confirmed = await ctx.ui.confirm(title, confirmMessage(decision, d), {
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
