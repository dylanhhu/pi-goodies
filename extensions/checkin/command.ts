/**
 * `/checkin` argument grammar.
 *
 * Deliberately small: a duration in the first position means recurring, `in` means one-shot, and
 * the rest of the line is the prompt. The model gets the richer parameter surface through the tool;
 * a person typing at the prompt should not have to remember flags.
 */

import { type DurationParse, parseDuration } from "./duration.ts";

export type CommandIntent =
	| { kind: "list" }
	| { kind: "help" }
	| { kind: "clear" }
	| { kind: "remove"; handle: string }
	| {
			kind: "add";
			prompt: string;
			every?: DurationParse;
			in?: DurationParse;
			whenBusy: "queue" | "skip";
	  }
	| { kind: "error"; message: string };

export const HELP = `checkin — periodic messages to yourself in this session

  /checkin 30m check the deploy          recurring every 30 minutes
  /checkin 1h30m summarize progress      compound intervals work
  /checkin 30 review the open TODOs      a bare number means minutes
  /checkin in 10m look at the build      one-shot after 10 minutes
  /checkin list                          show scheduled check-ins
  /checkin remove <id|label>             cancel one
  /checkin clear                         cancel all

Add --skip to any scheduling form to drop a firing while the agent is busy instead of
queueing it. Check-ins live in this session only and survive /reload and /resume; they
stop when pi exits. Every firing starts a full turn, so prefer intervals of 10 minutes
or more.`;

/** Strip one layer of matching quotes, so `/checkin in 5m "check the build"` keeps its text. */
export function unquote(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0] as string;
		const last = trimmed[trimmed.length - 1] as string;
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

export function parseCommandArgs(args: string): CommandIntent {
	const withoutFlags = args.split(/\s+/);
	const whenBusy = withoutFlags.includes("--skip") ? "skip" : "queue";
	const tokens = withoutFlags.filter((token) => token !== "--skip").filter(Boolean);

	const head = (tokens[0] ?? "").toLowerCase();
	if (!head || head === "list" || head === "ls") return { kind: "list" };
	if (head === "help" || head === "?") return { kind: "help" };
	if (head === "clear" || head === "reset") return { kind: "clear" };

	if (head === "remove" || head === "rm" || head === "cancel" || head === "stop") {
		const handle = unquote(tokens.slice(1).join(" "));
		if (!handle) return { kind: "error", message: "Give a check-in id or label to remove." };
		return { kind: "remove", handle };
	}

	if (head === "in" || head === "once") {
		const duration = tokens[1];
		if (!duration) return { kind: "error", message: '"in" needs a delay, for example: in 10m' };
		return addIntent(
			unquote(tokens.slice(2).join(" ")),
			undefined,
			parseDuration(duration),
			whenBusy,
		);
	}

	if (head === "every") {
		const duration = tokens[1];
		if (!duration) {
			return { kind: "error", message: '"every" needs an interval, for example: every 30m' };
		}
		return addIntent(
			unquote(tokens.slice(2).join(" ")),
			parseDuration(duration),
			undefined,
			whenBusy,
		);
	}

	const maybeDuration = parseDuration(tokens[0] as string);
	if (maybeDuration.ok) {
		return addIntent(unquote(tokens.slice(1).join(" ")), maybeDuration, undefined, whenBusy);
	}

	return {
		kind: "error",
		message: `"${tokens[0]}" is neither an interval nor a subcommand. Use /checkin help.`,
	};
}

function addIntent(
	prompt: string,
	every: DurationParse | undefined,
	oneShot: DurationParse | undefined,
	whenBusy: "queue" | "skip",
): CommandIntent {
	if (!prompt) {
		return { kind: "error", message: "A prompt is required: what should be sent when it fires?" };
	}
	if (every && !every.ok) return { kind: "error", message: every.error };
	if (oneShot && !oneShot.ok) return { kind: "error", message: oneShot.error };
	return { kind: "add", prompt, every, in: oneShot, whenBusy };
}
