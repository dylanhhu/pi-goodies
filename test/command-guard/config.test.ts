import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_ALLOWLIST } from "../../extensions/command-guard/allowlist.ts";
import {
	buildPolicy,
	DEFAULT_MAX_ACTION_CHARS,
	loadConfigFile,
	parseConfig,
} from "../../extensions/command-guard/config.ts";
import {
	ACTIONS,
	type GuardConfig,
	type GuardRule,
	isAction,
} from "../../extensions/command-guard/types.ts";

const RULES: GuardRule[] = [
	{ id: "net-leak", category: "exfiltration", pattern: "leak" },
	{ id: "odd-host", category: "egress", pattern: "host" },
	{ id: "wipe", category: "destructive", pattern: "wipe" },
	{ id: "rc-write", category: "persistence", paths: ["\\.zshrc$"] },
	{ id: "b64", category: "obfuscation", pattern: "b64" },
	{ id: "guard-files", category: "protected", paths: ["command-guard"] },
];

const actionOf = (policy: ReturnType<typeof buildPolicy>, id: string) =>
	policy.rules.find((r) => r.id === id)?.action;

describe("buildPolicy: profiles", () => {
	test("standard (default): block exfiltration and protected, confirm the rest", () => {
		const p = buildPolicy({}, { rules: RULES });
		assert.equal(actionOf(p, "net-leak"), "block");
		assert.equal(actionOf(p, "guard-files"), "block");
		for (const id of ["odd-host", "wipe", "rc-write", "b64"]) {
			assert.equal(actionOf(p, id), "confirm", id);
		}
		assert.deepEqual(p.unmatched, { bash: "allow", write: "allow", edit: "allow" });
	});

	test("strict confirms unmatched bash commands", () => {
		const p = buildPolicy({ global: { profile: "strict" } }, { rules: RULES });
		assert.equal(p.unmatched.bash, "confirm");
		assert.equal(p.unmatched.write, "allow");
	});

	test("balanced routes risk categories to the judge, keeps destructive on confirm", () => {
		const p = buildPolicy({ global: { profile: "balanced" } }, { rules: RULES });
		assert.equal(actionOf(p, "net-leak"), "judge");
		assert.equal(actionOf(p, "odd-host"), "judge");
		assert.equal(actionOf(p, "rc-write"), "judge");
		assert.equal(actionOf(p, "b64"), "judge");
		assert.equal(actionOf(p, "wipe"), "confirm");
		assert.equal(actionOf(p, "guard-files"), "block");
		assert.equal(p.unmatched.bash, "judge");
	});

	test("permissive also judges destructive rules", () => {
		const p = buildPolicy({ global: { profile: "permissive" } }, { rules: RULES });
		assert.equal(actionOf(p, "wipe"), "judge");
		assert.equal(actionOf(p, "guard-files"), "block");
	});
});

describe("buildPolicy: configuration precedence", () => {
	test("category defaults override the profile", () => {
		const p = buildPolicy({ global: { defaults: { egress: "block" } } }, { rules: RULES });
		assert.equal(actionOf(p, "odd-host"), "block");
	});

	test("unmatched overrides the profile per tool", () => {
		const p = buildPolicy(
			{ global: { profile: "balanced", unmatched: { bash: "confirm", edit: "judge" } } },
			{ rules: RULES },
		);
		assert.deepEqual(p.unmatched, { bash: "confirm", write: "allow", edit: "judge" });
	});

	test("a rule's own action beats the category default, an override beats both", () => {
		const rules: GuardRule[] = [
			{ id: "a", category: "egress", action: "block", pattern: "a" },
			{ id: "b", category: "egress", pattern: "b" },
		];
		const global: GuardConfig = { defaults: { egress: "judge" }, overrides: { a: "judge" } };
		const p = buildPolicy({ global }, { rules });
		assert.equal(actionOf(p, "a"), "judge");
		assert.equal(actionOf(p, "b"), "judge");
		assert.equal(actionOf(buildPolicy({ global: { overrides: {} } }, { rules }), "a"), "block");
	});

	test("an overridden action of allow disables the rule", () => {
		const p = buildPolicy({ global: { overrides: { wipe: "allow" } } }, { rules: RULES });
		assert.equal(actionOf(p, "wipe"), "allow");
	});
});

