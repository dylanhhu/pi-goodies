/**
 * Retry Extension — regenerate from the last user prompt or the latest step
 *
 * `/retry` abandons the current turn and re-sends the last user prompt.
 * `/retry last` drops only the newest model-visible message and continues from
 * its parent. When the newest entry is a tool result, its assistant tool call is
 * dropped with it so the model retries the whole step.
 *
 * No command writes a synthetic instruction. Pi's extension API has no way to
 * continue a transcript (`AgentSession.continue()` is internal), so a run can
 * only start from a message. Both `restart` plans therefore start the run with a
 * trigger that pi's `context` handler strips again before every request: the
 * model continues from the branch point exactly as it stood, with nothing added
 * to what it reads. Where pi would move the leaf past the branch point (it keeps
 * the leaf off user and custom messages), the prompt is replayed instead.
 *
 * `/continue` resumes rather than retries: it discards nothing and leaves the
 * leaf alone, so after an esc the model reads the cancelled tool result or the
 * answer it was cut off in. A finished turn has nothing to resume, so the
 * command reports that instead of asking the model to answer nothing.
 *
 * Sessions are append-only, so discarded entries remain on the abandoned branch
 * and are still visible in `/tree`; they no longer contribute to context.
 *
 * Branch points are chosen from the session projection, not from raw entries:
 * pi omits retried attempts and context-edited messages from the projection, and
 * a plan that counted those entries would replay a prompt instead of continuing
 * from the last message the model actually saw.
 *
 * Usage:
 *   /retry        Re-send the last user prompt (whole-turn retry)
 *   /retry last   Drop the latest message/step and continue from before it
 *   /retry help   Show usage, aliases, and behavior notes
 *   /continue     Resume an interrupted run from where it stopped
 *
 * `navigateTree()` treats user and custom messages specially: selecting one
 * moves the leaf to its parent and copies its text to the editor. Both commands
 * compensate for that, re-sending the prompt when the branch point itself needs
 * to be preserved and restoring any editor draft or queued messages afterward.
 *
 * An unresolved assistant tool call followed by a newer entry is dropped along
 * with that entry; otherwise the retry would leave a tool call without a result.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProjectedSessionEntry,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Custom type of the run trigger, stripped from context so the model never sees it. */
const TRIGGER_TYPE = "retry-trigger";

/** One model-visible step of the active branch, mapped back to the entry that produced it. */
export interface RetryStep {
	entry: SessionEntry;
	/** Side of the transcript the step projects onto. */
	side: "user" | "assistant" | "toolResult";
	/** Whether the projected step still carries tool calls, which a result can belong to. */
	toolCalls: boolean;
	/** Whether the step can be re-sent as a prompt: user and custom messages only. */
	replayable: boolean;
	/** Assistant stop reason, when the step is an assistant message. */
	stopReason?: string;
}

/** Read access to raw entries; `ctx.sessionManager` satisfies it. */
export interface EntryLookup {
	getEntry(id: string): SessionEntry | undefined;
}

/**
 * What the command should do after branching:
 * - `replay` navigates to `navigateTo` and re-sends `prompt`, because pi leaves
 *   the leaf off user and custom messages and a run needs that prompt to start
 * - `restart` starts a run with the invisible trigger, from `navigateTo` or from
 *   the current leaf when it is null, so the model continues from there
 * - `none` reports that there is nothing to resume and changes nothing
 * - `error` explains why no runnable branch point exists
 */
export type RetryPlan =
	| { kind: "replay"; navigateTo: SessionEntry; prompt: SessionEntry }
	| { kind: "restart"; navigateTo: SessionEntry | null }
	| { kind: "none"; message: string }
	| { kind: "error"; message: string };

function isUserOrCustomMessage(entry: SessionEntry): boolean {
	return (
		entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user")
	);
}

/**
 * Collapse the projection into the steps a provider request would contain.
 * Entries that contribute no message are dropped: state entries, messages
 * omitted by a context edit, and the stale compaction checkpoints pi suppresses.
 */
export function projectSteps(projected: readonly ProjectedSessionEntry[]): RetryStep[] {
	const steps: RetryStep[] = [];
	for (const { sourceEntry, messages } of projected) {
		const step = messages.at(-1);
		if (!step) continue;
		// Pi's own prompt and tool declarations cannot end a request.
		if (step.role === "system") continue;
		steps.push({
			entry: sourceEntry,
			side:
				step.role === "assistant"
					? "assistant"
					: step.role === "toolResult"
						? "toolResult"
						: "user",
			toolCalls: step.role === "assistant" && step.content.some((part) => part.type === "toolCall"),
			replayable: isUserOrCustomMessage(sourceEntry),
			stopReason: step.role === "assistant" ? step.stopReason : undefined,
		});
	}
	return steps;
}

/** Index of the newest assistant step at or above `index`, or `index` when there is none. */
function assistantAbove(steps: readonly RetryStep[], index: number): number {
	for (let i = index; i >= 0; i--) {
		if (steps[i].side === "assistant") return i;
	}
	return index;
}

