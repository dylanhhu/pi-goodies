import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AuditEntry } from "../../extensions/command-guard/guard.ts";
import { renderNote, visible } from "../../extensions/command-guard/trace-format.ts";

const plain = { fg: (_color: string, text: string) => text };
/** Makes colors visible in the output */
const tagged = { fg: (color: string, text: string) => `{${color}:${text}}` };

const thresholds = {
	destructive: { confirm: 0.3, block: 0.9 },
	exfiltration: { confirm: 0.3, block: 0.9 },
	persistence: { confirm: 0.3, block: 0.9 },
	obfuscation: { confirm: 0.3, block: 0.9 },
	unauthorized: { confirm: 0.5 },
};

const judged: AuditEntry = {
	tool: "bash",
	toolCallId: "t",
	outcome: "allow",
	source: "judge",
	rules: ["egress-unknown-host"],
	scores: {
		destructive: 0.04,
		exfiltration: 0.21,
		persistence: 0.01,
		obfuscation: 0.02,
		unauthorized: 0.12,
	},
	thresholds,
};

const allowlisted: AuditEntry = {
	tool: "bash",
	toolCallId: "t",
	outcome: "allow",
	source: "allowlist",
	rules: [],
};

const opts = (over: Partial<Parameters<typeof renderNote>[1]> = {}) => ({
	level: "scores" as const,
	expanded: false,
	width: 120,
	...over,
});

describe("visibility", () => {
	test("off shows nothing", () => {
		assert.deepEqual(renderNote(judged, opts({ level: "off" }), plain), []);
	});

	test("scores shows judged calls only; all adds the rest", () => {
		assert.equal(visible(judged, "scores"), true);
		assert.equal(visible(allowlisted, "scores"), false);
		assert.equal(visible(allowlisted, "all"), true);
		const unmatched: AuditEntry = { ...allowlisted, source: "unmatched" };
		assert.equal(visible(unmatched, "scores"), false);
		assert.equal(visible(unmatched, "all"), true);
	});

	test("a call you approved without the model is shown at all, not at scores", () => {
		const entry: AuditEntry = {
			...allowlisted,
			outcome: "confirm",
			source: "rule",
			confirmed: true,
		};
		assert.equal(visible(entry, "scores"), false);
		assert.equal(visible(entry, "all"), true);
	});

	test("a judged call you approved is shown at scores", () => {
		assert.equal(visible({ ...judged, outcome: "confirm", confirmed: true }, "scores"), true);
	});

	test("blocked and declined calls never get a note", () => {
		assert.equal(visible({ ...judged, outcome: "block" }, "all"), false);
		assert.equal(visible({ ...judged, outcome: "confirm", confirmed: false }, "all"), false);
		assert.equal(visible({ ...judged, outcome: "confirm" }, "all"), false);
	});
});

describe("one-line view", () => {
	test("is a single line with every dimension, highest first", () => {
		const lines = renderNote(judged, opts({ width: 200 }), plain);
		assert.equal(lines.length, 1);
		const text = lines[0];
		assert.match(text, /model allowed/);
		const order = ["exfiltration", "unauthorized", "destructive", "obfuscation", "persistence"].map(
			(name) => text.indexOf(name),
		);
		assert.ok(
			order.every((i) => i > 0),
			text,
		);
		assert.deepEqual(
			order,
			[...order].sort((a, b) => a - b),
		);
		assert.match(text, /exfiltration 0\.21/);
	});

	test("falls back to short names, then truncates, to stay within the width", () => {
		for (const width of [200, 100, 80, 50, 30]) {
			for (const line of renderNote(judged, opts({ width }), plain)) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			}
		}
		assert.match(renderNote(judged, opts({ width: 100 }), plain)[0], /exfil 0\.21/);
	});

	test("colors by distance to the confirm threshold", () => {
		const entry: AuditEntry = {
			...judged,
			scores: { destructive: 0.02, exfiltration: 0.2, persistence: 0.35 },
		};
		const [line] = renderNote(entry, opts({ width: 400 }), tagged);
		assert.match(line, /\{muted:0\.02\}/, "far below: muted");
		assert.match(line, /\{warning:0\.20\}/, "past half of the threshold: warning");
		assert.match(line, /\{error:0\.35\}/, "over the threshold: error");
	});

	test("an unassessed dimension reads n/a rather than being left out", () => {
		const entry: AuditEntry = {
			...judged,
			scores: { destructive: 0.1, exfiltration: 0.1, persistence: 0.1, obfuscation: 0.1 },
			notes: ["authorization not assessed: no user messages in this run"],
		};
		assert.match(renderNote(entry, opts({ width: 200 }), plain)[0], /unauthorized n\/a/);
	});

	test("says so when the decision model was unavailable and you approved", () => {
		const entry: AuditEntry = {
			tool: "bash",
			toolCallId: "t",
			outcome: "confirm",
			source: "judge",
			rules: [],
			scores: {},
			judgeError: true,
			confirmed: true,
		};
		const [line] = renderNote(entry, opts(), plain);
		assert.match(line, /you approved/);
		assert.match(line, /decision model unavailable/);
	});

	test("names who approved", () => {
		assert.match(renderNote(judged, opts(), plain)[0], /model allowed/);
		const approved: AuditEntry = { ...judged, outcome: "confirm", confirmed: true };
		assert.match(renderNote(approved, opts(), plain)[0], /you approved/);
		assert.match(renderNote(allowlisted, opts({ level: "all" }), plain)[0], /allowlisted/);
	});
});

