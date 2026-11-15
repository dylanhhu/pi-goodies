/**
 * Check-in scheduling state.
 *
 * State lives in the session file (one `custom` entry per mutation) so `/reload` and `/resume`
 * bring the timers back. Everything here is pure: the runtime owns the clocks, this module owns
 * the rules — how many check-ins may exist, what a valid cadence is, what firing does to a
 * check-in's counter, and how a stored state is validated on the way back in.
 */

import { formatDuration, MAX_DURATION_MS, MIN_ONESHOT_MS, MIN_RECURRING_MS } from "./duration.ts";

/** What to do when the timer fires while the agent is already working. */
export type BusyPolicy = "queue" | "skip";

export interface Checkin {
	/** Stable handle, also the compact display name. */
	id: string;
	/** Human-facing name, unique case-insensitively, defaulted from the prompt. */
	label: string;
	/** Text sent to the agent as a user message when the check-in fires. */
	prompt: string;
	/** Recurring cadence. Absent for a one-shot. */
	intervalMs?: number;
	/** One-shot delay. Absent for a recurring check-in. */
	delayMs?: number;
	/** Stop after this many firings. Absent means unlimited. */
	maxRuns?: number;
	whenBusy: BusyPolicy;
	/** Firings so far, including ones skipped because the agent was busy. */
	runs: number;
	createdAt: number;
	/** Epoch milliseconds of the next firing. Recomputed when a session resumes. */
	nextAt: number;
}

export interface CheckinState {
	/** Monotonic counter behind `id`, persisted so ids survive a resume. */
	seq: number;
	checkins: Checkin[];
}

export const EMPTY_STATE: CheckinState = { seq: 0, checkins: [] };

/** Concurrent check-ins per session. Beyond this the transcript turns into a metronome. */
export const MAX_CHECKINS = 12;
export const MAX_PROMPT_CHARS = 2_000;
export const MAX_LABEL_CHARS = 40;

export interface AddCheckinInput {
	prompt: string;
	label?: string;
	/** Recurring cadence in milliseconds. Mutually exclusive with `inMs`. */
	everyMs?: number;
	/** One-shot delay in milliseconds. Mutually exclusive with `everyMs`. */
	inMs?: number;
	maxRuns?: number;
	whenBusy?: BusyPolicy;
	now: number;
}

export type AddCheckinResult =
	| { ok: true; state: CheckinState; checkin: Checkin }
	| { ok: false; error: string };

export type ResolveResult = { ok: true; checkin: Checkin } | { ok: false; error: string };

function uniqLabel(state: CheckinState, label: string, id: string): string {
	const taken = new Set(state.checkins.map((c) => c.label.toLowerCase()));
	if (!taken.has(label.toLowerCase())) return label;
	return `${label} (${id})`;
}

