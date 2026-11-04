import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type ClassifyContext,
	type ClassifyFn,
	createModel,
	type ScopeInput,
} from "../../extensions/command-guard/model.ts";
import type {
	Decision,
	Descriptor,
	ResolvedClassifier,
} from "../../extensions/command-guard/types.ts";

const descriptor = (command: string, paths: string[] = []): Descriptor => ({
	tool: "bash",
	cwd: "/Users/me/proj",
	command,
	scanText: command,
	hosts: [],
	paths,
});

const inspection: Decision = {
	outcome: "allow",
	source: "inspect",
	cause: "no mutation found",
	detail: "python3 runs other programs",
};

const outsideWrite: Decision = {
	outcome: "ask",
	source: "path",
	cause: "write outside the workspace",
	detail: "/Users/me/.agents/skills/a/SKILL.md",
};

const settings = (overrides: Partial<ResolvedClassifier> = {}): ResolvedClassifier => ({
	model: "provider/model",
	timeoutMs: 1_000,
	opaqueRisk: { enabled: true, ask: 0.6, block: 0.92, onError: "keep" },
	scope: { enabled: true, threshold: 0.65, onError: "ask" },
	...overrides,
});

function answers(scores: Record<string, number>): ClassifyFn {
	return async (context: ClassifyContext) => ({
		stopReason: "stop" as const,
		answers: Object.fromEntries(
			Object.keys(context.questions).map((key) => [
				key,
				{ type: "bool" as const, probability: scores[key] ?? 0 },
			]),
		),
	});
}

describe("opaque risk", () => {
	test("a clean script stays allowed", async () => {
		const model = createModel(answers({}), settings());
		const result = await model.opaqueRisk({
			descriptor: descriptor("python3 - <<'PY'\nprint(1)\nPY"),
			decision: inspection,
		});
		assert.equal(result.outcome, "allow");
	});

	test("a hidden write asks even at high confidence; an irreversible effect blocks", async () => {
		const ask = createModel(answers({ hiddenWrite: 0.7 }), settings());
		assert.equal(
			(
				await ask.opaqueRisk({
					descriptor: descriptor("python3 - <<'PY'\nopen('/etc/x','w')\nPY"),
					decision: inspection,
				})
			).outcome,
			"ask",
		);

		const veryConfidentWrite = createModel(answers({ hiddenWrite: 0.99 }), settings());
		assert.equal(
			(
				await veryConfidentWrite.opaqueRisk({
					descriptor: descriptor("python3 - <<'PY'\nopen('/etc/x','w')\nPY"),
					decision: inspection,
				})
			).outcome,
			"ask",
		);

		const block = createModel(answers({ destructive: 0.95 }), settings());
		assert.equal(
			(
				await block.opaqueRisk({
					descriptor: descriptor("python3 - <<'PY'\nimport shutil\nshutil.rmtree('/')\nPY"),
					decision: inspection,
				})
			).outcome,
			"block",
		);
	});

	test("the risk context has the action but no user messages", async () => {
		let seen: ClassifyContext | undefined;
		const model = createModel(async (context) => {
			seen = context;
			return {
				stopReason: "stop",
				answers: Object.fromEntries(
					Object.keys(context.questions).map((key) => [key, { type: "bool", probability: 0 }]),
				),
			};
		}, settings());
		await model.opaqueRisk({
			descriptor: descriptor("node -e 'console.log(1)'"),
			decision: inspection,
		});
		assert.ok(seen);
		const text = JSON.stringify(seen);
		assert.ok(text.includes("node -e"));
		assert.ok(!text.includes("userMessages"));
	});

	test("the configured onError outcome applies to failures", async () => {
		const failing: ClassifyFn = async () => {
			throw new Error("provider down");
		};
		const keep = createModel(failing, settings());
		assert.equal(
			(await keep.opaqueRisk({ descriptor: descriptor("python3 -c 1"), decision: inspection }))
				.outcome,
			"allow",
		);

		const ask = createModel(
			failing,
			settings({ opaqueRisk: { enabled: true, ask: 0.6, block: 0.92, onError: "ask" } }),
		);
		assert.equal(
			(await ask.opaqueRisk({ descriptor: descriptor("python3 -c 1"), decision: inspection }))
				.outcome,
			"ask",
		);

		const block = createModel(
			failing,
			settings({ opaqueRisk: { enabled: true, ask: 0.6, block: 0.92, onError: "block" } }),
		);
		assert.equal(
			(await block.opaqueRisk({ descriptor: descriptor("python3 -c 1"), decision: inspection }))
				.outcome,
			"block",
		);
	});

	test("oversized opaque code asks instead of being silently allowed", async () => {
		const model = createModel(answers({}), settings());
		const result = await model.opaqueRisk({
			descriptor: descriptor(`python3 -c '${"x".repeat(60_001)}'`),
			decision: inspection,
		});
		assert.equal(result.outcome, "ask");
		assert.match(result.cause, /too large/);
	});

	test("a repeated opaque action is cached", async () => {
		let calls = 0;
		const model = createModel(async (context) => {
			calls++;
			return {
				stopReason: "stop",
				answers: Object.fromEntries(
					Object.keys(context.questions).map((key) => [key, { type: "bool", probability: 0 }]),
				),
			};
		}, settings());
		const input = {
			descriptor: descriptor("python3 -c 'print(1)'"),
			decision: inspection,
		};
		await model.opaqueRisk(input);
		await model.opaqueRisk(input);
		assert.equal(calls, 1);
	});
});