/**
 * Decide how `/retry last` branches. `steps` is the active projection, so the
 * newest step is the one being discarded.
 */
export function planRetryLast(steps: readonly RetryStep[], lookup: EntryLookup): RetryPlan {
	if (steps.length === 0) return { kind: "error", message: "No message to retry" };

	let index = steps.length - 1;
	// A tool result belongs to the assistant message that requested it. Drop both
	// so the request is re-issued instead of leaving an orphan tool call.
	if (steps[index].side === "toolResult") index = assistantAbove(steps, index);

	// An interrupted tool call can be followed by a user or custom message.
	// Dropping only that newer entry would leave an assistant tool call without a
	// result, which providers reject.
	while (steps[index].side !== "toolResult" && index > 0 && steps[index - 1].toolCalls) {
		index--;
	}

	const cut = steps[index];
	const parent = cut.entry.parentId ? lookup.getEntry(cut.entry.parentId) : undefined;

	// Nothing precedes the cut, so the prompt itself has to be restored.
	if (!parent) {
		return cut.replayable
			? { kind: "replay", navigateTo: cut.entry, prompt: cut.entry }
			: { kind: "error", message: "Cannot retry the root entry" };
	}

	// Navigating to a user or custom message drops it too, so re-send it instead
	// of trying to continue from it.
	if (isUserOrCustomMessage(parent)) {
		return { kind: "replay", navigateTo: parent, prompt: parent };
	}

	// The branch point stays as the leaf; whatever state entries sit between it
	// and the cut are preserved.
	const above = index > 0 ? steps[index - 1] : undefined;

	// A request cannot end on an assistant message, and pi's own continuation
	// refuses that role. Fall back to the prompt that produced the exchange.
	if (above?.side === "assistant") {
		for (let i = index - 1; i >= 0; i--) {
			if (steps[i].replayable) {
				return { kind: "replay", navigateTo: steps[i].entry, prompt: steps[i].entry };
			}
		}
		return { kind: "error", message: "Cannot retry: a run cannot start on an assistant message" };
	}

	return { kind: "restart", navigateTo: parent };
}

/**
 * Decide how `/continue` branches: resume an interrupted run from where it
 * stopped, without discarding anything. The branch is not moved, so the model
 * reads the cancelled tool result or the partial answer it was cut off in.
 *
 * A finished turn has nothing to resume: pi is waiting for the user, and an
 * immediate request would only earn an empty reply. A trailing assistant and a
 * shell record or summary mean the run was over, not interrupted.
 */
export function planContinue(steps: readonly RetryStep[], lookup: EntryLookup): RetryPlan {
	const last = steps.at(-1);
	if (!last) return { kind: "none", message: "Nothing to continue: no model context yet" };

	if (last.side === "assistant") {
		// Tool calls that never ran have no result to continue from, which would put
		// an orphan tool call in front of the request. Re-issue the step instead.
		if (last.toolCalls) return planRetryLast(steps, lookup);
		if (last.stopReason === undefined || last.stopReason === "stop") {
			return {
				kind: "none",
				message: "Nothing to continue: the last turn finished (use /retry to regenerate it)",
			};
		}
		return { kind: "restart", navigateTo: null };
	}

	if (last.side === "toolResult") return { kind: "restart", navigateTo: null };

	// A prompt waiting for its answer can be answered. Summaries and shell records
	// are not prompts, and mean the run already finished.
	return last.replayable
		? { kind: "restart", navigateTo: null }
		: { kind: "none", message: "Nothing to continue: the last turn finished" };
}

/**
 * Decide how `/retry` branches: re-send the newest user prompt as a fresh turn.
 * A prompt that follows an interrupted tool call is branched before that call,
 * since an assistant tool call without a result is invalid context.
 */
export function planRetryTurn(steps: readonly RetryStep[]): RetryPlan {
	// Select the newest user message, not a custom message: `/retry` regenerates
	// the turn the user wrote.
	let prompt = -1;
	for (let i = steps.length - 1; i >= 0; i--) {
		const entry = steps[i].entry;
		if (entry.type === "message" && entry.message.role === "user") {
			prompt = i;
			break;
		}
	}
	if (prompt < 0) return { kind: "error", message: "No user message to retry" };

	let navigateTo = prompt;
	if (prompt > 0 && steps[prompt - 1].toolCalls) {
		let branch = prompt - 1;
		while (steps[branch].toolCalls) {
			const before = branch - 1;
			if (before < 0 || steps[before].replayable) {
				return { kind: "error", message: "Cannot retry across an unresolved tool call" };
			}
			branch = before;
		}
		navigateTo = branch;
	}

	return { kind: "replay", navigateTo: steps[navigateTo].entry, prompt: steps[prompt].entry };
}

async function navigate(ctx: ExtensionCommandContext, entryId: string): Promise<boolean> {
	const result = await ctx.navigateTree(entryId, { summarize: false });
	if (result.cancelled) {
		ctx.ui.notify("Retry cancelled", "warning");
		return false;
	}
	return true;
}

