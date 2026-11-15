/**
 * Check-in Extension — periodic messages to yourself inside a running session
 *
 * A check-in is a user message that pi sends on a timer, as if you had typed it: it starts a
 * normal turn with the usual tools and context. Both sides can create them — `/checkin 20m …`
 * from the prompt, and the `checkin` tool from the model, which lets the agent arrange its own
 * follow-up without being asked twice.
 *
 * Scope is deliberate. Timers live in this process, so they stop when pi exits; nothing here
 * touches cron, launchd, or a background daemon. Definitions are written to the session file as
 * custom entries, so `/reload` and `/resume` re-arm them, with fresh intervals measured from the
 * moment of resuming rather than from a stale stored deadline.
 *
 * Firing while the agent is mid-turn follows the per-check-in policy: `queue` (default) delivers
 * the message when the current run settles, `skip` drops that firing and says so. Either way the
 * firing counts against `maxRuns`, which is the recovery path for a cadence that outlived its
 * reason.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HELP, parseCommandArgs } from "./command.ts";
import { createRuntime, statusText } from "./runtime.ts";
import { describeCheckin, describeState } from "./schedule.ts";
import { createCheckinTool } from "./tool.ts";

const CHECKIN_ENTRY_TYPE = "checkin-state";
const STATUS_KEY = "checkin";

/** Last persisted state on the active branch, which is what a resume or reload should continue. */
function readPersistedState(ctx: ExtensionContext): unknown {
	let state: unknown;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CHECKIN_ENTRY_TYPE) continue;
		state = entry.data;
	}
	return state;
}

const now = (): number => Date.now();

export default function checkinExtension(pi: ExtensionAPI): void {
	/** Most recent context, kept because a firing needs `isIdle()` and has no event of its own. */
	let statusCtx: ExtensionContext | undefined;

	const runtime = createRuntime({
		now,
		setTimer: (ms, fire) => {
			const timer = setTimeout(fire, ms);
			// A pending check-in must never hold the process open: print and RPC runs end on their own.
			timer.unref?.();
			return timer;
		},
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		isBusy: () => statusCtx?.isIdle() === false,
		deliver: (text, { queue }) => {
			pi.sendUserMessage(text, queue ? { deliverAs: "followUp" } : undefined);
		},
		persist: (state) => pi.appendEntry(CHECKIN_ENTRY_TYPE, state),
		changed: () => syncStatus(),
		notify: (message, level) => statusCtx?.ui.notify(message, level),
	});

	function syncStatus(): void {
		if (!statusCtx?.hasUI) return;
		statusCtx.ui.setStatus(STATUS_KEY, statusText(runtime.state(), now()));
	}

	pi.on("session_start", (_event, ctx) => {
		statusCtx = ctx;
		const persisted = readPersistedState(ctx);
		runtime.restore(persisted);
		const count = runtime.state().checkins.length;
		if (count > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`checkin: resumed ${count} check-in${count === 1 ? "" : "s"}; intervals restart from now.`,
				"info",
			);
		}
		syncStatus();
	});

	pi.on("session_shutdown", () => {
		runtime.dispose();
		statusCtx?.ui.setStatus(STATUS_KEY, undefined);
		statusCtx = undefined;
	});

	pi.registerTool(createCheckinTool(runtime, now));

	pi.registerCommand("checkin", {
		description: "Schedule recurring or one-shot messages to yourself in this session",
		getArgumentCompletions: (prefix) => {
			const text = prefix.trimStart();
			if (text.startsWith("remove ") || text.startsWith("rm ")) {
				const handlePrefix = text.replace(/^\S+\s+/, "").toLowerCase();
				const items = runtime
					.state()
					.checkins.filter(
						(c) =>
							c.id.toLowerCase().startsWith(handlePrefix) ||
							c.label.toLowerCase().startsWith(handlePrefix),
					)
					.map((c) => ({ value: c.id, label: c.id, description: c.label }));
				return items.length > 0 ? items : null;
			}
			if (text.includes(" ")) return null;
			const commands = ["list", "in", "every", "remove", "clear", "help"];
			const matches = commands.filter((c) => c.startsWith(text.toLowerCase()));
			return matches.length > 0
				? matches.map((value) => ({ value, label: value, description: COMMAND_HINTS[value] }))
				: null;
		},
		handler: async (args, ctx) => {
			statusCtx = ctx;
			const intent = parseCommandArgs(args);

			if (intent.kind === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}
			if (intent.kind === "error") {
				ctx.ui.notify(`checkin: ${intent.message}`, "error");
				return;
			}
			if (intent.kind === "list") {
				ctx.ui.notify(describeState(runtime.state(), now()), "info");
				return;
			}
			if (intent.kind === "clear") {
				const removed = runtime.clear();
				ctx.ui.notify(
					removed === 0 ? "checkin: nothing scheduled" : `checkin: cleared ${removed}`,
					"info",
				);
				return;
			}
			if (intent.kind === "remove") {
				const result = runtime.remove(intent.handle);
				ctx.ui.notify(
					result.ok
						? `checkin: removed [${result.checkin.id}] ${result.checkin.label}`
						: `checkin: ${result.error}`,
					result.ok ? "info" : "error",
				);
				return;
			}

			// The parser has already rejected a malformed duration, so these are narrowed to valid ones.
			const result = runtime.add({
				prompt: intent.prompt,
				everyMs: intent.every?.ok ? intent.every.ms : undefined,
				inMs: intent.in?.ok ? intent.in.ms : undefined,
				whenBusy: intent.whenBusy,
			});
			ctx.ui.notify(
				result.ok
					? `checkin: ${describeCheckin(result.checkin, now())}`
					: `checkin: ${result.error}`,
				result.ok ? "info" : "error",
			);
		},
	});
}

const COMMAND_HINTS: Record<string, string> = {
	list: "show scheduled check-ins",
	in: "one-shot: in 10m <prompt>",
	every: "recurring: every 30m <prompt>",
	remove: "cancel one by id or label",
	clear: "cancel all",
	help: "usage and limits",
};
