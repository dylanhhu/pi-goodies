import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import type { AuditEntry } from "../../extensions/command-guard/guard.ts";
import { createTrace, parseAuditEntry } from "../../extensions/command-guard/trace.ts";

const theme = { fg: (_color: string, text: string) => text };

class Lines implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

const judged = (id: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({
	tool: "bash",
	toolCallId: id,
	outcome: "allow",
	source: "judge",
	rules: [],
	scores: { destructive: 0.04, unauthorized: 0.1 },
	thresholds: { destructive: { confirm: 0.3, block: 0.9 }, unauthorized: { confirm: 0.5 } },
	...extra,
});

/** Draws a call the way the transcript does: through the resolved renderers */
function harness(toolName = "bash") {
	const trace = createTrace();
	const redraws: string[] = [];
	const innerCalls: Array<Component | undefined> = [];
	const base = {
		renderCall: (
			args: { command: string },
			_theme: unknown,
			context: { lastComponent: Component | undefined },
		) => {
			innerCalls.push(context.lastComponent);
			// Like the built-in renderers, keep the component between draws
			const component = (context.lastComponent as Lines | undefined) ?? new Lines([]);
			component.lines = [`$ ${args.command}`];
			return component;
		},
		renderResult: () => new Lines([]),
	};
	const resolved = trace.resolver(toolName, () => base as never);
	const draw = (id: string, last?: Component, expanded = false) =>
		resolved?.renderCall?.(
			{ command: "ls" } as never,
			theme as never,
			{
				toolCallId: id,
				invalidate: () => redraws.push(id),
				lastComponent: last,
				expanded,
				args: {},
			} as never,
		) as Component;
	return { trace, resolved, draw, redraws, innerCalls, base };
}

describe("resolver", () => {
	test("leaves tools it does not guard alone", () => {
		const trace = createTrace();
		const base = { renderCall: () => new Lines([]) };
		assert.equal(
			trace.resolver("read", () => base as never),
			base,
		);
		assert.equal(
			trace.resolver("bash", () => undefined),
			undefined,
		);
	});

	test("keeps the tool's own result renderer and shell", () => {
		const { resolved, base } = harness();
		assert.equal(resolved?.renderResult, base.renderResult);
	});

	test("draws the call alone until the call has an entry and a level", () => {
		const { trace, draw } = harness();
		assert.deepEqual(draw("a").render(100), ["$ ls"]);
		trace.record(judged("a"));
		assert.deepEqual(draw("a").render(100), ["$ ls"], "level is off");
	});

	test("draws a note under the call once there is both", () => {
		const { trace, draw } = harness();
		trace.setLevel("scores");
		trace.record(judged("a"));
		const lines = draw("a").render(100);
		assert.equal(lines[0], "$ ls");
		assert.equal(lines.length, 2);
		assert.match(lines[1], /model allowed/);
		assert.deepEqual(draw("b").render(100), ["$ ls"], "another call has no entry");
	});

	test("expanded draws the detailed note", () => {
		const { trace, draw } = harness();
		trace.setLevel("scores");
		trace.record(judged("a"));
		assert.ok(draw("a", undefined, true).render(100).length > 2);
	});

	test("hands the tool back its own component on later draws", () => {
		const { draw, innerCalls } = harness();
		const first = draw("a");
		const second = draw("a", first);
		assert.equal(second, first, "reused");
		assert.equal(innerCalls[0], undefined, "first draw: nothing to hand back");
		assert.ok(innerCalls[1] instanceof Lines, "the tool saw its own component, not the wrapper");
	});

	test("reads the level live: a component drawn earlier follows a level change", () => {
		const { trace, draw } = harness();
		trace.record(judged("a"));
		const component = draw("a");
		assert.equal(component.render(100).length, 1);
		trace.setLevel("scores");
		assert.equal(component.render(100).length, 2);
		trace.setLevel("off");
		assert.equal(component.render(100).length, 1);
	});

	test("draws no note when the call itself drew nothing", () => {
		const trace = createTrace();
		trace.setLevel("scores");
		trace.record(judged("a"));
		const resolved = trace.resolver("bash", () => ({ renderCall: () => new Lines([]) }) as never);
		const component = resolved?.renderCall?.(
			{} as never,
			theme as never,
			{
				toolCallId: "a",
				invalidate: () => {},
				lastComponent: undefined,
				expanded: false,
			} as never,
		) as Component;
		assert.deepEqual(component.render(100), []);
	});
});

describe("redrawing", () => {
	test("a recorded decision redraws only its own row", () => {
		const { trace, draw, redraws } = harness();
		draw("a");
		draw("b");
		trace.record(judged("a"));
		assert.deepEqual(redraws, ["a"]);
	});

	test("a level change redraws every known row, and not when nothing changed", () => {
		const { trace, draw, redraws } = harness();
		draw("a");
		draw("b");
		trace.setLevel("all");
		assert.deepEqual(redraws.sort(), ["a", "b"]);
		trace.setLevel("all");
		assert.equal(redraws.length, 2);
	});
});

describe("loading a session", () => {
	const item = (data: unknown, customType = "command-guard") => ({
		type: "custom",
		customType,
		data,
	});

	test("rebuilds notes from audit entries, and redraws rows already on screen", () => {
		const { trace, draw, redraws } = harness();
		trace.setLevel("scores");
		const component = draw("a");
		trace.load([item(judged("a")), item({ nonsense: true }), item(judged("z"), "other")]);
		assert.ok(trace.get("a"));
		assert.equal(trace.get("z"), undefined, "only command-guard entries");
		assert.deepEqual(redraws, ["a"]);
		assert.equal(component.render(100).length, 2);
	});

	test("replaces what was known", () => {
		const trace = createTrace();
		trace.record(judged("old"));
		trace.load([item(judged("new"))]);
		assert.equal(trace.get("old"), undefined);
		assert.ok(trace.get("new"));
	});

	test("an entry that survived a JSON round trip is still the same", () => {
		const entry = judged("a", {
			thresholds: { unauthorized: { confirm: 0.5, block: Number.POSITIVE_INFINITY } },
		});
		const parsed = parseAuditEntry(JSON.parse(JSON.stringify(entry)));
		assert.deepEqual(parsed?.thresholds, { unauthorized: { confirm: 0.5 } });
		assert.deepEqual(parsed?.scores, entry.scores);
	});
});

describe("parseAuditEntry", () => {
	test("rejects what is not an audit entry", () => {
		for (const bad of [
			null,
			"x",
			{},
			{ toolCallId: "a" },
			{ toolCallId: "a", tool: "bash", outcome: "maybe", source: "judge" },
			{ toolCallId: "a", tool: "bash", outcome: "allow" },
		]) {
			assert.equal(parseAuditEntry(bad), undefined, JSON.stringify(bad));
		}
	});

	test("drops malformed scores, thresholds, rules, and notes rather than the entry", () => {
		const parsed = parseAuditEntry({
			toolCallId: "a",
			tool: "bash",
			outcome: "allow",
			source: "judge",
			rules: ["ok", 7, null],
			scores: { destructive: 0.1, bad: "x", nan: Number.NaN },
			thresholds: { destructive: { confirm: 0.3 }, bad: { confirm: "x" }, worse: null },
			notes: ["fine", 3],
		});
		assert.deepEqual(parsed?.rules, ["ok"]);
		assert.deepEqual(parsed?.scores, { destructive: 0.1 });
		assert.deepEqual(parsed?.thresholds, { destructive: { confirm: 0.3 } });
		assert.deepEqual(parsed?.notes, ["fine"]);
	});
});
