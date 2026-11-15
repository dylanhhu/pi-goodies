/**
 * Duration parsing for check-in intervals.
 *
 * Check-ins are written by hand (`/checkin 30m …`) as often as by the model (`every: "30m"`),
 * so the parser accepts the forms people actually type: compound units (`1h30m`), spaced units
 * (`1h 30m`), and a bare number, which means minutes.
 */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Floor for a recurring interval. Shorter cadences queue turns faster than they can finish. */
export const MIN_RECURRING_MS = 30 * SECOND_MS;
/** Floor for a one-shot delay. No real cost below this, but avoids a timer used as a loop. */
export const MIN_ONESHOT_MS = 5 * SECOND_MS;
/** Ceiling for either kind. A timer beyond this outlives the reason it was set. */
export const MAX_DURATION_MS = DAY_MS;

export type DurationParse = { ok: true; ms: number } | { ok: false; error: string };

const UNIT_MS: Record<string, number> = {
	s: SECOND_MS,
	m: MINUTE_MS,
	h: HOUR_MS,
	d: DAY_MS,
};

const COMPONENT = /(\d+(?:\.\d+)?)\s*([smhd])/g;

/**
 * Parse a duration such as `45s`, `30m`, `1h30m`, or `90` (minutes).
 *
 * A leading `+` is tolerated so `+10m` reads naturally for a one-shot delay.
 */
export function parseDuration(input: string): DurationParse {
	const text = input.trim().toLowerCase().replace(/^\+/, "");
	if (!text) return { ok: false, error: "Add a duration such as 30m, 2h, or 1h30m." };
	if (text.startsWith("-")) {
		return { ok: false, error: `"${input.trim()}" is not a duration. Durations are positive.` };
	}

	let total = 0;
	let consumed = 0;
	for (const match of text.matchAll(COMPONENT)) {
		const amount = Number.parseFloat(match[1] as string);
		const unit = UNIT_MS[match[2] as string];
		if (unit === undefined || !Number.isFinite(amount)) {
			return {
				ok: false,
				error: `"${input.trim()}" is not a duration. Use forms like 30m or 1h30m.`,
			};
		}
		total += amount * unit;
		consumed += (match[0] as string).length;
	}

	if (consumed === 0) {
		// A bare number means minutes: `/checkin 30 check the build` reads better than `/checkin 30m …`.
		if (!/^\d+(?:\.\d+)?$/.test(text)) {
			return {
				ok: false,
				error: `"${input.trim()}" is not a duration. Use forms like 30m or 1h30m.`,
			};
		}
		total = Number.parseFloat(text) * MINUTE_MS;
	} else if (text.replace(COMPONENT, "").trim() !== "") {
		return { ok: false, error: `"${input.trim()}" has trailing text after the duration.` };
	}

	const ms = Math.round(total);
	if (!(ms > 0)) return { ok: false, error: "The duration must be greater than zero." };
	return { ok: true, ms };
}

/** Format milliseconds as a compact, round-trippable duration (`1h30m`, `45m`, `2d`). */
export function formatDuration(ms: number): string {
	if (!(ms > 0)) return "0s";
	let rest = Math.round(ms / SECOND_MS);
	const days = Math.floor(rest / 86_400);
	rest -= days * 86_400;
	const hours = Math.floor(rest / 3_600);
	rest -= hours * 3_600;
	const minutes = Math.floor(rest / 60);
	const seconds = rest - minutes * 60;

	let out = "";
	if (days > 0) out += `${days}d`;
	if (hours > 0) out += `${hours}h`;
	if (minutes > 0) out += `${minutes}m`;
	if (seconds > 0) out += `${seconds}s`;
	return out || "0s";
}
