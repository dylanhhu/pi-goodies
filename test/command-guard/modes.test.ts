import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPolicy } from "../../extensions/command-guard/config.ts";
import {
	DEFAULT_MODE,
	enforcedPolicy,
	getMode,
	PERMISSION_MODES,
	type PermissionMode,
	restoreMode,
	YOLO_MODE,
} from "../../extensions/command-guard/modes.ts";

const entry = (data: unknown, customType = "command-guard-mode", type = "custom") => ({
	type,
	customType,
	data,
});

describe("mode registry", () => {
	test("names are unique, and the default comes first", () => {
		const names = PERMISSION_MODES.map((m) => m.name);
		assert.equal(new Set(names).size, names.length);
		assert.equal(PERMISSION_MODES[0], DEFAULT_MODE);
	});

	test("looks modes up by exact name only", () => {
		assert.equal(getMode("yolo"), YOLO_MODE);
		assert.equal(getMode("YOLO"), undefined);
		for (const name of ["constructor", "toString", "__proto__", ""]) {
			assert.equal(getMode(name), undefined, name);
		}
	});

	test("only yolo bypasses the guard", () => {
		assert.deepEqual(
			PERMISSION_MODES.filter((m) => m.bypass).map((m) => m.name),
			["yolo"],
		);
	});
});

describe("enforcedPolicy", () => {
	const policy = buildPolicy({});

	test("a mode without apply enforces the configured policy", () => {
		assert.equal(enforcedPolicy(DEFAULT_MODE, policy), policy);
	});

	test("apply derives the policy without touching the original", () => {
		const strict: PermissionMode = {
			name: "strict-test",
			description: "test",
			apply: (p) => ({ ...p, unmatched: { ...p.unmatched, bash: "confirm" } }),
		};
		const before = policy.unmatched.bash;
		const derived = enforcedPolicy(strict, policy);
		assert.equal(derived.unmatched.bash, "confirm");
		assert.equal(policy.unmatched.bash, before);
	});
});

describe("restoreMode", () => {
	test("no entries means the default", () => {
		assert.equal(restoreMode([]), DEFAULT_MODE);
	});

	test("the last switch wins", () => {
		assert.equal(restoreMode([entry({ mode: "yolo" })]), YOLO_MODE);
		assert.equal(restoreMode([entry({ mode: "yolo" }), entry({ mode: "default" })]), DEFAULT_MODE);
		assert.equal(restoreMode([entry({ mode: "default" }), entry({ mode: "yolo" })]), YOLO_MODE);
	});

	test("an unknown or malformed latest entry falls back to the default", () => {
		const malformed = [{ mode: "nope" }, { mode: 3 }, {}, null, "yolo", undefined];
		for (const data of [...malformed, { mode: "constructor" }]) {
			assert.equal(restoreMode([entry({ mode: "yolo" }), entry(data)]), DEFAULT_MODE);
		}
	});

	test("other entries are ignored", () => {
		const other = [
			entry({ mode: "yolo" }, "something-else"),
			entry({ mode: "yolo" }, "command-guard-mode", "message"),
		];
		assert.equal(restoreMode(other), DEFAULT_MODE);
		assert.equal(restoreMode([entry({ mode: "yolo" }), ...other]), YOLO_MODE);
	});
});
