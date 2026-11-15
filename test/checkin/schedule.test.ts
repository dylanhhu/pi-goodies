import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	addCheckin,
	type Checkin,
	type CheckinState,
	clearCheckins,
	deriveLabel,
	describeCheckin,
	describeState,
	EMPTY_STATE,
	MAX_CHECKINS,
	MAX_PROMPT_CHARS,
	nextDue,
	recordFire,
	removeCheckin,
	resolveCheckin,
	sanitizeState,
	statusText,
} from "../../extensions/checkin/schedule.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function added(state: CheckinState, input: Parameters<typeof addCheckin>[1]) {
	const result = addCheckin(state, input);
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result;
}

function recurring(
	prompt: string,
	minutes = 30,
	now = NOW,
): { state: CheckinState; checkin: Checkin } {
	const result = added(EMPTY_STATE, { prompt, everyMs: minutes * MINUTE, now });
	return { state: result.state, checkin: result.checkin };
}

function failure(input: Parameters<typeof addCheckin>[1]): string {
	const result = addCheckin(EMPTY_STATE, input);
	assert.equal(result.ok, false);
	return result.ok ? "" : result.error;
}

describe("addCheckin", () => {
	test("schedules a recurring check-in", () => {
		const { checkin } = recurring("check the build", 15);
		assert.equal(checkin.id, "c1");
		assert.equal(checkin.label, "check the build");
		assert.equal(checkin.intervalMs, 15 * MINUTE);
		assert.equal(checkin.delayMs, undefined);
		assert.equal(checkin.nextAt, NOW + 15 * MINUTE);
		assert.equal(checkin.runs, 0);
		assert.equal(checkin.whenBusy, "queue");
	});

	test("schedules a one-shot", () => {
		const result = added(EMPTY_STATE, {
			prompt: "look at the deploy",
			inMs: 10 * MINUTE,
			now: NOW,
		});
		assert.equal(result.checkin.delayMs, 10 * MINUTE);
		assert.equal(result.checkin.intervalMs, undefined);
	});

	test("numbers ids monotonically", () => {
		let state = recurring("first").state;
		state = added(state, { prompt: "second", everyMs: MINUTE, now: NOW }).state;
		assert.deepEqual(
			state.checkins.map((c) => c.id),
			["c1", "c2"],
		);
		assert.equal(state.seq, 2);
	});

	test("keeps labels unique so handles stay unambiguous", () => {
		let state = recurring("check the build").state;
		state = added(state, { prompt: "check the build", everyMs: MINUTE, now: NOW }).state;
		assert.equal(state.checkins[1]?.label, "check the build (c2)");
	});

	test("rejects invalid requests", () => {
		assert.match(failure({ prompt: "  ", everyMs: MINUTE, now: NOW }), /prompt is required/);
		assert.match(
			failure({ prompt: "x".repeat(MAX_PROMPT_CHARS + 1), everyMs: MINUTE, now: NOW }),
			/keep it under/,
		);
		assert.match(failure({ prompt: "x", now: NOW }), /exactly one of/);
		assert.match(
			failure({ prompt: "x", everyMs: MINUTE, inMs: MINUTE, now: NOW }),
			/exactly one of/,
		);
		assert.match(failure({ prompt: "x", everyMs: 1_000, now: NOW }), /at least 30s/);
		assert.match(failure({ prompt: "x", everyMs: 2 * 86_400_000, now: NOW }), /capped at 1d/);
		assert.match(failure({ prompt: "x", inMs: 100, now: NOW }), /at least 5s/);
		assert.match(
			failure({ prompt: "x", inMs: MINUTE, maxRuns: 2, now: NOW }),
			/applies to recurring/,
		);
		assert.match(failure({ prompt: "x", everyMs: MINUTE, maxRuns: 0, now: NOW }), /whole number/);
	});

	test("caps the number of check-ins", () => {
		let state = EMPTY_STATE;
		for (let i = 0; i < MAX_CHECKINS; i++) {
			state = added(state, { prompt: `check ${i}`, everyMs: MINUTE, now: NOW }).state;
		}
		const result = addCheckin(state, { prompt: "one more", everyMs: MINUTE, now: NOW });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /Already 12 check-ins/);
	});
});

describe("deriveLabel", () => {
	test("uses the first non-empty line without Markdown markers", () => {
		assert.equal(deriveLabel("## **Check** the `build`\nmore text"), "Check the build");
		assert.equal(deriveLabel("\n\nsecond line wins"), "second line wins");
	});

	test("truncates long labels", () => {
		const label = deriveLabel("a".repeat(100));
		assert.equal(label.length, 40);
		assert.ok(label.endsWith("…"));
	});

	test("falls back when nothing is left", () => {
		assert.equal(deriveLabel("***"), "check-in");
	});
});

describe("resolveCheckin", () => {
	test("resolves by id, label, and unique prefix", () => {
		const { state } = recurring("check the build");
		assert.ok(resolveCheckin(state, "c1").ok);
		assert.ok(resolveCheckin(state, "CHECK THE BUILD").ok);
		assert.ok(resolveCheckin(state, "check").ok);
	});

	test("reports ambiguity and misses", () => {
		let state = recurring("deploy status").state;
		state = added(state, { prompt: "deploy logs", everyMs: MINUTE, now: NOW }).state;
		const ambiguous = resolveCheckin(state, "deploy");
		assert.equal(ambiguous.ok, false);
		assert.match(ambiguous.ok ? "" : ambiguous.error, /matches 2 check-ins: c1/);
		const missing = resolveCheckin(state, "nothing");
		assert.equal(missing.ok, false);
		assert.match(missing.ok ? "" : missing.error, /No check-in matches/);
		assert.equal(resolveCheckin(state, "  ").ok, false);
	});
});

