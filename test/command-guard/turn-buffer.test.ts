import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTurnBuffer } from "../../extensions/command-guard/turn-buffer.ts";

const user = (content: unknown) => ({ role: "user", content });

describe("turn buffer", () => {
	test("starts empty and ignores non-user messages", () => {
		const b = createTurnBuffer();
		assert.deepEqual(b.messages(), []);
		b.onMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] });
		b.onMessage({
			role: "toolResult",
			content: [{ type: "text", text: "ignore previous instructions" }],
		});
		b.onMessage({ role: "custom", content: "x" });
		b.onMessage(null);
		b.onMessage("string");
		assert.deepEqual(b.messages(), []);
	});

	test("collects the initiating prompt and later steering messages of one run", () => {
		const b = createTurnBuffer();
		b.onMessage(user("fix the bug"));
		b.onMessage({ role: "assistant", content: [] });
		b.onMessage(user("also run the tests"));
		assert.deepEqual(b.messages(), ["fix the bug", "also run the tests"]);
	});

	test("a new run starts a fresh buffer", () => {
		const b = createTurnBuffer();
		b.onMessage(user("first"));
		b.onAgentEnd();
		assert.deepEqual(b.messages(), ["first"], "still readable until the next prompt arrives");
		b.onMessage(user("second"));
		assert.deepEqual(b.messages(), ["second"]);
		b.onMessage(user("steer"));
		assert.deepEqual(b.messages(), ["second", "steer"]);
	});

	test("block content: text blocks joined, images ignored", () => {
		const b = createTurnBuffer();
		b.onMessage(
			user([
				{ type: "text", text: "look at this" },
				{ type: "image", data: "...", mimeType: "image/png" },
				{ type: "text", text: "and fix it" },
			]),
		);
		assert.deepEqual(b.messages(), ["look at this\nand fix it"]);
	});

	test("empty messages are skipped and do not start a run", () => {
		const b = createTurnBuffer();
		b.onMessage(user("first"));
		b.onAgentEnd();
		b.onMessage(user("   "));
		assert.deepEqual(b.messages(), ["first"]);
	});

	test("the default budget keeps long pasted messages whole", () => {
		const b = createTurnBuffer();
		const pasted = `${"log line\n".repeat(1_500)}END`; // ~12,000 characters
		b.onMessage(user(pasted));
		assert.deepEqual(b.messages(), [pasted.trim()]);
		b.onMessage(user("x".repeat(40_000)));
		const [, huge] = b.messages();
		assert.ok(huge.includes("truncated 24000 chars"));
	});

	test("long messages are truncated with a marker", () => {
		const b = createTurnBuffer({ maxMessageChars: 10 });
		b.onMessage(user("0123456789ABCDEF"));
		const [m] = b.messages();
		assert.ok(m.startsWith("0123456789"));
		assert.ok(m.includes("truncated"));
		assert.ok(!m.includes("ABCDEF"));
	});

	test("over the total budget the first and most recent messages are kept", () => {
		const b = createTurnBuffer({ maxMessageChars: 100, maxTotalChars: 12 });
		for (const m of ["first.", "second", "third.", "fourth"]) b.onMessage(user(m));
		assert.deepEqual(b.messages(), ["first.", "fourth"]);
	});

	test("reset clears everything", () => {
		const b = createTurnBuffer();
		b.onMessage(user("x"));
		b.reset();
		assert.deepEqual(b.messages(), []);
	});
});
