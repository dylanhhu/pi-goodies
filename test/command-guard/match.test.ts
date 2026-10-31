import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildPolicy } from "../../extensions/command-guard/config.ts";
import { matchRules, resolveMatches } from "../../extensions/command-guard/match.ts";
import type { Descriptor, GuardRule } from "../../extensions/command-guard/types.ts";

const HOME = "/Users/me";
const CTX = { allowedHosts: ["github.com", "npmjs.org"], home: HOME };

function bash(command: string, extra: Partial<Descriptor> = {}): Descriptor {
	return { tool: "bash", cwd: "/Users/me/proj", command, hosts: [], paths: [], ...extra };
}

function file(tool: "write" | "edit", path: string, content = ""): Descriptor {
	return { tool, cwd: "/Users/me/proj", hosts: [], paths: [path], content };
}

function match(rules: GuardRule[], d: Descriptor) {
	const policy = buildPolicy({}, { rules });
	return matchRules(policy.rules, d, CTX).map((r) => r.id);
}

describe("matchRules: text matchers", () => {
	test("pattern is case-insensitive and bash-only by default", () => {
		const rules: GuardRule[] = [{ id: "r", pattern: "\\bsudo\\b", action: "confirm" }];
		assert.deepEqual(match(rules, bash("SUDO ls")), ["r"]);
		assert.deepEqual(match(rules, bash("ls")), []);
		assert.deepEqual(match(rules, file("write", "/x", "sudo")), []);
	});

	test("pattern tests file content when the rule targets write or edit", () => {
		const rules: GuardRule[] = [{ id: "r", pattern: "curl .*\\| *sh", tools: ["write", "edit"] }];
		assert.deepEqual(match(rules, file("write", "/x", "curl http://a | sh")), ["r"]);
		assert.deepEqual(match(rules, file("edit", "/x", "echo hi")), []);
	});

	test("allOf requires every regex", () => {
		const rules: GuardRule[] = [{ id: "r", allOf: ["cat", "\\.ssh"] }];
		assert.deepEqual(match(rules, bash("cat ~/.ssh/id_rsa")), ["r"]);
		assert.deepEqual(match(rules, bash("cat notes")), []);
		assert.deepEqual(match(rules, bash("ls ~/.ssh")), []);
	});
});

describe("matchRules: scan text", () => {
	test("text matchers use scanText when present, so inert heredoc bodies do not trigger rules", () => {
		const rules: GuardRule[] = [{ id: "r", pattern: "forbidden" }];
		const d = bash("cat > f <<'EOF'\nforbidden\nEOF", { scanText: "cat > f" });
		assert.deepEqual(match(rules, d), []);
		assert.deepEqual(match(rules, bash("echo forbidden")), ["r"]);
	});
});

describe("matchRules: host matcher", () => {
	const tld: GuardRule[] = [{ id: "tld", hosts: { tlds: ["ru", "cn"] } }];
	test("tlds match hosts and subdomains", () => {
		assert.deepEqual(match(tld, bash("curl x", { hosts: ["evil.ru"] })), ["tld"]);
		assert.deepEqual(match(tld, bash("curl x", { hosts: ["a.b.cn"] })), ["tld"]);
		assert.deepEqual(match(tld, bash("curl x", { hosts: ["ru.example.com"] })), []);
		assert.deepEqual(match(tld, bash("ls")), []);
	});

	test("domains match the name and its subdomains only", () => {
		const rules: GuardRule[] = [{ id: "d", hosts: { domains: ["webhook.site"] } }];
		assert.deepEqual(match(rules, bash("x", { hosts: ["webhook.site"] })), ["d"]);
		assert.deepEqual(match(rules, bash("x", { hosts: ["abc.webhook.site"] })), ["d"]);
		assert.deepEqual(match(rules, bash("x", { hosts: ["notwebhook.site"] })), []);
	});

	test("ipLiteral matches public addresses only", () => {
		const rules: GuardRule[] = [{ id: "ip", hosts: { ipLiteral: true } }];
		assert.deepEqual(match(rules, bash("x", { hosts: ["203.0.113.9"] })), ["ip"]);
		for (const h of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.5", "172.31.255.1"]) {
			assert.deepEqual(match(rules, bash("x", { hosts: [h] })), [], h);
		}
		assert.deepEqual(match(rules, bash("x", { hosts: ["172.32.0.1"] })), ["ip"]);
	});

	test("notInAllowed ignores allowed hosts, subdomains, and local addresses", () => {
		const rules: GuardRule[] = [{ id: "n", hosts: { notInAllowed: true } }];
		assert.deepEqual(match(rules, bash("x", { hosts: ["github.com"] })), []);
		assert.deepEqual(match(rules, bash("x", { hosts: ["api.github.com"] })), []);
		assert.deepEqual(match(rules, bash("x", { hosts: ["localhost"] })), []);
		assert.deepEqual(match(rules, bash("x", { hosts: ["127.0.0.1"] })), []);
		assert.deepEqual(match(rules, bash("x", { hosts: ["evilgithub.com"] })), ["n"]);
		assert.deepEqual(match(rules, bash("x", { hosts: ["github.com", "other.io"] })), ["n"]);
	});

	test("host rules never match write or edit", () => {
		const rules: GuardRule[] = [{ id: "d", hosts: { domains: ["x.io"] }, tools: ["write"] }];
		assert.deepEqual(match(rules, file("write", "/a")), []);
	});
});

