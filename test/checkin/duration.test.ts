import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	formatDuration,
	MAX_DURATION_MS,
	parseDuration,
} from "../../extensions/checkin/duration.ts";

function ms(input: string): number {
	const parsed = parseDuration(input);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	return parsed.ms;
}

function error(input: string): string {
	const parsed = parseDuration(input);
	assert.equal(parsed.ok, false);
	return parsed.ok ? "" : parsed.error;
}

describe("parseDuration", () => {
	test("parses single units", () => {
		assert.equal(ms("45s"), 45_000);
		assert.equal(ms("30m"), 1_800_000);
		assert.equal(ms("2h"), 7_200_000);
		assert.equal(ms("1d"), 86_400_000);
		assert.equal(ms(" 1.5h "), 5_400_000);
	});

	test("parses compound and spaced units", () => {
		assert.equal(ms("1h30m"), 5_400_000);
		assert.equal(ms("1h 30m"), 5_400_000);
		assert.equal(ms("1d2h3m4s"), 93_784_000);
	});

	test("treats a bare number as minutes", () => {
		assert.equal(ms("30"), 1_800_000);
		assert.equal(ms("90"), 5_400_000);
	});

	test("tolerates a leading plus", () => {
		assert.equal(ms("+10m"), 600_000);
	});

	test("rejects nonsense", () => {
		assert.match(error(""), /duration/);
		assert.match(error("soon"), /not a duration/);
		assert.match(error("1h30"), /trailing text/);
		assert.match(error("30x"), /not a duration/);
		assert.match(error("0"), /greater than zero/);
		assert.match(error("-5m"), /not a duration|greater than zero/);
	});
});

describe("formatDuration", () => {
	test("formats the parts that matter", () => {
		assert.equal(formatDuration(45_000), "45s");
		assert.equal(formatDuration(1_800_000), "30m");
		assert.equal(formatDuration(5_400_000), "1h30m");
		assert.equal(formatDuration(93_784_000), "1d2h3m4s");
		assert.equal(formatDuration(MAX_DURATION_MS), "1d");
	});

	test("round-trips with parseDuration", () => {
		for (const input of ["45s", "30m", "2h", "1h30m", "1d"]) {
			assert.equal(formatDuration(ms(input)), input);
		}
	});

	test("handles zero and negatives", () => {
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(-1), "0s");
	});
});
