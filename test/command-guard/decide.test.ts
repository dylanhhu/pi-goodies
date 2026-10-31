import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPolicy, type Policy } from "../../extensions/command-guard/config.ts";
import { decide } from "../../extensions/command-guard/decide.ts";
import { describeBash } from "../../extensions/command-guard/descriptor.ts";
import type { JudgeInput, JudgeVerdict } from "../../extensions/command-guard/judge.ts";
import type { Descriptor, GuardConfig, GuardRule } from "../../extensions/command-guard/types.ts";

const HOME = "/Users/me";
const CWD = "/Users/me/proj";

function setup(rules: GuardRule[], global: GuardConfig = {}, verdict?: JudgeVerdict) {
	const calls: JudgeInput[] = [];
	const policy: Policy = buildPolicy({ global }, { rules });
	const deps = {
		home: HOME,
		userMessages: () => ["do the thing"],
		judge: verdict
			? async (input: JudgeInput) => {
					calls.push(input);
					return verdict;
				}
			: undefined,
	};
	const run = (command: string) => decide(describeBash(command, CWD, HOME), policy, deps);
	return { run, calls, policy, deps };
}

const ALLOW: JudgeVerdict = { outcome: "allow", scores: { exfiltration: 0.01 }, reason: "fine" };
const CONFIRM: JudgeVerdict = { outcome: "confirm", scores: { exfiltration: 0.5 }, reason: "hmm" };
const BLOCK: JudgeVerdict = { outcome: "block", scores: { exfiltration: 0.99 }, reason: "bad" };

describe("decide: no rule matched", () => {
	test("allowlisted commands are allowed with source allowlist", async () => {
		const { run, calls } = setup([], { unmatched: { bash: "judge" } }, CONFIRM);
		const d = await run("ls -la");
		assert.equal(d.outcome, "allow");
		assert.equal(d.source, "allowlist");
		assert.equal(calls.length, 0, "the judge is skipped");
	});

	test("unmatched allow", async () => {
		const d = await setup([]).run("make build");
		assert.deepEqual([d.outcome, d.source], ["allow", "unmatched"]);
	});

	test("unmatched confirm and block", async () => {
		const confirm = await setup([], { unmatched: { bash: "confirm" } }).run("make build");
		assert.deepEqual([confirm.outcome, confirm.source], ["confirm", "unmatched"]);
		const block = await setup([], { unmatched: { bash: "block" } }).run("make build");
		assert.deepEqual([block.outcome, block.source], ["block", "unmatched"]);
	});

	test("unmatched judge consults the decision model", async () => {
		const { run, calls } = setup([], { unmatched: { bash: "judge" } }, BLOCK);
		const d = await run("make build");
		assert.deepEqual([d.outcome, d.source], ["block", "judge"]);
		assert.equal(d.verdict, BLOCK);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].userMessages, ["do the thing"]);
		assert.deepEqual(calls[0].hints, []);
		assert.equal(calls[0].descriptor.command, "make build");
	});

	test("unmatched judge without a configured model falls back to allow", async () => {
		const d = await setup([], { unmatched: { bash: "judge" } }).run("make build");
		assert.deepEqual([d.outcome, d.source], ["allow", "unmatched"]);
	});

	test("allowlist disabled sends plain commands down the unmatched path", async () => {
		const { run, calls } = setup(
			[],
			{ unmatched: { bash: "judge" }, allowlist: { enabled: false } },
			ALLOW,
		);
		const d = await run("ls");
		assert.equal(d.source, "judge");
		assert.equal(calls.length, 1);
	});

	test("the allowlist never applies to write or edit", async () => {
		const { policy, deps, calls } = setup([], { unmatched: { write: "judge" } }, ALLOW);
		const file: Descriptor = {
			tool: "write",
			cwd: CWD,
			hosts: [],
			paths: ["/Users/me/proj/a.ts"],
			content: "x",
		};
		const d = await decide(file, policy, deps);
		assert.equal(d.source, "judge");
		assert.equal(calls.length, 1);
	});
});

