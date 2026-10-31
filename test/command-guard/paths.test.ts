import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	homeAliases,
	isAncestorOfSensitive,
	isSensitivePath,
	pathForms,
	realResolve,
	resolvePathArg,
	SENSITIVE_COMMAND_SOURCE,
} from "../../extensions/command-guard/paths.ts";

const HOME = "/Users/me";

describe("resolvePathArg", () => {
	test("expands tilde and HOME variables", () => {
		assert.equal(resolvePathArg("~/a", "/w", HOME), "/Users/me/a");
		assert.equal(resolvePathArg("~", "/w", HOME), "/Users/me");
		assert.equal(resolvePathArg("$HOME/a", "/w", HOME), "/Users/me/a");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
		assert.equal(resolvePathArg("${HOME}/a", "/w", HOME), "/Users/me/a");
	});

	test("resolves relative paths and .. against cwd", () => {
		assert.equal(resolvePathArg("a/../b", "/w/x", HOME), "/w/x/b");
		assert.equal(resolvePathArg("../.ssh/id", "/Users/me/proj", HOME), "/Users/me/.ssh/id");
	});

	test("strips the @ prefix the pi file tools accept", () => {
		assert.equal(resolvePathArg("@src/a.ts", "/w", HOME), "/w/src/a.ts");
	});

	test("returns undefined for unresolvable shell expansions", () => {
		assert.equal(resolvePathArg("$X/a", "/w", HOME), undefined);
		assert.equal(resolvePathArg("`pwd`/a", "/w", HOME), undefined);
		assert.equal(resolvePathArg("~root/a", "/w", HOME), undefined);
	});
});

describe("pathForms", () => {
	test("includes the ~ form for paths under home", () => {
		assert.deepEqual(pathForms("/Users/me/.ssh/id", HOME), ["/Users/me/.ssh/id", "~/.ssh/id"]);
		assert.deepEqual(pathForms("/etc/hosts", HOME), ["/etc/hosts"]);
	});
});

describe("sensitive paths", () => {
	for (const p of [
		"/Users/me/.ssh/id_rsa",
		"/Users/me/.aws/credentials",
		"/Users/me/.gnupg/pubring.kbx",
		"/Users/me/.pi/agent/auth.json",
		"/Users/me/proj/.env",
		"/Users/me/proj/.env.production",
		"/Users/me/proj/certs/server.pem",
		"/Users/me/.netrc",
		"/Users/me/Library/Keychains/login.keychain-db",
	]) {
		test(`sensitive: ${p}`, () => assert.equal(isSensitivePath(p, HOME), true));
	}

	for (const p of [
		"/Users/me/proj/README.md",
		"/Users/me/proj/.env.example",
		"/Users/me/proj/src/environment.ts",
		"/etc/hosts",
	]) {
		test(`not sensitive: ${p}`, () => assert.equal(isSensitivePath(p, HOME), false));
	}

	test("ancestors of sensitive anchors are flagged for recursive readers", () => {
		assert.equal(isAncestorOfSensitive("/", HOME), true);
		assert.equal(isAncestorOfSensitive("/Users", HOME), true);
		assert.equal(isAncestorOfSensitive("/Users/me", HOME), true);
		assert.equal(isAncestorOfSensitive("/Users/me/.ssh", HOME), true);
		assert.equal(isAncestorOfSensitive("/Users/me/proj", HOME), false);
		assert.equal(isAncestorOfSensitive("/tmp", HOME), false);
	});

	test("command-text regex matches common spellings", () => {
		const re = new RegExp(SENSITIVE_COMMAND_SOURCE, "i");
		for (const cmd of [
			"cat ~/.ssh/id_rsa",
			"cat $HOME/.aws/credentials",
			"tar c /Users/bob/.gnupg",
			"cat .env",
			"cat ./config/.env.local",
			"cat /home/x/.ssh/id_ed25519",
			"security find-generic-password -s foo",
		]) {
			assert.ok(re.test(cmd), cmd);
		}
		for (const cmd of ["cat README.md", "cat .env.example", "ls ~/Documents", "echo dotenv"]) {
			assert.ok(!re.test(cmd), cmd);
		}
	});
});

describe("sensitive .env after the characters that precede a path", () => {
	const re = new RegExp(SENSITIVE_COMMAND_SOURCE, "i");

	test("@ (curl), : (git show), < and > (redirection), comma, and parenthesis", () => {
		for (const text of [
			"curl -d @.env",
			"curl -F f=@.env.local",
			"git show HEAD:.env",
			"cat <.env",
			"echo x >.env",
			"cp a,.env",
			"(.env)",
			"x --file=.env",
		]) {
			assert.ok(re.test(text), text);
		}
	});

	test("documentation variants and look-alikes stay clean", () => {
		for (const text of [
			"curl -d @.env.example",
			"git show HEAD:.env.sample",
			"cat .envrc-notes",
			"cat my.env",
			"echo user@example.environment",
		]) {
			assert.ok(!re.test(text), text);
		}
	});
});

describe("a home directory reached through a symlink", () => {
	function fixture() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cg-home-")));
		mkdirSync(join(root, "real", ".ssh"), { recursive: true });
		symlinkSync(join(root, "real"), join(root, "link"));
		return { real: join(root, "real"), link: join(root, "link") };
	}

	test("homeAliases lists both spellings, and one for an ordinary home", () => {
		const { real, link } = fixture();
		assert.deepEqual(homeAliases(link), [link, real]);
		assert.deepEqual(homeAliases(real), [real]);
	});

	test("pathForms gives the ~/ form for paths under either spelling", () => {
		const { real, link } = fixture();
		assert.ok(pathForms(join(real, ".ssh", "id_rsa"), link).includes("~/.ssh/id_rsa"));
		assert.ok(pathForms(join(link, ".ssh", "id_rsa"), link).includes("~/.ssh/id_rsa"));
		assert.ok(pathForms(real, link).includes("~"));
	});

	test("sensitivity and ancestry follow", () => {
		const { real, link } = fixture();
		assert.equal(isSensitivePath(join(real, ".ssh", "id_rsa"), link), true);
		assert.equal(isAncestorOfSensitive(real, link), true);
		assert.equal(isAncestorOfSensitive(join(real, "src"), link), false);
	});
});

describe("realResolve", () => {
	test("follows symlinks for existing and not-yet-existing files", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cg-")));
		mkdirSync(join(root, "target"));
		symlinkSync(join(root, "target"), join(root, "link"));
		assert.equal(realResolve(join(root, "link", "new.txt")), join(root, "target", "new.txt"));
		assert.equal(
			realResolve(join(root, "missing", "deep", "x")),
			join(root, "missing", "deep", "x"),
		);
	});
});