describe("buildPolicy: user rules", () => {
	test("legacy rules keep their action, label, and messages", () => {
		const legacy: GuardRule = {
			pattern: "\\bsudo\\b",
			action: "confirm",
			label: "sudo",
			message: "Proceed?",
		};
		const p = buildPolicy({ global: { rules: [legacy] } }, { rules: [] });
		assert.equal(p.rules.length, 1);
		assert.equal(p.rules[0].id, "user:0");
		assert.equal(p.rules[0].action, "confirm");
		assert.equal(p.rules[0].rule.message, "Proceed?");
		assert.ok(p.rules[0].pattern?.test("SUDO ls"));
	});

	test("a user rule with neither action nor category confirms", () => {
		const p = buildPolicy({ global: { rules: [{ pattern: "x" }] } }, { rules: [] });
		assert.equal(p.rules[0].action, "confirm");
	});

	test("rules default to bash, or every tool when they only match paths", () => {
		const p = buildPolicy(
			{
				global: { rules: [{ pattern: "x" }, { paths: ["y"] }, { pattern: "z", tools: ["edit"] }] },
			},
			{ rules: [] },
		);
		assert.deepEqual(p.rules[0].tools, ["bash"]);
		assert.deepEqual(p.rules[1].tools, ["bash", "write", "edit"]);
		assert.deepEqual(p.rules[2].tools, ["edit"]);
	});

	test("invalid regexes and matcher-less rules are skipped with a warning", () => {
		const p = buildPolicy(
			{ global: { rules: [{ pattern: "(" }, { label: "empty" }] } },
			{ rules: [] },
		);
		assert.equal(p.rules.length, 0);
		assert.equal(p.warnings.length, 2);
	});

	test("shipped rules come first, then global rules, then project rules", () => {
		const p = buildPolicy(
			{
				global: { rules: [{ id: "g", pattern: "g" }] },
				project: { rules: [{ id: "p", pattern: "p" }] },
			},
			{ rules: [{ id: "s", pattern: "s", category: "egress" }] },
		);
		assert.deepEqual(
			p.rules.map((r) => r.id),
			["s", "g", "p"],
		);
	});

	test("extra rules (such as dynamic protections) are appended to the shipped ones", () => {
		const p = buildPolicy(
			{},
			{ rules: RULES, extraRules: [{ id: "x", category: "protected", paths: ["x"] }] },
		);
		assert.equal(actionOf(p, "x"), "block");
	});
});

describe("buildPolicy: project config can only tighten", () => {
	test("category defaults cannot be loosened, but can be tightened", () => {
		const base: GuardConfig = { defaults: { egress: "confirm" } };
		const loosened = buildPolicy(
			{ global: base, project: { defaults: { egress: "allow" } } },
			{ rules: RULES },
		);
		assert.equal(actionOf(loosened, "odd-host"), "confirm");
		const tightened = buildPolicy(
			{ global: base, project: { defaults: { egress: "block" } } },
			{ rules: RULES },
		);
		assert.equal(actionOf(tightened, "odd-host"), "block");
	});

	test("a project profile cannot loosen the global one", () => {
		const p = buildPolicy(
			{ global: { profile: "standard" }, project: { profile: "permissive" } },
			{ rules: RULES },
		);
		assert.equal(actionOf(p, "net-leak"), "block");
		assert.equal(actionOf(p, "wipe"), "confirm");
		assert.equal(p.unmatched.bash, "judge", "unmatched may tighten");
	});

	test("overrides cannot be loosened, even against a rule's fixed action", () => {
		const rules: GuardRule[] = [{ id: "a", action: "block", pattern: "a" }];
		const p = buildPolicy({ project: { overrides: { a: "allow" } } }, { rules });
		assert.equal(actionOf(p, "a"), "block");
		const q = buildPolicy(
			{ global: { overrides: { a: "confirm" } }, project: { overrides: { a: "allow" } } },
			{ rules },
		);
		assert.equal(actionOf(q, "a"), "confirm");
	});

	test("unmatched cannot be loosened", () => {
		const p = buildPolicy(
			{ global: { unmatched: { bash: "confirm" } }, project: { unmatched: { bash: "allow" } } },
			{ rules: [] },
		);
		assert.equal(p.unmatched.bash, "confirm");
	});

	test("judge, allowedHosts and allowlist from the project are ignored", () => {
		const project: GuardConfig = {
			judge: { model: "evil/model" },
			allowedHosts: ["evil.example"],
			allowlist: { enabled: false, commands: [{ cmd: "curl" }] },
		};
		const p = buildPolicy({ project }, { rules: [] });
		assert.equal(p.judge, undefined);
		assert.ok(!p.allowedHosts.includes("evil.example"));
		assert.equal(p.allowlist.enabled, true);
		assert.deepEqual(p.allowlist.entries, DEFAULT_ALLOWLIST);
	});
});

