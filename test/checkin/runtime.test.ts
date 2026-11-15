import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRuntime } from "../../extensions/checkin/runtime.ts";
import type { CheckinState } from "../../extensions/checkin/schedule.ts";

const START = 1_700_000_000_000;
const MINUTE = 60_000;

interface Delivered {
	text: string;
	queue: boolean;
}

function harness(options?: { deliverThrows?: boolean }) {
	const clock = { current: START };
	const busy = { value: false };
	const pending = new Map<number, { at: number; fire: () => void }>();
	const delivered: Delivered[] = [];
	const persisted: CheckinState[] = [];
	const notes: { message: string; level: string }[] = [];
	let seq = 0;
	let changes = 0;

	const runtime = createRuntime({
		now: () => clock.current,
		setTimer: (ms, fire) => {
			const id = ++seq;
			pending.set(id, { at: clock.current + ms, fire });
			return id;
		},
		clearTimer: (handle) => {
			pending.delete(handle as number);
		},
		isBusy: () => busy.value,
		deliver: (text, { queue }) => {
			if (options?.deliverThrows) throw new Error("session is gone");
			delivered.push({ text, queue });
		},
		persist: (state) => {
			persisted.push(state);
		},
		changed: () => {
			changes++;
		},
		notify: (message, level) => {
			notes.push({ message, level });
		},
	});

	/** Advance the clock, firing every timer that comes due, earliest first. */
	function advance(ms: number): void {
		const target = clock.current + ms;
		for (;;) {
			let next: { id: number; at: number; fire: () => void } | undefined;
			for (const [id, timer] of pending) {
				if (timer.at > target) continue;
				if (!next || timer.at < next.at) next = { id, ...timer };
			}
			if (!next) break;
			pending.delete(next.id);
			clock.current = next.at;
			next.fire();
		}
		clock.current = target;
	}

	return {
		runtime,
		clock,
		busy,
		pending,
		delivered,
		persisted,
		notes,
		advance,
		changes: () => changes,
	};
}