describe("expanded view", () => {
	test("has a row per dimension with its thresholds and a bar", () => {
		const lines = renderNote(judged, opts({ expanded: true }), plain);
		const row = lines.find((l) => l.includes("exfiltration"));
		assert.ok(row);
		assert.match(row, /0\.21/);
		assert.match(row, /confirm 0\.30 {2}block 0\.90/);
		assert.match(row, /[━╌]/);
		const unauthorized = lines.find((l) => l.includes("unauthorized"));
		assert.ok(unauthorized);
		assert.match(unauthorized, /confirm 0\.50/);
		assert.doesNotMatch(unauthorized, /block/, "no block threshold applies to authorization");
	});

	test("marks the thresholds on the bar, and fills it in proportion to the score", () => {
		const entry: AuditEntry = { ...judged, scores: { exfiltration: 0.5 } };
		const lines = renderNote(entry, opts({ expanded: true }), plain);
		const row = lines.find((l) => l.includes("exfiltration")) ?? "";
		const barText = row.match(/[━╌│]{20}/)?.[0] ?? "";
		assert.equal(barText.length, 20);
		assert.equal(barText[6], "│", "confirm 0.30");
		assert.equal(barText[18], "│", "block 0.90");
		assert.equal(barText.slice(0, 6), "━━━━━━", "filled up to the confirm marker");
		assert.equal(barText.slice(7, 10), "━━━", "and on to half");
		assert.equal(barText.slice(10).includes("━"), false, "nothing past half");
	});

	test("lists the rules that flagged it, and the notes", () => {
		const entry: AuditEntry = { ...judged, notes: ["authorization not assessed: delegated"] };
		const text = renderNote(entry, opts({ expanded: true }), plain).join("\n");
		assert.match(text, /flagged by\s+egress-unknown-host/);
		assert.match(text, /authorization not assessed: delegated/);
	});

	test("drops the bar before overflowing a narrow terminal", () => {
		for (const width of [90, 60, 40]) {
			for (const line of renderNote(judged, opts({ expanded: true, width }), plain)) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
			}
		}
		const row = renderNote(judged, opts({ expanded: true, width: 60 }), plain).find((l) =>
			l.includes("destructive"),
		);
		assert.doesNotMatch(row ?? "", /━|╌/);
	});

	test("explains a call that never reached the model", () => {
		const text = renderNote(allowlisted, opts({ level: "all", expanded: true }), plain).join("\n");
		assert.match(text, /decision model skipped/);
	});

	test("entries without recorded thresholds fall back to the default confirm threshold", () => {
		const { thresholds: _omitted, ...bare } = judged;
		const text = renderNote(bare, opts({ expanded: true }), plain).join("\n");
		assert.match(text, /confirm 0\.30/);
	});

	test("rule ids from a config cannot carry terminal escapes", () => {
		const entry: AuditEntry = { ...judged, rules: ["evil\x1b[2J\x07id"] };
		const text = renderNote(entry, opts({ expanded: true }), plain).join("\n");
		assert.equal(text.includes("\x1b"), false);
		assert.equal(text.includes("\x07"), false);
		assert.match(text, /evil\?\[2J\?id/);
	});
});