describe("buildPolicy: allowlist, hosts, judge", () => {
	test("allowlist defaults and replacement", () => {
		const p = buildPolicy({}, { rules: [] });
		assert.equal(p.allowlist.enabled, true);
		const q = buildPolicy(
			{ global: { allowlist: { enabled: false, commands: [{ cmd: "make" }] } } },
			{ rules: [] },
		);
		assert.equal(q.allowlist.enabled, false);
		assert.deepEqual(q.allowlist.entries, [{ cmd: "make" }]);
	});

	test("allowedHosts extend the shipped list", () => {
		const p = buildPolicy({ global: { allowedHosts: ["internal.example"] } }, { rules: [] });
		assert.ok(p.allowedHosts.includes("internal.example"));
		assert.ok(p.allowedHosts.includes("github.com"));
	});

	test("judge is disabled without a model and resolved with defaults otherwise", () => {
		assert.equal(buildPolicy({ global: { judge: {} } }, { rules: [] }).judge, undefined);
		const j = buildPolicy({ global: { judge: { model: "p/m" } } }, { rules: [] }).judge;
		assert.ok(j);
		assert.equal(j.model, "p/m");
		assert.equal(j.onError, "confirm");
		assert.ok(j.timeoutMs > 0);
		assert.deepEqual(j.thresholds.default, { confirm: 0.3, block: 0.9 });
		assert.deepEqual(j.thresholds.unauthorized, { confirm: 0.5, block: Number.POSITIVE_INFINITY });
	});

	test("judge thresholds merge per dimension", () => {
		const j = buildPolicy(
			{
				global: {
					judge: {
						model: "p/m",
						onError: "block",
						thresholds: { exfiltration: { block: 0.7 }, unauthorized: { confirm: 0.2 } },
					},
				},
			},
			{ rules: [] },
		).judge;
		assert.ok(j);
		assert.equal(j.onError, "block");
		assert.deepEqual(j.thresholds.exfiltration, { confirm: 0.3, block: 0.7 });
		assert.deepEqual(j.thresholds.unauthorized, { confirm: 0.2, block: Number.POSITIVE_INFINITY });
	});
});