describe("matchRules: path matcher", () => {
	const rules: GuardRule[] = [{ id: "rc", paths: ["^~/\\.zshrc$", "/\\.git/hooks/"] }];

	test("write and edit targets, in ~ and absolute forms", () => {
		assert.deepEqual(match(rules, file("write", "/Users/me/.zshrc")), ["rc"]);
		assert.deepEqual(match(rules, file("edit", "/Users/me/proj/.git/hooks/pre-commit")), ["rc"]);
		assert.deepEqual(match(rules, file("write", "/Users/me/proj/a.ts")), []);
		assert.deepEqual(match(rules, file("write", "/tmp/.zshrc")), []);
	});

	test("bash write targets", () => {
		assert.deepEqual(match(rules, bash("echo x >> ~/.zshrc", { paths: ["/Users/me/.zshrc"] })), [
			"rc",
		]);
		assert.deepEqual(match(rules, bash("cat ~/.zshrc")), []);
	});

	test("explicit tools restrict a paths rule", () => {
		const only: GuardRule[] = [{ id: "r", paths: ["x"], tools: ["write"] }];
		assert.deepEqual(match(only, file("write", "/x")), ["r"]);
		assert.deepEqual(match(only, file("edit", "/x")), []);
	});
});

describe("matchRules: combined matchers and disabled rules", () => {
	test("every matcher a rule defines must match", () => {
		const rules: GuardRule[] = [{ id: "r", pattern: "\\bcurl\\b", hosts: { notInAllowed: true } }];
		assert.deepEqual(match(rules, bash("curl https://x.io", { hosts: ["x.io"] })), ["r"]);
		assert.deepEqual(match(rules, bash("echo https://x.io", { hosts: ["x.io"] })), []);
		assert.deepEqual(match(rules, bash("curl https://github.com", { hosts: ["github.com"] })), []);
	});

	test("rules whose effective action is allow never match", () => {
		const policy = buildPolicy(
			{ global: { overrides: { r: "allow" } } },
			{ rules: [{ id: "r", pattern: "x", action: "block" }] },
		);
		assert.deepEqual(matchRules(policy.rules, bash("x"), CTX), []);
	});
});

describe("resolveMatches", () => {
	const policy = buildPolicy(
		{},
		{
			rules: [
				{ id: "j", pattern: "x", action: "judge" },
				{ id: "c1", pattern: "x", action: "confirm" },
				{ id: "c2", pattern: "x", action: "confirm" },
				{ id: "b", pattern: "y", action: "block" },
			],
		},
	);
	const resolve = (cmd: string) => {
		const r = resolveMatches(matchRules(policy.rules, bash(cmd), CTX));
		return r && { action: r.action, primary: r.primary.id, all: r.all.map((m) => m.id) };
	};

	test("none matched", () => assert.equal(resolve("z"), undefined));

	test("most severe action wins, first rule is primary on ties", () => {
		assert.deepEqual(resolve("x"), { action: "confirm", primary: "c1", all: ["j", "c1", "c2"] });
		assert.deepEqual(resolve("xy"), {
			action: "block",
			primary: "b",
			all: ["j", "c1", "c2", "b"],
		});
	});
});
