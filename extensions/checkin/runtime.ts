/**
 * Check-in runtime: owns the state, the timers, and the effects around firing.
 *
 * The runtime takes its clocks, delivery, persistence, and notifications as dependencies so the
 * interesting behavior — arming, firing while busy, one-shot retirement, `maxRuns` expiry, restore
 * after a reload — can be tested against a fake clock. `index.ts` wires the real ones.
 */

import {
	type AddCheckinInput,
	addCheckin,
	type Checkin,
	type CheckinState,
	clearCheckins,
	EMPTY_STATE,
	formatFireMessage,
	nextDue,
	recordFire,
	removeCheckin,
	sanitizeState,
	statusText,
} from "./schedule.ts";

export type TimerHandle = unknown;

export interface RuntimeDeps {
	now(): number;
	setTimer(ms: number, fire: () => void): TimerHandle;
	clearTimer(handle: TimerHandle): void;
	/** Whether the agent is mid-run, which decides whether a firing queues or is skipped. */
	isBusy(): boolean;
	/** Deliver a firing as a user message. `queue` means it must wait for the current run. */
	deliver(text: string, options: { queue: boolean }): void;
	persist(state: CheckinState): void;
	/** Called after any state change, for status text and similar chrome. */
	changed?(): void;
	notify?(message: string, level: "info" | "warning" | "error"): void;
}

export type CheckinRequest = Omit<AddCheckinInput, "now">;

export interface CheckinRuntime {
	state(): CheckinState;
	add(input: CheckinRequest): ReturnType<typeof addCheckin>;
	remove(handle: string): ReturnType<typeof removeCheckin>;
	clear(): number;
	/** Replace the state from a persisted entry and re-arm from now, never from the stored clock. */
	restore(raw: unknown): void;
	dispose(): void;
}

export function createRuntime(deps: RuntimeDeps): CheckinRuntime {
	let state: CheckinState = EMPTY_STATE;
	const timers = new Map<string, TimerHandle>();

	function arm(checkin: Checkin): void {
		const existing = timers.get(checkin.id);
		if (existing !== undefined) deps.clearTimer(existing);
		const delay = Math.max(0, checkin.nextAt - deps.now());
		const handle = deps.setTimer(delay, () => fire(checkin.id));
		timers.set(checkin.id, handle);
	}

	function disarm(id: string): void {
		const handle = timers.get(id);
		if (handle !== undefined) deps.clearTimer(handle);
		timers.delete(id);
	}

	function commit(next: CheckinState): void {
		state = next;
		deps.persist(state);
		deps.changed?.();
	}

	function fire(id: string): void {
		const checkin = state.checkins.find((c) => c.id === id);
		timers.delete(id);
		if (!checkin) return;

		const busy = deps.isBusy();
		if (busy && checkin.whenBusy === "skip") {
			deps.notify?.(`Check-in "${checkin.label}" skipped: the agent is busy.`, "warning");
		} else {
			try {
				deps.deliver(formatFireMessage(checkin), { queue: busy });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.notify?.(`Check-in "${checkin.label}" could not fire: ${message}`, "error");
			}
		}

		const result = recordFire(state, id, deps.now());
		commit(result.state);
		if (result.next) arm(result.next);
	}

	return {
		state: () => state,

		add(input) {
			const result = addCheckin(state, { ...input, now: deps.now() });
			if (!result.ok) return result;
			state = result.state;
			deps.persist(state);
			arm(result.checkin);
			deps.changed?.();
			return result;
		},

		remove(handle) {
			const result = removeCheckin(state, handle);
			if (!result.ok) return result;
			disarm(result.checkin.id);
			commit(result.state);
			return result;
		},

		clear() {
			const { state: next, removed } = clearCheckins(state);
			for (const id of [...timers.keys()]) disarm(id);
			commit(next);
			return removed;
		},

		restore(raw) {
			for (const id of [...timers.keys()]) disarm(id);
			const restored = sanitizeState(raw);
			const now = deps.now();
			state = {
				...restored,
				// A stored `nextAt` can be hours stale; count fresh intervals from resuming instead.
				checkins: restored.checkins.map((c) => ({
					...c,
					nextAt: now + (c.intervalMs ?? c.delayMs ?? 0),
				})),
			};
			for (const checkin of state.checkins) arm(checkin);
			deps.changed?.();
		},

		dispose() {
			for (const id of [...timers.keys()]) disarm(id);
			state = EMPTY_STATE;
		},
	};
}

export { nextDue, statusText };