/** Recreate a user or custom-message entry after navigating past it. */
function replay(pi: ExtensionAPI, entry: SessionEntry): boolean {
	if (entry.type === "message" && entry.message.role === "user") {
		pi.sendUserMessage(entry.message.content);
		return true;
	}
	if (entry.type === "custom_message") {
		pi.sendMessage(
			{
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
			},
			{ triggerTurn: true },
		);
		return true;
	}
	return false;
}

/**
 * Start a run from the current leaf. The trigger only exists to start pi's agent
 * loop: the `context` handler in the factory strips it from every request, so
 * the model continues from the branch point and reads nothing new.
 */
function restartRun(pi: ExtensionAPI): void {
	pi.sendMessage({ customType: TRIGGER_TYPE, content: "", display: false }, { triggerTurn: true });
}

const HELP_TEXT = [
	"/retry — regenerate from the last prompt",
	"",
	"  /retry        Re-send the last user prompt (whole-turn retry)",
	"  /retry last   Drop the latest message or step and continue from before it",
	"  /retry help   This text",
	"",
	"`/retry last` also accepts `step` or `1`.",
	"",
	"Details:",
	"  /retry branches before the most recent user message and re-sends it.",
	"  /retry last drops the newest message the model saw and restarts the run",
	"  from its parent. Nothing is added to the transcript the model reads: a",
	"  branch point that is a prompt re-sends that prompt, and any other branch",
	"  point continues directly. Attempts pi retried were already omitted, so",
	"  they are not counted as steps.",
	"  A dropped tool result takes its assistant tool call with it, so the model",
	"  re-issues the whole step; an interrupted tool call is never left behind.",
	"  /continue discards nothing: after an esc it resumes from the cancelled tool",
	"  result or the cut-off answer, and does nothing when the last turn finished.",
	"  A gateway that rejects a request ending on an assistant message will fail",
	"  the continuation; use /retry last then.",
	"",
	"Discarded entries stay on the abandoned branch and remain visible in /tree.",
].join("\n");

const ARG_COMPLETIONS = [
	{
		value: "last",
		label: "last",
		description: "Drop the latest message or step and continue from before it",
	},
	{ value: "help", label: "help", description: "Show retry usage and behavior notes" },
];

function isHelpArg(args: string): boolean {
	return args
		.trim()
		.split(/\s+/)
		.some((token) => /^(?:help|\?|-h|--help)$/i.test(token));
}

type Scope = "turn" | "last" | "continue";

export default function (pi: ExtensionAPI) {
	// The trigger starts a run and carries no instruction, so the model never
	// reads it. Filtering is idempotent: triggers stay in the session on purpose,
	// and every later request drops them the same way.
	pi.on("context", (event) => {
		const kept = event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === TRIGGER_TYPE),
		);
		return kept.length === event.messages.length ? undefined : { messages: kept };
	});

	const handler = (scope: Scope) => async (ctx: ExtensionCommandContext) => {
		// Running while the agent is still streaming means "restart from where it
		// got to", so stop first and plan against the interrupted transcript.
		if (!ctx.isIdle()) {
			ctx.abort();
			await ctx.waitForIdle();
		}

		// Branch points come from the projection: retried attempts and edited
		// messages are already absent there, and counting them as steps would
		// branch one message too far back.
		const steps = projectSteps(ctx.sessionManager.buildSessionProjection().entries);
		const plan =
			scope === "turn"
				? planRetryTurn(steps)
				: scope === "last"
					? planRetryLast(steps, ctx.sessionManager)
					: planContinue(steps, ctx.sessionManager);

		if (plan.kind === "none") {
			ctx.ui.notify(plan.message, "info");
			return;
		}
		if (plan.kind === "error") {
			ctx.ui.notify(plan.message, "warning");
			return;
		}

		try {
			if (plan.navigateTo) {
				// Aborting restores queued messages to the editor, and navigateTree()
				// copies a selected prompt there. Put back whatever the user had.
				const editorText = ctx.ui.getEditorText();
				if (!(await navigate(ctx, plan.navigateTo.id))) return;
				ctx.ui.setEditorText(editorText);
			}
			if (plan.kind === "replay") {
				if (!replay(pi, plan.prompt)) ctx.ui.notify("Cannot re-send that message", "warning");
			} else {
				restartRun(pi);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	pi.registerCommand("retry", {
		description: "Retry the last user turn, or the latest message with /retry last",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart().toLowerCase();
			if (/\s/.test(trimmed)) return null;
			const matches = ARG_COMPLETIONS.filter((item) => item.value.startsWith(trimmed));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			if (isHelpArg(args)) {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			const arg = args.trim().toLowerCase();
			if (arg && arg !== "last" && arg !== "1" && arg !== "step") {
				ctx.ui.notify("Usage: /retry [last]  (see /retry help)", "warning");
				return;
			}
			await handler(arg ? "last" : "turn")(ctx);
		},
	});

	pi.registerCommand("continue", {
		description: "Resume an interrupted run from where it stopped",
		handler: async (args, ctx) => {
			if (isHelpArg(args)) {
				ctx.ui.notify(HELP_TEXT, "info");
				return;
			}
			await handler("continue")(ctx);
		},
	});
}
