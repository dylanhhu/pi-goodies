import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CommandIntent, parseCommandArgs, unquote } from "../../extensions/checkin/command.ts";

function add(intent: CommandIntent) {
	assert.equal(intent.kind, "add");
	if (intent.kind !== "add") throw new Error("not an add intent");
	return intent;
}

function errorOf(intent: CommandIntent): string {
	assert.equal(intent.kind, "error");
	return intent.kind === "error" ? intent.message : "";
}

describe("parseCommandArgs", () => {
	test("defaults to listing", () => {
		assert.equal(parseCommandArgs("").kind, "list");
		assert.equal(parseCommandArgs("   ").kind, "list");
		assert.equal(parseCommandArgs("list").kind, "list");
		assert.equal(parseCommandArgs("ls").kind, "list");
	});

	test("recognizes help and clear", () => {
		assert.equal(parseCommandArgs("help").kind, "help");
		assert.equal(parseCommandArgs("?").kind, "help");
		assert.equal(parseCommandArgs("clear").kind, "clear");
		assert.equal(parseCommandArgs("reset").kind, "clear");
	});

	test("parses removal in its aliases", () => {
		for (const verb of ["remove", "rm", "cancel", "stop"]) {
			const intent = parseCommandArgs(`${verb} c3`);
			assert.equal(intent.kind, "remove");
			assert.equal(intent.kind === "remove" ? intent.handle : "", "c3");
		}
		const multiword = parseCommandArgs("remove check the build");
		assert.equal(multiword.kind === "remove" ? multiword.handle : "", "check the build");
		assert.match(errorOf(parseCommandArgs("remove")), /id or label/);
	});

	test("treats a leading duration as recurring", () => {
		const intent = add(parseCommandArgs("30m check the deploy"));
		assert.equal(intent.prompt, "check the deploy");
		assert.equal(intent.every?.ok ? intent.every.ms : 0, 1_800_000);
		assert.equal(intent.in, undefined);
	});

	test("treats a bare number as minutes", () => {
		const intent = add(parseCommandArgs("30 review the TODOs"));
		assert.equal(intent.every?.ok ? intent.every.ms : 0, 1_800_000);
	});

	test("parses the explicit in and every forms", () => {
		const oneShot = add(parseCommandArgs("in 10m look at the build"));
		assert.equal(oneShot.in?.ok ? oneShot.in.ms : 0, 600_000);
		assert.equal(oneShot.every, undefined);
		const once = add(parseCommandArgs("once 45s ping"));
		assert.equal(once.in?.ok ? once.in.ms : 0, 45_000);
		const every = add(parseCommandArgs("every 2h summarize"));
		assert.equal(every.every?.ok ? every.every.ms : 0, 7_200_000);
		assert.equal(add(parseCommandArgs("every 2h summarize")).prompt, "summarize");
	});

	test("carries --skip regardless of position", () => {
		assert.equal(add(parseCommandArgs("10m --skip check")).whenBusy, "skip");
		assert.equal(add(parseCommandArgs("--skip 10m check")).whenBusy, "skip");
		assert.equal(add(parseCommandArgs("in 10m check")).whenBusy, "queue");
	});

	test("strips one layer of quotes", () => {
		assert.equal(add(parseCommandArgs('in 5m "check the build"')).prompt, "check the build");
		assert.equal(add(parseCommandArgs("in 5m 'check the build'")).prompt, "check the build");
		assert.equal(unquote("check the build"), "check the build");
	});

	test("reports missing prompts", () => {
		assert.match(errorOf(parseCommandArgs("30m")), /prompt is required/);
		assert.match(errorOf(parseCommandArgs("in 10m")), /prompt is required/);
	});

	test("reports malformed durations", () => {
		assert.match(errorOf(parseCommandArgs("in soon check")), /not a duration/);
		assert.match(errorOf(parseCommandArgs("every later check")), /not a duration/);
		assert.match(errorOf(parseCommandArgs("in")), /needs a delay/);
		assert.match(errorOf(parseCommandArgs("every")), /needs an interval/);
	});

	test("rejects an unknown verb", () => {
		const intent = parseCommandArgs("check the build");
		assert.match(errorOf(intent), /neither an interval nor a subcommand/);
	});
});