describe("decide: rules", () => {
	test("block rules block without consulting the judge", async () => {
		const { run, calls } = setup([{ id: "b", pattern: "danger", action: "block" }], {}, ALLOW);
		const d = await run("danger zone");
		assert.deepEqual([d.outcome, d.source, d.rule?.id], ["block", "rule", "b"]);
		assert.equal(calls.length, 0);
	});

	test("confirm rules ask the human without consulting the judge", async () => {
		const { run, calls } = setup([{ id: "c", pattern: "risky", action: "confirm" }], {}, ALLOW);
		const d = await run("risky thing");
		assert.deepEqual([d.outcome, d.source, d.rule?.id], ["confirm", "rule", "c"]);
		assert.equal(calls.length, 0);
	});

	test("rules beat the allowlist", async () => {
		const d = await setup([{ id: "b", pattern: "^ls", action: "block" }]).run("ls");
		assert.equal(d.outcome, "block");
	});

	test("the most severe matched rule decides", async () => {
		const { run, calls } = setup(
			[
				{ id: "j", pattern: "x", action: "judge" },
				{ id: "c", pattern: "x", action: "confirm" },
			],
			{},
			ALLOW,
		);
		const d = await run("x");
		assert.deepEqual([d.outcome, d.rule?.id, d.matched.length], ["confirm", "c", 2]);
		assert.equal(calls.length, 0);
	});

	test("judge rules pass the matched rules to the judge as hints", async () => {
		const { run, calls } = setup(
			[
				{ id: "j1", pattern: "x", action: "judge", label: "L1", category: "egress" },
				{ id: "j2", pattern: "x", action: "judge", label: "L2" },
			],
			{},
			ALLOW,
		);
		const d = await run("x");
		assert.deepEqual([d.outcome, d.source], ["allow", "judge"]);
		assert.deepEqual(calls[0].hints, [
			{ id: "j1", label: "L1", category: "egress" },
			{ id: "j2", label: "L2", category: undefined },
		]);
	});

	test("judge verdicts of confirm and block pass through", async () => {
		const rules: GuardRule[] = [{ id: "j", pattern: "x", action: "judge" }];
		assert.equal((await setup(rules, {}, CONFIRM).run("x")).outcome, "confirm");
		assert.equal((await setup(rules, {}, BLOCK).run("x")).outcome, "block");
	});

	test("a judge rule without a configured model degrades to confirm", async () => {
		const d = await setup([{ id: "j", pattern: "x", action: "judge" }]).run("x");
		assert.deepEqual([d.outcome, d.source, d.rule?.id], ["confirm", "rule", "j"]);
		assert.match(d.reason ?? "", /not configured/);
	});

	test("judge failures surface the onError outcome", async () => {
		const failed: JudgeVerdict = { outcome: "confirm", scores: {}, reason: "down", error: true };
		const d = await setup([{ id: "j", pattern: "x", action: "judge" }], {}, failed).run("x");
		assert.deepEqual([d.outcome, d.source], ["confirm", "judge"]);
		assert.equal(d.verdict?.error, true);
	});

	test("disabled (allow) rules fall through to the unmatched path", async () => {
		const d = await setup([{ id: "r", pattern: "x", action: "block" }], {
			overrides: { r: "allow" },
			unmatched: { bash: "confirm" },
		}).run("x");
		assert.deepEqual([d.outcome, d.source], ["confirm", "unmatched"]);
	});
});