describe("createRuntime", () => {
	test("fires a recurring check-in and reschedules it", () => {
		const h = harness();
		const result = h.runtime.add({ prompt: "check the build", everyMs: 10 * MINUTE });
		assert.ok(result.ok);

		h.advance(10 * MINUTE);
		assert.equal(h.delivered.length, 1);
		assert.match(h.delivered[0]?.text ?? "", /\[check-in check the build · every 10m · run 1\]/);
		assert.equal(h.delivered[0]?.queue, false);
		assert.equal(h.runtime.state().checkins[0]?.runs, 1);

		h.advance(10 * MINUTE);
		assert.equal(h.delivered.length, 2);
		assert.match(h.delivered[1]?.text ?? "", /run 2/);
	});

	test("retires a one-shot after firing", () => {
		const h = harness();
		h.runtime.add({ prompt: "look at the deploy", inMs: 5 * MINUTE });
		h.advance(5 * MINUTE);
		assert.equal(h.delivered.length, 1);
		assert.deepEqual(h.runtime.state().checkins, []);
		assert.equal(h.pending.size, 0);

		h.advance(60 * MINUTE);
		assert.equal(h.delivered.length, 1);
	});

	test("stops a recurring check-in at maxRuns", () => {
		const h = harness();
		h.runtime.add({ prompt: "poll", everyMs: MINUTE, maxRuns: 2 });
		h.advance(5 * MINUTE);
		assert.equal(h.delivered.length, 2);
		assert.deepEqual(h.runtime.state().checkins, []);
		assert.equal(h.pending.size, 0);
	});

	test("queues by default when the agent is busy", () => {
		const h = harness();
		h.busy.value = true;
		h.runtime.add({ prompt: "check the build", everyMs: MINUTE });
		h.advance(MINUTE);
		assert.equal(h.delivered[0]?.queue, true);
	});

	test("skips a firing when the check-in asks for it", () => {
		const h = harness();
		h.busy.value = true;
		h.runtime.add({ prompt: "poll", everyMs: MINUTE, whenBusy: "skip" });
		h.advance(MINUTE);

		assert.equal(h.delivered.length, 0);
		assert.match(h.notes[0]?.message ?? "", /skipped/);
		assert.equal(h.notes[0]?.level, "warning");
		// The firing still counts, so maxRuns converges even while skipping.
		assert.equal(h.runtime.state().checkins[0]?.runs, 1);
	});

	test("persists every mutation", () => {
		const h = harness();
		h.runtime.add({ prompt: "check the build", everyMs: MINUTE });
		assert.equal(h.persisted.length, 1);
		h.advance(MINUTE);
		assert.equal(h.persisted.length, 2);
		h.runtime.remove("c1");
		assert.equal(h.persisted.length, 3);
		assert.deepEqual(h.persisted.at(-1)?.checkins, []);
	});

	test("removes and clears without leaving timers behind", () => {
		const h = harness();
		h.runtime.add({ prompt: "a", everyMs: MINUTE });
		h.runtime.add({ prompt: "b", everyMs: MINUTE });
		assert.equal(h.pending.size, 2);

		h.runtime.remove("c1");
		assert.equal(h.pending.size, 1);
		assert.equal(h.runtime.clear(), 1);
		assert.equal(h.pending.size, 0);

		h.advance(10 * MINUTE);
		assert.equal(h.delivered.length, 0);
	});

	test("reports an invalid add without arming", () => {
		const h = harness();
		const result = h.runtime.add({ prompt: "x", everyMs: 1_000 });
		assert.equal(result.ok, false);
		assert.equal(h.pending.size, 0);
		assert.equal(h.persisted.length, 0);
	});

	test("reports add through changed", () => {
		const h = harness();
		const before = h.changes();
		h.runtime.add({ prompt: "a", everyMs: MINUTE });
		assert.ok(h.changes() > before);
	});

	test("restores from a stale deadline by restarting intervals from now", () => {
		const h = harness();
		h.runtime.restore({
			seq: 1,
			checkins: [
				{
					id: "c1",
					label: "check the build",
					prompt: "check the build",
					intervalMs: 10 * MINUTE,
					whenBusy: "queue",
					runs: 3,
					createdAt: START - 7_200_000,
					nextAt: START - 3_600_000,
				},
			],
		});

		assert.equal(h.runtime.state().checkins[0]?.runs, 3);
		h.advance(9 * MINUTE);
		assert.equal(h.delivered.length, 0);
		h.advance(MINUTE);
		assert.equal(h.delivered.length, 1);
		assert.match(h.delivered[0]?.text ?? "", /run 4/);
	});

	test("drops malformed restored entries", () => {
		const h = harness();
		h.runtime.restore({ checkins: [{ id: "c1" }, 42] });
		assert.deepEqual(h.runtime.state().checkins, []);
		assert.equal(h.pending.size, 0);
	});

	test("dispose clears timers and state", () => {
		const h = harness();
		h.runtime.add({ prompt: "a", everyMs: MINUTE });
		h.runtime.dispose();
		assert.equal(h.pending.size, 0);
		assert.deepEqual(h.runtime.state().checkins, []);
		h.advance(10 * MINUTE);
		assert.equal(h.delivered.length, 0);
	});

	test("keeps scheduling after a delivery throws", () => {
		const h = harness({ deliverThrows: true });
		h.runtime.add({ prompt: "poll", everyMs: MINUTE });

		h.advance(MINUTE);
		assert.equal(h.notes[0]?.level, "error");
		assert.match(h.notes[0]?.message ?? "", /could not fire: session is gone/);
		// The counter still advances and the timer is re-armed, so one failure does not end the cadence.
		assert.equal(h.runtime.state().checkins[0]?.runs, 1);
		assert.equal(h.pending.size, 1);

		h.advance(MINUTE);
		assert.equal(h.notes.length, 2);
	});
});