describe("parseConfig and loadConfigFile", () => {
	test("drops invalid actions, categories, and profiles with warnings", () => {
		const warnings: string[] = [];
		const cfg = parseConfig(
			{
				profile: "reckless",
				defaults: { egress: "nope", exfiltration: "judge", bogus: "block" },
				unmatched: { bash: "judge", read: "block" },
				overrides: { a: "block", b: "maybe" },
				rules: [{ pattern: "x", action: "explode" }],
			},
			warnings,
		);
		assert.equal(cfg.profile, undefined);
		assert.deepEqual(cfg.defaults, { exfiltration: "judge" });
		assert.deepEqual(cfg.unmatched, { bash: "judge" });
		assert.deepEqual(cfg.overrides, { a: "block" });
		assert.equal(cfg.rules?.[0].action, undefined);
		assert.ok(warnings.length >= 5);
	});

	test("loadConfigFile reads JSON, tolerates missing and malformed files", () => {
		const dir = mkdtempSync(join(tmpdir(), "cg-cfg-"));
		const good = join(dir, "good.json");
		writeFileSync(
			good,
			JSON.stringify({ profile: "balanced", rules: [{ pattern: "x", action: "block" }] }),
		);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{not json");

		const warnings: string[] = [];
		assert.equal(loadConfigFile(good, warnings)?.profile, "balanced");
		assert.equal(loadConfigFile(join(dir, "missing.json"), warnings), undefined);
		assert.equal(warnings.length, 0);
		assert.equal(loadConfigFile(bad, warnings), undefined);
		assert.equal(warnings.length, 1);
	});
});

describe("hostile project config", () => {
	const PROTOTYPE_KEYS = ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"];

	test("prototype keys are not actions", () => {
		for (const key of PROTOTYPE_KEYS) assert.equal(isAction(key), false, key);
		for (const action of ACTIONS) assert.equal(isAction(action), true, action);
	});

	test("a project cannot downgrade a block by naming a prototype key as the action", () => {
		for (const key of PROTOTYPE_KEYS) {
			const warnings: string[] = [];
			const project = parseConfig(
				{
					defaults: { exfiltration: key },
					unmatched: { bash: key },
					overrides: { "net-leak": key },
				},
				warnings,
			);
			assert.ok(warnings.length >= 2, key);
			const p = buildPolicy({ project }, { rules: RULES });
			assert.equal(actionOf(p, "net-leak"), "block", key);
			assert.equal(p.unmatched.bash, "allow", key);
		}
	});

	test("override lookups ignore the prototype chain, so odd rule ids are safe", () => {
		const rules: GuardRule[] = [
			{ id: "constructor", pattern: "x", action: "block" },
			{ id: "toString", pattern: "y", action: "block" },
		];
		const p = buildPolicy({ global: { overrides: {} }, project: { overrides: {} } }, { rules });
		assert.equal(actionOf(p, "constructor"), "block");
		assert.equal(actionOf(p, "toString"), "block");
	});

	test("project rules cannot set label, message, or denyMessage", () => {
		const project: GuardConfig = {
			rules: [
				{
					id: "Run the unit tests",
					pattern: "curl",
					action: "confirm",
					label: "Run the unit tests",
					message: "Run the unit test suite?",
					denyMessage: "Fine, never mind",
				},
			],
		};
		const p = buildPolicy({ project }, { rules: [] });
		const rule = p.rules[0];
		assert.equal(rule.source, "project");
		assert.equal(rule.action, "confirm", "the matcher and action still apply");
		assert.equal(rule.rule.message, undefined);
		assert.equal(rule.rule.denyMessage, undefined);
		assert.ok(!/unit test/i.test(rule.rule.label ?? ""));
		assert.match(rule.rule.label ?? "", /project/);
		assert.ok(p.warnings.some((w) => /label, message, denyMessage ignored/.test(w)));
	});

	test("global rules keep their text", () => {
		const p = buildPolicy(
			{ global: { rules: [{ pattern: "x", label: "mine", message: "Proceed?" }] } },
			{ rules: [] },
		);
		assert.equal(p.rules[0].source, "global");
		assert.equal(p.rules[0].rule.label, "mine");
		assert.equal(p.rules[0].rule.message, "Proceed?");
	});
});

describe("config shape validation", () => {
	const parse = (raw: unknown) => {
		const warnings: string[] = [];
		const cfg = parseConfig(raw, warnings);
		return { cfg, warnings };
	};

	test("rules with a malformed matcher are dropped whole, with a warning", () => {
		for (const rule of [
			{ allOf: "x" },
			{ paths: "x" },
			{ paths: [1] },
			{ pattern: 5 },
			{ pattern: "x", hosts: "evil.com" },
			{ pattern: "x", hosts: { tlds: "ru" } },
			{ pattern: "x", hosts: { ipLiteral: "yes" } },
		]) {
			const { cfg, warnings } = parse({ rules: [rule] });
			assert.deepEqual(cfg.rules, [], JSON.stringify(rule));
			assert.equal(warnings.length, 1, JSON.stringify(rule));
		}
	});

	test("non-string text fields are ignored with a warning, the rule stays", () => {
		const { cfg, warnings } = parse({ rules: [{ pattern: "x", label: 5, message: [], id: {} }] });
		assert.equal(cfg.rules?.length, 1);
		assert.equal(cfg.rules?.[0].label, undefined);
		assert.equal(warnings.length, 3);
	});

	test("unknown rule fields are reported, since they are usually typos", () => {
		const { warnings } = parse({ rules: [{ pattrn: "x", pattern: "y" }] });
		assert.match(warnings.join(), /unknown field "pattrn"/);
	});

	test("host lists are normalized to lowercase without a leading dot", () => {
		const { cfg } = parse({
			rules: [{ hosts: { tlds: [".RU"], domains: ["*.Evil.com", " paste.ee "] } }],
			allowedHosts: [".Example.org"],
		});
		assert.deepEqual(cfg.rules?.[0].hosts, { tlds: ["ru"], domains: ["evil.com", "paste.ee"] });
		assert.deepEqual(cfg.allowedHosts, ["example.org"]);
	});

	test("judge settings are validated", () => {
		for (const judge of [{ model: 5 }, { model: "no-slash" }, { model: "p/" }, { model: "/m" }]) {
			const { cfg, warnings } = parse({ judge });
			assert.equal(cfg.judge?.model, undefined, JSON.stringify(judge));
			assert.equal(warnings.length, 1, JSON.stringify(judge));
		}
		const { cfg, warnings } = parse({
			judge: {
				model: "p/m",
				timeoutMs: -1,
				onError: "allow",
				thresholds: {
					exfiltration: { block: "high", confirm: 0.2 },
					bogus: { confirm: 1 },
					default: 3,
				},
			},
		});
		assert.equal(cfg.judge?.model, "p/m");
		assert.equal(cfg.judge?.timeoutMs, undefined);
		assert.equal(cfg.judge?.onError, undefined);
		assert.deepEqual(cfg.judge?.thresholds, { exfiltration: { confirm: 0.2 } });
		assert.equal(warnings.length, 5);
		assert.equal(buildPolicy({ global: cfg }, { rules: [] }).judge?.onError, "confirm");
	});

	test("allowlist entries are validated, bad ones dropped", () => {
		const { cfg, warnings } = parse({
			allowlist: {
				enabled: "yes",
				commands: [
					{ cmd: "make" },
					{ cmd: "/bin/sh" },
					{},
					{ cmd: "git", subcommands: "status" },
					{ cmd: "rg", denyFlags: ["--pre"], recursive: true },
				],
			},
		});
		assert.deepEqual(cfg.allowlist?.commands, [
			{ cmd: "make" },
			{ cmd: "rg", denyFlags: ["--pre"], recursive: true },
		]);
		assert.equal(cfg.allowlist?.enabled, undefined);
		assert.equal(warnings.length, 4);
	});

	test("wrongly typed containers are reported rather than crashing", () => {
		const { warnings } = parse({
			rules: {},
			allowedHosts: "x",
			judge: [],
			allowlist: 5,
			limits: "x",
			display: [],
		});
		assert.equal(warnings.length, 6);
	});

	test("no config shape makes buildPolicy throw", () => {
		const shapes: unknown[] = [
			{ rules: [{ allOf: "x" }, { paths: {} }, null, 5, "x", []] },
			{ rules: [{ pattern: "x", hosts: [] }] },
			{ judge: { model: 5, thresholds: [] } },
			{ allowlist: { commands: [null, 5, { cmd: 5 }] } },
			{ limits: { maxActionChars: "lots", onOversize: 7 } },
			{ display: { approved: 7 } },
			{ defaults: [], unmatched: 5, overrides: "x" },
			[],
			null,
			"{}",
		];
		for (const shape of shapes) {
			const cfg = parseConfig(shape, []);
			assert.doesNotThrow(() => buildPolicy({ global: cfg, project: cfg }), JSON.stringify(shape));
		}
	});
});

describe("limits", () => {
	test("default to 60,000 characters and human review", () => {
		const p = buildPolicy({}, { rules: [] });
		assert.deepEqual(p.limits, { maxActionChars: DEFAULT_MAX_ACTION_CHARS, onOversize: "confirm" });
		assert.equal(DEFAULT_MAX_ACTION_CHARS, 60_000);
	});

	test("come from the global config only", () => {
		const { cfg } = {
			cfg: parseConfig({ limits: { maxActionChars: 500, onOversize: "block" } }, []),
		};
		assert.deepEqual(buildPolicy({ global: cfg }, { rules: [] }).limits, {
			maxActionChars: 500,
			onOversize: "block",
		});
		assert.deepEqual(
			buildPolicy({ project: cfg }, { rules: [] }).limits,
			{ maxActionChars: DEFAULT_MAX_ACTION_CHARS, onOversize: "confirm" },
			"a project cannot touch the limits",
		);
	});

	test("invalid values are reported and replaced by the defaults", () => {
		const warnings: string[] = [];
		const cfg = parseConfig({ limits: { maxActionChars: 0, onOversize: "allow" } }, warnings);
		assert.equal(warnings.length, 2);
		assert.deepEqual(buildPolicy({ global: cfg }, { rules: [] }).limits, {
			maxActionChars: DEFAULT_MAX_ACTION_CHARS,
			onOversize: "confirm",
		});
	});
});

describe("display", () => {
	const level = (layers: Parameters<typeof buildPolicy>[0]) =>
		buildPolicy(layers, { rules: [] }).display.approved;

	test("approved-call notes are off by default", () => {
		assert.equal(level({}), "off");
	});

	test("accepts each level", () => {
		for (const approved of ["off", "scores", "all"]) {
			const warnings: string[] = [];
			const cfg = parseConfig({ display: { approved } }, warnings);
			assert.deepEqual(warnings, []);
			assert.equal(level({ global: cfg }), approved);
		}
	});

	test("comes from the global config only", () => {
		const cfg = parseConfig({ display: { approved: "all" } }, []);
		assert.equal(level({ project: cfg }), "off");
		assert.equal(
			level({ global: parseConfig({ display: { approved: "scores" } }, []), project: cfg }),
			"scores",
		);
	});

	test("an unknown level is reported and replaced by off", () => {
		const warnings: string[] = [];
		const cfg = parseConfig({ display: { approved: "verbose" } }, warnings);
		assert.equal(warnings.length, 1);
		assert.equal(level({ global: cfg }), "off");
	});
});