describe("scope", () => {
	const scopeInput = (userMessages: string[]): ScopeInput => ({
		descriptor: descriptor("echo x > ~/.agents/skills/a/SKILL.md", [
			"/Users/me/.agents/skills/a/SKILL.md",
		]),
		decision: outsideWrite,
		userMessages,
	});

	test("a clearly requested effect suppresses the ask", async () => {
		const model = createModel(answers({ authorized: 0.8 }), settings());
		const result = await model.scope(scopeInput(["create a skill in ~/.agents"]));
		assert.equal(result.outcome, "allow");
	});

	test("an uncertain or unrelated effect keeps the ask", async () => {
		const model = createModel(answers({ authorized: 0.3 }), settings());
		const result = await model.scope(scopeInput(["just do the task"]));
		assert.equal(result.outcome, "ask");
	});

	test("the scope context includes the user's messages and the effect", async () => {
		let seen: ClassifyContext | undefined;
		const model = createModel(async (context) => {
			seen = context;
			return {
				stopReason: "stop",
				answers: { authorized: { type: "bool", probability: 0.8 } },
			};
		}, settings());
		await model.scope(scopeInput(["create a skill named a"]));
		const text = JSON.stringify(seen);
		assert.ok(text.includes("create a skill named a"));
		assert.ok(text.includes("write outside the workspace"));
	});

	test("no user messages cannot authorize anything", async () => {
		const model = createModel(answers({ authorized: 0.99 }), settings());
		const result = await model.scope(scopeInput([]));
		assert.equal(result.outcome, "ask");
	});

	test("a failed scope call asks by default, and may allow if configured", async () => {
		const failing: ClassifyFn = async () => {
			throw new Error("provider down");
		};
		const ask = createModel(failing, settings());
		assert.equal((await ask.scope(scopeInput(["create a skill"]))).outcome, "ask");

		const allow = createModel(
			failing,
			settings({ scope: { enabled: true, threshold: 0.65, onError: "allow" } }),
		);
		assert.equal((await allow.scope(scopeInput(["create a skill"]))).outcome, "allow");
	});

	test("a repeated scope action with the same messages is cached", async () => {
		let calls = 0;
		const model = createModel(async (_context) => {
			calls++;
			return {
				stopReason: "stop",
				answers: { authorized: { type: "bool", probability: 0.8 } },
			};
		}, settings());
		await model.scope(scopeInput(["create a skill"]));
		await model.scope(scopeInput(["create a skill"]));
		assert.equal(calls, 1);
	});

	test("a timeout follows the configured scope failure outcome", async () => {
		const model = createModel(
			async () => await new Promise(() => {}),
			settings({
				timeoutMs: 10,
				scope: { enabled: true, threshold: 0.65, onError: "ask" },
			}),
		);
		const result = await model.scope(scopeInput(["create a skill"]));
		assert.equal(result.outcome, "ask");
		assert.match(result.detail ?? "", /timed out/);
	});
});