/** First line of the prompt, stripped of Markdown markers, trimmed to fit a footer or a list. */
export function deriveLabel(prompt: string): string {
	const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? prompt;
	const cleaned = firstLine
		.replace(/[*_`>#]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= MAX_LABEL_CHARS) return cleaned || "check-in";
	return `${cleaned.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`;
}

export function addCheckin(state: CheckinState, input: AddCheckinInput): AddCheckinResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		return { ok: false, error: "A prompt is required: the text to send when the check-in fires." };
	}
	if (prompt.length > MAX_PROMPT_CHARS) {
		return {
			ok: false,
			error: `The prompt is ${prompt.length} characters; keep it under ${MAX_PROMPT_CHARS}.`,
		};
	}
	if (state.checkins.length >= MAX_CHECKINS) {
		return {
			ok: false,
			error: `Already ${MAX_CHECKINS} check-ins in this session. Remove one before adding another.`,
		};
	}

	const hasEvery = input.everyMs !== undefined;
	const hasIn = input.inMs !== undefined;
	if (hasEvery === hasIn) {
		return { ok: false, error: 'Set exactly one of "every" (recurring) or "in" (one-shot).' };
	}

	let intervalMs: number | undefined;
	let delayMs: number | undefined;
	if (hasEvery) {
		const every = input.everyMs as number;
		if (!Number.isFinite(every) || every < MIN_RECURRING_MS) {
			return {
				ok: false,
				error: `Recurring check-ins need an interval of at least ${formatDuration(MIN_RECURRING_MS)}.`,
			};
		}
		if (every > MAX_DURATION_MS) {
			return { ok: false, error: `The interval is capped at ${formatDuration(MAX_DURATION_MS)}.` };
		}
		intervalMs = Math.round(every);
	} else {
		const delay = input.inMs as number;
		if (!Number.isFinite(delay) || delay < MIN_ONESHOT_MS) {
			return {
				ok: false,
				error: `One-shot delays must be at least ${formatDuration(MIN_ONESHOT_MS)}.`,
			};
		}
		if (delay > MAX_DURATION_MS) {
			return { ok: false, error: `The delay is capped at ${formatDuration(MAX_DURATION_MS)}.` };
		}
		delayMs = Math.round(delay);
	}

	if (input.maxRuns !== undefined) {
		if (intervalMs === undefined) {
			return {
				ok: false,
				error: '"maxRuns" applies to recurring check-ins; a one-shot runs once.',
			};
		}
		if (!Number.isInteger(input.maxRuns) || input.maxRuns < 1) {
			return { ok: false, error: '"maxRuns" must be a whole number of at least 1.' };
		}
		if (input.maxRuns > 1_000) {
			return { ok: false, error: '"maxRuns" is capped at 1000.' };
		}
	}

	const label = (input.label?.trim() || deriveLabel(prompt)).slice(0, MAX_LABEL_CHARS).trim();
	if (!label) return { ok: false, error: "The label is empty after trimming." };

	const seq = state.seq + 1;
	const id = `c${seq}`;
	const checkin: Checkin = {
		id,
		label: uniqLabel(state, label, id),
		prompt,
		...(intervalMs === undefined ? { delayMs } : { intervalMs }),
		...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
		whenBusy: input.whenBusy ?? "queue",
		runs: 0,
		createdAt: input.now,
		nextAt: input.now + (intervalMs ?? (delayMs as number)),
	};

	return { ok: true, state: { seq, checkins: [...state.checkins, checkin] }, checkin };
}

/**
 * Resolve a handle the way a person would type it: id, exact label, or an unambiguous label prefix.
 * Ambiguity is reported rather than guessed, since removing the wrong timer is silent.
 */
export function resolveCheckin(state: CheckinState, handle: string): ResolveResult {
	const wanted = handle.trim().toLowerCase();
	if (!wanted) return { ok: false, error: "Give a check-in id or label." };

	const byId = state.checkins.find((c) => c.id.toLowerCase() === wanted);
	if (byId) return { ok: true, checkin: byId };

	const byLabel = state.checkins.filter((c) => c.label.toLowerCase() === wanted);
	if (byLabel.length === 1) return { ok: true, checkin: byLabel[0] as Checkin };

	const byPrefix = state.checkins.filter((c) => c.label.toLowerCase().startsWith(wanted));
	if (byPrefix.length === 1) return { ok: true, checkin: byPrefix[0] as Checkin };
	if (byPrefix.length > 1) {
		const ids = byPrefix.map((c) => `${c.id} (${c.label})`).join(", ");
		return { ok: false, error: `"${handle}" matches ${byPrefix.length} check-ins: ${ids}.` };
	}
	if (byLabel.length > 1) {
		return {
			ok: false,
			error: `"${handle}" matches several check-ins; use an id instead.`,
		};
	}
	return { ok: false, error: `No check-in matches "${handle}".` };
}

export function removeCheckin(
	state: CheckinState,
	handle: string,
): { ok: true; state: CheckinState; checkin: Checkin } | { ok: false; error: string } {
	const resolved = resolveCheckin(state, handle);
	if (!resolved.ok) return resolved;
	const { checkin } = resolved;
	return {
		ok: true,
		checkin,
		state: { ...state, checkins: state.checkins.filter((c) => c.id !== checkin.id) },
	};
}

export function clearCheckins(state: CheckinState): { state: CheckinState; removed: number } {
	return { state: { ...state, checkins: [] }, removed: state.checkins.length };
}

export interface FireResult {
	state: CheckinState;
	/** The check-in as rescheduled, or undefined when this firing retired it. */
	next?: Checkin;
}

/** Account for one firing: bump the counter, reschedule, or drop a finished check-in. */
export function recordFire(state: CheckinState, id: string, now: number): FireResult {
	const target = state.checkins.find((c) => c.id === id);
	if (!target) return { state };

	const runs = target.runs + 1;
	const exhausted = target.maxRuns !== undefined && runs >= target.maxRuns;
	const intervalMs = target.intervalMs;
	if (intervalMs === undefined || exhausted) {
		return { state: { ...state, checkins: state.checkins.filter((c) => c.id !== id) } };
	}

	const next: Checkin = { ...target, runs, nextAt: now + intervalMs };
	const checkins = state.checkins.map((c) => (c.id === id ? next : c));
	return { state: { ...state, checkins }, next };
}

/** Soonest scheduled check-in, for the footer status and for nothing else. */
export function nextDue(state: CheckinState): Checkin | undefined {
	let earliest: Checkin | undefined;
	for (const checkin of state.checkins) {
		if (!earliest || checkin.nextAt < earliest.nextAt) earliest = checkin;
	}
	return earliest;
}

function cadence(checkin: Checkin): string {
	if (checkin.intervalMs !== undefined) return `every ${formatDuration(checkin.intervalMs)}`;
	return "one-shot";
}

/** One list line: handle, what it does, what is left, and the prompt that fires. */
export function describeCheckin(checkin: Checkin, now: number): string {
	const due = Math.max(0, checkin.nextAt - now);
	const parts = [cadence(checkin), `next in ${formatDuration(due)}`];
	if (checkin.maxRuns !== undefined) parts.push(`runs ${checkin.runs}/${checkin.maxRuns}`);
	else if (checkin.runs > 0) parts.push(`${checkin.runs} run${checkin.runs === 1 ? "" : "s"}`);
	if (checkin.whenBusy === "skip") parts.push("skip if busy");
	const head = `[${checkin.id}] ${checkin.label} — ${parts.join(", ")}`;
	const prompt = checkin.prompt.replace(/\s+/g, " ").trim();
	return `${head}\n      ${prompt.length > 160 ? `${prompt.slice(0, 159)}…` : prompt}`;
}

export function describeState(state: CheckinState, now: number): string {
	if (state.checkins.length === 0) return "No check-ins scheduled.";
	return state.checkins.map((c) => describeCheckin(c, now)).join("\n");
}

/** Compact footer text: what is scheduled and when the next one lands. */
export function statusText(state: CheckinState, now: number): string | undefined {
	if (state.checkins.length === 0) return undefined;
	const next = nextDue(state);
	if (!next) return undefined;
	const due = formatDuration(Math.max(0, next.nextAt - now));
	if (state.checkins.length > 1) return `check-ins: ${state.checkins.length}, next ${due}`;
	const label = next.label.length > 30 ? `${next.label.slice(0, 29).trimEnd()}…` : next.label;
	return `check-in: ${label} in ${due}`;
}

/** The user message a firing turns into. The header tells the model why it is not idle by itself. */
export function formatFireMessage(checkin: Checkin): string {
	const run = checkin.runs + 1;
	const cadenceText =
		checkin.intervalMs !== undefined ? `every ${formatDuration(checkin.intervalMs)}` : "one-shot";
	const count = checkin.maxRuns !== undefined ? `run ${run}/${checkin.maxRuns}` : `run ${run}`;
	return `[check-in ${checkin.label} · ${cadenceText} · ${count}] ${checkin.prompt}`;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeOne(raw: unknown, fallbackSeq: number): Checkin | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
	const label = typeof value.label === "string" ? value.label.trim() : "";
	if (!prompt || !label) return undefined;

	const intervalMs = positiveNumber(value.intervalMs);
	const delayMs = positiveNumber(value.delayMs);
	if ((intervalMs === undefined) === (delayMs === undefined)) return undefined;

	const runs = typeof value.runs === "number" && value.runs >= 0 ? Math.floor(value.runs) : 0;
	const createdAt = positiveNumber(value.createdAt) ?? Date.now();
	const nextAt =
		typeof value.nextAt === "number" && Number.isFinite(value.nextAt) ? value.nextAt : createdAt;
	const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : `c${fallbackSeq}`;
	const whenBusy: BusyPolicy = value.whenBusy === "skip" ? "skip" : "queue";
	const maxRuns =
		typeof value.maxRuns === "number" && Number.isInteger(value.maxRuns) && value.maxRuns >= 1
			? value.maxRuns
			: undefined;

	return {
		id,
		label: label.slice(0, MAX_LABEL_CHARS),
		prompt: prompt.slice(0, MAX_PROMPT_CHARS),
		...(intervalMs === undefined ? { delayMs } : { intervalMs }),
		...(maxRuns === undefined ? {} : { maxRuns }),
		whenBusy,
		runs,
		createdAt,
		nextAt,
	};
}

/**
 * Validate a state restored from the session file. Unknown fields are dropped and malformed
 * check-ins are discarded rather than crashing the extension, since this data outlives the
 * code that wrote it.
 */
export function sanitizeState(raw: unknown): CheckinState {
	if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
	const value = raw as Record<string, unknown>;
	const list = Array.isArray(value.checkins) ? value.checkins : [];
	const checkins: Checkin[] = [];
	for (const item of list.slice(0, MAX_CHECKINS)) {
		const checkin = sanitizeOne(item, checkins.length + 1);
		if (checkin) checkins.push(checkin);
	}

	const declaredSeq =
		typeof value.seq === "number" && Number.isInteger(value.seq) && value.seq >= 0 ? value.seq : 0;
	const maxSeen = checkins.reduce((max, c) => {
		const match = /^c(\d+)$/.exec(c.id);
		return match ? Math.max(max, Number.parseInt(match[1] as string, 10)) : max;
	}, 0);

	return { seq: Math.max(declaredSeq, maxSeen, checkins.length), checkins };
}