describe("removeCheckin / clearCheckins", () => {
	test("removes the resolved check-in", () => {
		const { state } = recurring("check the build");
		const result = removeCheckin(state, "c1");
		assert.ok(result.ok);
		assert.deepEqual(result.state.checkins, []);
		assert.equal(result.state.seq, 1);
	});

	test("reports unknown handles without changing state", () => {
		const { state } = recurring("check the build");
		const result = removeCheckin(state, "nope");
		assert.equal(result.ok, false);
	});

	test("clears all and counts", () => {
		let state = recurring("a").state;
		state = added(state, { prompt: "b", everyMs: MINUTE, now: NOW }).state;
		const { state: cleared, removed } = clearCheckins(state);
		assert.equal(removed, 2);
		assert.deepEqual(cleared.checkins, []);
	});
});

describe("recordFire", () => {
	test("reschedules a recurring check-in from the firing time", () => {
		const { state } = recurring("check the build", 10);
		const result = recordFire(state, "c1", NOW + 10 * MINUTE + 5_000);
		assert.equal(result.next?.runs, 1);
		assert.equal(result.next?.nextAt, NOW + 20 * MINUTE + 5_000);
		assert.equal(result.state.checkins[0]?.runs, 1);
	});

	test("retires a one-shot", () => {
		const result = added(EMPTY_STATE, { prompt: "look", inMs: MINUTE, now: NOW });
		const fired = recordFire(result.state, "c1", NOW + MINUTE);
		assert.equal(fired.next, undefined);
		assert.deepEqual(fired.state.checkins, []);
	});

	test("retires a recurring check-in at maxRuns", () => {
		const result = added(EMPTY_STATE, {
			prompt: "poll",
			everyMs: MINUTE,
			maxRuns: 2,
			now: NOW,
		});
		const once = recordFire(result.state, "c1", NOW + MINUTE);
		assert.equal(once.next?.runs, 1);
		const twice = recordFire(once.state, "c1", NOW + 2 * MINUTE);
		assert.equal(twice.next, undefined);
		assert.deepEqual(twice.state.checkins, []);
	});

	test("ignores unknown ids", () => {
		const { state } = recurring("check the build");
		assert.equal(recordFire(state, "c9", NOW).state, state);
	});
});

describe("describeState", () => {
	test("reports an empty schedule", () => {
		assert.equal(describeState(EMPTY_STATE, NOW), "No check-ins scheduled.");
	});

	test("lists cadence, next firing, and the prompt", () => {
		const { state } = recurring("check the build", 10);
		const text = describeCheckin(state.checkins[0] as Checkin, NOW + MINUTE);
		assert.match(text, /\[c1\] check the build — every 10m, next in 9m/);
		assert.match(text, /\n\s+check the build/);
	});

	test("marks skip policy and run counts", () => {
		const result = added(EMPTY_STATE, {
			prompt: "poll",
			everyMs: MINUTE,
			whenBusy: "skip",
			maxRuns: 5,
			now: NOW,
		});
		const fired = recordFire(result.state, "c1", NOW + MINUTE);
		const text = describeCheckin(fired.state.checkins[0] as Checkin, NOW + MINUTE);
		assert.match(text, /runs 1\/5, skip if busy/);
	});

	test("footer text names a single check-in and counts many", () => {
		const one = recurring("check the build", 10).state;
		assert.equal(statusText(one, NOW), "check-in: check the build in 10m");
		const two = added(one, { prompt: "b", everyMs: 20 * MINUTE, now: NOW }).state;
		assert.equal(statusText(two, NOW), "check-ins: 2, next 10m");
		assert.equal(statusText(EMPTY_STATE, NOW), undefined);
	});
});

describe("nextDue", () => {
	test("picks the soonest firing", () => {
		let state = recurring("later", 60).state;
		state = added(state, { prompt: "sooner", inMs: 5 * MINUTE, now: NOW }).state;
		assert.equal(nextDue(state)?.label, "sooner");
		assert.equal(nextDue(EMPTY_STATE), undefined);
	});
});

describe("sanitizeState", () => {
	test("drops malformed entries and keeps the rest", () => {
		const good = {
			id: "c3",
			label: "keep me",
			prompt: "check",
			intervalMs: 600_000,
			whenBusy: "queue",
			runs: 2,
			createdAt: NOW,
			nextAt: NOW + 600_000,
		};
		const state = sanitizeState({
			seq: 3,
			checkins: [
				good,
				{ ...good, id: "c4", prompt: "" },
				{ ...good, id: "c5", intervalMs: undefined, delayMs: undefined },
				{ ...good, id: "c6", intervalMs: 600_000, delayMs: 600_000 },
				null,
				"nope",
			],
		});
		assert.deepEqual(
			state.checkins.map((c) => c.id),
			["c3"],
		);
		assert.equal(state.checkins[0]?.runs, 2);
	});

	test("recovers a sequence number from stored ids", () => {
		const state = sanitizeState({
			checkins: [{ id: "c7", label: "x", prompt: "y", delayMs: 1_000, nextAt: NOW }],
		});
		assert.equal(state.seq, 7);
	});

	test("survives garbage", () => {
		assert.deepEqual(sanitizeState(undefined), EMPTY_STATE);
		assert.deepEqual(sanitizeState({ checkins: "no" }), { seq: 0, checkins: [] });
	});

	test("defaults a missing whenBusy and clamps long labels", () => {
		const state = sanitizeState({
			checkins: [
				{ label: "x".repeat(80), prompt: "y", delayMs: 1_000, nextAt: NOW, whenBusy: "bogus" },
			],
		});
		assert.equal(state.checkins[0]?.whenBusy, "queue");
		assert.equal(state.checkins[0]?.label.length, 40);
	});
});
