/**
 * Retry Extension — regenerate from the last user prompt or the latest step
 *
 * `/retry` abandons the current turn and re-sends the last user prompt.
 * `/retry last` drops only the newest model-visible message and continues from
 * its parent. When the newest entry is a tool result, its assistant tool call is
 * dropped with it so the model retries the whole step.
 *
 * Sessions are append-only, so discarded entries remain on the abandoned branch
 * and are still visible in `/tree`; they no longer contribute to context.
 *
 * Usage:
 *   /retry        Re-send the last user prompt (whole-turn retry)
 *   /retry last   Drop the latest message/step and continue from before it
 *   /retry help   Show usage, aliases, and behavior notes
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
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

function isContextMessage(entry: SessionEntry): boolean {
	return (
		entry.type === "custom_message" || (entry.type === "message" && entry.message.role !== "system")
	);
}

function hasToolCalls(entry: SessionEntry): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall")
	);
}

function isUserOrCustomMessage(entry: SessionEntry): boolean {
	return (
		entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user")
	);
}

/** Nearest ancestor that contributes a model message, skipping state entries. */
function nearestContextAncestor(
	ctx: ExtensionCommandContext,
	entry: SessionEntry,
): SessionEntry | undefined {
	let id = entry.parentId;
	while (id) {
		const candidate = ctx.sessionManager.getEntry(id);
		if (!candidate) return undefined;
		if (isContextMessage(candidate)) return candidate;
		id = candidate.parentId;
	}
	return undefined;
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
	"  /retry last drops the newest model-visible entry and retries from its parent.",
	"  A dropped tool result takes its assistant tool call with it, so the model",
	"  re-issues the whole step; an interrupted tool call is never left behind.",
	"",
	"Discarded entries stay on the abandoned branch and remain visible in /tree.",
].join("\n");

const ARG_COMPLETIONS = [
	{
		value: "last",
		label: "last",
		description: "Drop the latest message or step and retry from before it",
	},
	{ value: "help", label: "help", description: "Show retry usage and behavior notes" },
];

function isHelpArg(args: string): boolean {
	return args
		.trim()
		.split(/\s+/)
		.some((token) => /^(?:help|\?|-h|--help)$/i.test(token));
}

export default function (pi: ExtensionAPI) {
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
			if (!ctx.isIdle()) {
				ctx.abort();
				await ctx.waitForIdle();
			}

			// Aborting restores queued messages to the editor; navigateTree() also
			// copies a selected prompt there. Put back whatever the user had.
			const editorText = ctx.ui.getEditorText();
			const scope = args.trim().toLowerCase();
			if (scope && scope !== "last" && scope !== "1" && scope !== "step") {
				ctx.ui.notify("Usage: /retry [last]  (see /retry help)", "warning");
				return;
			}

			const entries = ctx.sessionManager.buildContextEntries();

			if (!scope) {
				let lastUser: SessionEntry | undefined;
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i];
					if (entry.type === "message" && entry.message.role === "user") {
						lastUser = entry;
						break;
					}
				}
				if (!lastUser || lastUser.type !== "message" || lastUser.message.role !== "user") {
					ctx.ui.notify("No user message to retry", "warning");
					return;
				}

				try {
					// Selecting a user message moves the leaf to its parent and copies the
					// prompt to the editor. Re-send it to branch with the prompt intact.
					// If an interrupted tool call sits directly before the prompt, branch
					// before that call instead; otherwise the retried prompt would follow
					// an assistant tool call with no matching result.
					let target: SessionEntry = lastUser;
					const ancestor = nearestContextAncestor(ctx, lastUser);
					if (ancestor && hasToolCalls(ancestor)) {
						let branchPoint = ancestor;
						while (hasToolCalls(branchPoint)) {
							const before = nearestContextAncestor(ctx, branchPoint);
							if (!before || isUserOrCustomMessage(before)) {
								ctx.ui.notify("Cannot retry across an unresolved tool call", "warning");
								return;
							}
							branchPoint = before;
						}
						target = branchPoint;
					}
					if (!(await navigate(ctx, target.id))) return;
					ctx.ui.setEditorText(editorText);
					pi.sendUserMessage(lastUser.message.content);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			let latestIndex = entries.length - 1;
			while (latestIndex >= 0 && !isContextMessage(entries[latestIndex])) latestIndex--;
			if (latestIndex < 0) {
				ctx.ui.notify("No message to retry", "warning");
				return;
			}

			let cut = entries[latestIndex];
			// A tool result belongs to the assistant message that requested it. Drop
			// both so the request is re-issued instead of leaving an orphan tool call.
			if (cut.type === "message" && cut.message.role === "toolResult") {
				while (latestIndex >= 0) {
					const candidate = entries[latestIndex];
					if (candidate.type === "message" && candidate.message.role === "assistant") {
						cut = candidate;
						break;
					}
					latestIndex--;
				}
			}

			// An interrupted tool call can be followed by a user or custom message.
			// Dropping only that newer entry would leave an assistant tool call
			// without a result, which providers reject.
			while (!(cut.type === "message" && cut.message.role === "toolResult")) {
				const ancestor = nearestContextAncestor(ctx, cut);
				if (!ancestor || !hasToolCalls(ancestor)) break;
				cut = ancestor;
			}

			try {
				const parent = cut.parentId ? ctx.sessionManager.getEntry(cut.parentId) : undefined;

				// Selecting the root user/custom entry resets the leaf; replaying it is
				// the only way to produce a runnable context.
				if (!parent) {
					const replayable =
						cut.type === "custom_message" ||
						(cut.type === "message" && cut.message.role === "user");
					if (!replayable) {
						ctx.ui.notify("Cannot retry the root entry", "warning");
						return;
					}
					if (!(await navigate(ctx, cut.id))) return;
					ctx.ui.setEditorText(editorText);
					replay(pi, cut);
					return;
				}

				// Selecting a user or custom message drops it as well. Navigate to it,
				// then recreate it so only the newer entry is discarded.
				if (
					(parent.type === "message" && parent.message.role === "user") ||
					parent.type === "custom_message"
				) {
					if (!(await navigate(ctx, parent.id))) return;
					ctx.ui.setEditorText(editorText);
					replay(pi, parent);
					return;
				}

				if (!(await navigate(ctx, parent.id))) return;
				pi.sendMessage(
					{
						customType: "retry",
						content: "Retry the previous step from scratch.",
						display: false,
					},
					{ triggerTurn: true },
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