describe("decide: size limit", () => {
	const LIMITS = { maxActionChars: 100 };
	const big = (n = 101) => `echo ${"a".repeat(n)}`;
	const writeOf = (content: string): Descriptor => ({
		tool: "write",
		cwd: CWD,
		hosts: [],
		paths: ["/Users/me/proj/f.txt"],
		content,
	});

	test("an oversized bash command that nothing flagged goes to the human, never to the judge", async () => {
		const { run, calls } = setup([], { limits: LIMITS, unmatched: { bash: "judge" } }, ALLOW);
		const d = await run(big());
		assert.deepEqual([d.outcome, d.source], ["confirm", "oversize"]);
		assert.match(d.reason ?? "", /too large for automatic review: \d+ characters, limit 100/);
		assert.equal(calls.length, 0);
	});

	test("even under unmatched allow, with no judge configured, and ahead of the allowlist", async () => {
		const { run } = setup([], { limits: LIMITS });
		const plain = await run(big()); // plain words: would be allowlisted if it were short
		assert.deepEqual([plain.outcome, plain.source], ["confirm", "oversize"]);
		assert.equal((await run("echo hi")).source, "allowlist");
	});

	test("the limit applies to the command, and the boundary is inclusive", async () => {
		const { run } = setup([], { limits: LIMITS });
		const exactly = `make ${"a".repeat(95)}`;
		assert.equal(exactly.length, 100);
		assert.equal((await run(exactly)).source, "unmatched");
		assert.equal((await run(`${exactly}a`)).source, "oversize");
	});

	test("onOversize block denies outright", async () => {
		const d = await setup([], { limits: { ...LIMITS, onOversize: "block" } }).run(big());
		assert.deepEqual([d.outcome, d.source], ["block", "oversize"]);
	});

	test("a judge rule is replaced by the oversize outcome instead of judging clipped text", async () => {
		const rules: GuardRule[] = [{ id: "r", category: "egress", pattern: "echo" }];
		const { run, calls } = setup(rules, { defaults: { egress: "judge" }, limits: LIMITS }, ALLOW);
		const d = await run(big());
		assert.deepEqual([d.outcome, d.source], ["confirm", "oversize"]);
		assert.deepEqual(
			d.matched.map((m) => m.id),
			["r"],
		);
		assert.equal(calls.length, 0);
		// Within the limit the same rule is judged
		assert.equal((await run("echo hi")).source, "judge");
	});

	test("rules that are stricter than the oversize outcome keep their say", async () => {
		const rules: GuardRule[] = [{ id: "r", pattern: "echo", action: "block" }];
		const d = await setup(rules, { limits: LIMITS }).run(big());
		assert.deepEqual([d.outcome, d.source], ["block", "rule"]);
	});

	test("a confirm rule becomes a block when oversized actions are blocked", async () => {
		const rules: GuardRule[] = [{ id: "r", pattern: "echo", action: "confirm" }];
		const blocking = setup(rules, { limits: { ...LIMITS, onOversize: "block" } });
		assert.equal((await blocking.run(big())).outcome, "block");
		const reviewing = setup(rules, { limits: LIMITS });
		assert.deepEqual(
			[(await reviewing.run(big())).outcome, (await reviewing.run(big())).source],
			["confirm", "rule"],
		);
	});

	test("write and edit content is only limited where it would reach the judge", async () => {
		const rules: GuardRule[] = [{ id: "p", category: "persistence", paths: ["f\\.txt$"] }];
		const judged = setup(rules, { defaults: { persistence: "judge" }, limits: LIMITS }, ALLOW);
		const oversized = await decide(writeOf("x".repeat(101)), judged.policy, judged.deps);
		assert.deepEqual([oversized.outcome, oversized.source], ["confirm", "oversize"]);
		assert.equal(judged.calls.length, 0);
		const small = await decide(writeOf("x"), judged.policy, judged.deps);
		assert.equal(small.source, "judge");

		// An unflagged large write is routine (a generated file), not a review
		const plain = setup([], { limits: LIMITS });
		const d = await decide(writeOf("x".repeat(5_000)), plain.policy, plain.deps);
		assert.deepEqual([d.outcome, d.source], ["allow", "unmatched"]);

		// ... unless unmatched writes are judged, which needs the whole text
		const unmatchedJudge = setup([], { unmatched: { write: "judge" }, limits: LIMITS }, ALLOW);
		const big2 = await decide(writeOf("x".repeat(101)), unmatchedJudge.policy, unmatchedJudge.deps);
		assert.equal(big2.source, "oversize");
		assert.equal(unmatchedJudge.calls.length, 0);
	});

	test("the default limit is far above ordinary commands", async () => {
		const { run } = setup([], { unmatched: { bash: "confirm" } });
		assert.equal((await run(`make ${"a".repeat(50_000)}`)).source, "unmatched");
		assert.equal((await run(`make ${"a".repeat(60_000)}`)).source, "oversize");
	});
});

describe("decide: context handed to the judge", () => {
	const rules: GuardRule[] = [{ id: "r", category: "egress", pattern: "echo" }];

	test("passes the delegated flag and the abort signal through", async () => {
		const { policy, calls } = setup(rules, { defaults: { egress: "judge" } }, ALLOW);
		const controller = new AbortController();
		const deps = {
			home: HOME,
			userMessages: () => ["Task: x"],
			delegated: true,
			signal: controller.signal,
			judge: async (input: JudgeInput) => {
				calls.push(input);
				return ALLOW;
			},
		};
		await decide(describeBash("echo hi", CWD, HOME), policy, deps);
		assert.equal(calls[0].delegated, true);
		assert.equal(calls[0].signal, controller.signal);
	});
});
