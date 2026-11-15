/**
 * The `checkin` tool: the model's own way to set up periodic follow-up.
 *
 * The tool exists so the agent can watch something without the user having to ask again —
 * "tell me when the build finishes", "check the deploy every 15 minutes". It is session-scoped
 * and dies with the process, so the description says so rather than implying a real cron.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseDuration } from "./duration.ts";
import type { CheckinRuntime } from "./runtime.ts";
import { type Checkin, describeState, type ResolveResult } from "./schedule.ts";

export type CheckinAction = "add" | "list" | "remove" | "clear";

export interface CheckinToolDetails {
	action: CheckinAction;
	checkins: Checkin[];
}

const parameters = Type.Object({
	action: StringEnum(["add", "list", "remove", "clear"] as const, {
		description:
			"add schedules a check-in; list shows them; remove cancels one by id or label; clear cancels all.",
	}),
	prompt: Type.Optional(
		Type.String({
			description:
				"add: the message to send yourself when the check-in fires. Write it self-contained, since it arrives with no other context.",
		}),
	),
	every: Type.Optional(
		Type.String({
			description:
				"add: recurring interval such as 30m, 2h, or 1h30m. Mutually exclusive with in. Minimum 30s.",
		}),
	),
	in: Type.Optional(
		Type.String({
			description: "add: one-shot delay such as 10m or 45s. Mutually exclusive with every.",
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "add: short name for the check-in, shown in the footer and accepted by remove.",
		}),
	),
	maxRuns: Type.Optional(
		Type.Number({
			description: "add: stop after this many firings. Recurring check-ins only.",
		}),
	),
	whenBusy: Type.Optional(
		StringEnum(["queue", "skip"] as const, {
			description:
				"add: what to do if the check-in fires while you are mid-turn. queue (default) delivers it after the current run; skip drops it and reports the skip.",
		}),
	),
	handle: Type.Optional(
		Type.String({ description: "remove: the check-in id (c1) or label to cancel." }),
	),
});

type CheckinParams = {
	action: CheckinAction;
	prompt?: string;
	every?: string;
	in?: string;
	label?: string;
	maxRuns?: number;
	whenBusy?: "queue" | "skip";
	handle?: string;
};

export function createCheckinTool(runtime: CheckinRuntime, now: () => number) {
	return defineTool({
		name: "checkin",
		label: "Check-in",
		description:
			'Schedule a message to yourself later in this session: action "add" with a prompt and either a recurring interval (every) or a one-shot delay (in), "list" to show what is scheduled, "remove" to cancel one, "clear" to cancel all. Check-ins fire only while this pi process is running; they are not OS cron jobs and do not survive exit.',
		promptSnippet: "Schedule recurring or one-shot self check-ins in this session",
		promptGuidelines: [
			"Use checkin when the user asks you to keep an eye on something, poll for a change, or come back to it later in the session.",
			"Keep checkin intervals at 10 minutes or longer unless the user asks otherwise: each firing starts a full turn and costs tokens.",
			"Write each checkin prompt so it stands alone, and prefer maxRuns or a short interval over an open-ended cadence when the condition will resolve.",
			"Set checkin whenBusy to skip when a check-in should not interrupt an unrelated long task.",
		],
		parameters,

		async execute(_toolCallId, params) {
			const input = params as CheckinParams;
			const finish = (
				text: string,
				action: CheckinAction,
				isError = false,
			): {
				content: { type: "text"; text: string }[];
				details: CheckinToolDetails;
				isError?: boolean;
			} => ({
				content: [{ type: "text", text }],
				details: { action, checkins: runtime.state().checkins },
				...(isError ? { isError: true } : {}),
			});

			if (input.action === "list") {
				return finish(describeState(runtime.state(), now()), "list");
			}

			if (input.action === "clear") {
				const removed = runtime.clear();
				return finish(
					removed === 0 ? "No check-ins to clear." : `Cleared ${removed} check-in(s).`,
					"clear",
				);
			}

			if (input.action === "remove") {
				const handle = input.handle?.trim();
				if (!handle)
					return finish(
						'"remove" needs a handle: a check-in id such as c1 or its label.',
						"remove",
						true,
					);
				const result: ResolveResult = runtime.remove(handle);
				if (!result.ok) return finish(result.error, "remove", true);
				return finish(`Removed check-in [${result.checkin.id}] ${result.checkin.label}.`, "remove");
			}

			if (!input.prompt?.trim()) {
				return finish(
					'"add" needs a prompt: the text to send when the check-in fires.',
					"add",
					true,
				);
			}
			if (input.every !== undefined && input.in !== undefined) {
				return finish('Give either "every" or "in", not both.', "add", true);
			}
			if (input.every === undefined && input.in === undefined) {
				return finish('"add" needs either "every" (recurring) or "in" (one-shot).', "add", true);
			}

			let everyMs: number | undefined;
			let inMs: number | undefined;
			if (input.every !== undefined) {
				const parsed = parseDuration(input.every);
				if (!parsed.ok) return finish(parsed.error, "add", true);
				everyMs = parsed.ms;
			}
			if (input.in !== undefined) {
				const parsed = parseDuration(input.in);
				if (!parsed.ok) return finish(parsed.error, "add", true);
				inMs = parsed.ms;
			}

			const result = runtime.add({
				prompt: input.prompt,
				label: input.label,
				everyMs,
				inMs,
				maxRuns: input.maxRuns,
				whenBusy: input.whenBusy,
			});
			if (!result.ok) return finish(result.error, "add", true);

			const { checkin } = result;
			const cadence =
				checkin.intervalMs !== undefined ? `every ${input.every}` : `once in ${input.in}`;
			return finish(
				`Scheduled [${checkin.id}] ${checkin.label} ${cadence}. It fires as a user message; the session must stay open.`,
				"add",
			);
		},
	});
}
