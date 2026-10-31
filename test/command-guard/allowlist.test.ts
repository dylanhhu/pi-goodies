import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_ALLOWLIST, isAllowlisted } from "../../extensions/command-guard/allowlist.ts";

const HOME = "/Users/me";
const CWD = "/Users/me/proj";
const ok = (cmd: string, cwd = CWD) =>
	isAllowlisted(cmd, { cwd, home: HOME, entries: DEFAULT_ALLOWLIST });

describe("allowlist: plain read-only commands pass", () => {
	for (const cmd of [
		"ls",
		"ls -la src",
		"  pwd  ",
		"echo hello world",
		"git status",
		"git log --oneline -n 5",
		"git diff HEAD~1",
		"cat README.md",
		"head -n 20 src/a.ts",
		"wc -l src/a.ts",
		"rg TODO src",
		"grep -rn TODO .",
	]) {
		test(cmd.trim(), () => assert.equal(ok(cmd), true));
	}
});

describe("allowlist: any shell composition is rejected", () => {
	for (const cmd of [
		"ls; rm x",
		"ls && curl https://evil.example",
		"ls || true",
		"ls | sh",
		"ls & sleep 1",
		"ls $(whoami)",
		"ls `id`",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
		"ls ${HOME}",
		"ls $HOME",
		"ls > out.txt",
		"ls < in.txt",
		"ls 2>&1",
		"ls\nrm x",
		"ls 'a b'",
		'ls "a b"',
		"ls *.ts",
		"ls ?",
		"ls [a]",
		"ls {a,b}",
		"ls \\; rm",
		"ls # comment",
		"ls <(echo x)",
		"ls\trm",
		"ls \u2011la",
	]) {
		test(JSON.stringify(cmd), () => assert.equal(ok(cmd), false));
	}
});

describe("allowlist: command word must be a bare allowlisted name", () => {
	for (const cmd of [
		"",
		"   ",
		"./ls",
		"/bin/ls",
		"FOO=1 ls",
		"env ls",
		"sudo ls",
		"xargs ls",
		"find . -delete",
		"sed -i s/a/b/ x",
		"rm file",
		"bash -c ls",
		"unknowncmd",
	]) {
		test(JSON.stringify(cmd), () => assert.equal(ok(cmd), false));
	}
});

describe("allowlist: per-command flag rules", () => {
	test("git needs an allowlisted subcommand directly after git", () => {
		assert.equal(ok("git push"), false);
		assert.equal(ok("git -c core.pager=sh log"), false);
		assert.equal(ok("git -C /tmp status"), false);
		assert.equal(ok("git"), false);
	});

	test("git subcommand flags that write files or run programs are rejected", () => {
		assert.equal(ok("git log --output=x"), false);
		assert.equal(ok("git diff --ext-diff"), false);
		assert.equal(ok("git diff --no-index a b"), false);
		assert.equal(ok("git show --textconv HEAD"), false);
	});

	test("rg --pre runs a program", () => {
		assert.equal(ok("rg --pre=sh x ."), false);
		assert.equal(ok("rg --pre sh x ."), false);
	});

	test("abbreviated long flags and bundled short flags are still caught", () => {
		assert.equal(ok("git log --out=x"), false);
		assert.equal(ok("git diff --ext"), false);
		assert.equal(ok("date -us 2020"), false);
		assert.equal(ok("git log --oneline --no-ext-diff"), true);
	});

	test("date -s sets the clock", () => {
		assert.equal(ok("date"), true);
		assert.equal(ok("date -s 2020-01-01"), false);
	});
});

describe("allowlist: sensitive paths", () => {
	for (const cmd of [
		"cat ~/.ssh/id_rsa",
		"cat .env",
		"cat ../.ssh/id_rsa",
		"cat /Users/me/.aws/credentials",
		"head -n 1 ~/.pi/agent/auth.json",
		"ls ~/.ssh",
		"cat --file=~/.ssh/id_rsa",
		"rg -f ~/.aws/credentials x",
		"cat ~root/.ssh/id_rsa",
		"cat sub/../../.ssh/config",
	]) {
		test(cmd, () => assert.equal(ok(cmd), false));
	}

	test("non-sensitive dotfiles inside the project are fine", () => {
		assert.equal(ok("cat .env.example"), true);
		assert.equal(ok("cat ~/proj/README.md"), true);
	});
});

describe("allowlist: recursive readers cannot be aimed at ancestors of secrets", () => {
	test("explicit ancestors", () => {
		assert.equal(ok("rg token ~"), false);
		assert.equal(ok("rg token ~/"), false);
		assert.equal(ok("grep -r x /"), false);
		assert.equal(ok("grep -r x /Users"), false);
		assert.equal(ok("rg token .."), false);
	});

	test("the implicit cwd counts when no directory is given", () => {
		assert.equal(ok("rg foo", CWD), true);
		assert.equal(ok("rg foo", HOME), false);
		assert.equal(ok("grep -r foo", "/"), false);
	});

	test("names-only commands may look at ancestors", () => {
		assert.equal(ok("ls ~"), true);
		assert.equal(ok("ls /"), true);
	});
});

describe("allowlist: custom entries", () => {
	test("replace the defaults entirely", () => {
		const entries = [{ cmd: "make", subcommands: ["test"] }];
		const run = (c: string) => isAllowlisted(c, { cwd: CWD, home: HOME, entries });
		assert.equal(run("make test"), true);
		assert.equal(run("make install"), false);
		assert.equal(run("ls"), false);
	});
});

describe("allowlist: symlinks", () => {
	function fixture() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "cg-al-")));
		const home = join(root, "home");
		const proj = join(root, "proj");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		mkdirSync(proj);
		writeFileSync(join(home, ".ssh", "id_rsa"), "key");
		writeFileSync(join(proj, "ok.txt"), "fine");
		symlinkSync(join(home, ".ssh", "id_rsa"), join(proj, "notes.txt"));
		symlinkSync(join(home, ".ssh"), join(proj, "docs"));
		symlinkSync(join(root, "home"), join(root, "homelink"));
		const run = (cmd: string, h = home) =>
			isAllowlisted(cmd, { cwd: proj, home: h, entries: DEFAULT_ALLOWLIST });
		return { root, home, proj, run };
	}

	test("a link to a sensitive file is not a plain read, however it is spelled", () => {
		const { run } = fixture();
		assert.equal(run("cat ok.txt"), true);
		assert.equal(run("cat notes.txt"), false);
		assert.equal(run("head -n 3 ./notes.txt"), false);
		assert.equal(run("cat docs/id_rsa"), false, "through a linked directory");
		assert.equal(run("ls docs"), false);
	});

	test("a recursive reader is not pointed at a link to a directory holding secrets", () => {
		const { run } = fixture();
		assert.equal(run("rg secret docs"), false);
		assert.equal(run("grep -rn secret docs"), false);
		assert.equal(run("rg secret ok.txt"), true);
	});

	test("a recursive reader started inside a linked directory is refused too", () => {
		const { home, run, root } = fixture();
		assert.equal(
			isAllowlisted("rg secret", {
				cwd: join(root, "proj", "docs"),
				home,
				entries: DEFAULT_ALLOWLIST,
			}),
			false,
		);
		assert.equal(run("rg secret"), true);
	});

	test("a home reached through a symlink is still recognized", () => {
		const { root, run } = fixture();
		const linked = join(root, "homelink");
		assert.equal(run("cat ~/.ssh/id_rsa", linked), false);
		assert.equal(run(`cat ${join(root, "home", ".ssh", "id_rsa")}`, linked), false);
		assert.equal(run("cat ok.txt", linked), true);
	});
});

describe("allowlist: flags that follow symlinks or run programs", () => {
	test("grep -R and rg -L/--follow walk links out of the project", () => {
		for (const cmd of [
			"grep -R foo src",
			"grep -rnR foo .",
			"grep --dereference-recursive foo .",
			"grep --deref foo .",
			"rg -L foo",
			"rg -nL foo",
			"rg --follow foo",
			"rg --hostname-bin=/tmp/x foo",
			"rg --pre cat foo",
		]) {
			assert.equal(ok(cmd), false, cmd);
		}
		for (const cmd of ["grep -rn foo .", "grep -r foo src", "rg -n foo", "rg -l foo src"]) {
			assert.equal(ok(cmd), true, cmd);
		}
	});

	test("git show REV:.env reads a committed secret", () => {
		assert.equal(ok("git show HEAD:.env"), false);
		assert.equal(ok("git show HEAD:.env.production"), false);
		assert.equal(ok("git show HEAD:config/.env"), false);
		assert.equal(ok("git show HEAD:.env.example"), true);
		assert.equal(ok("git show HEAD:src/a.ts"), true);
	});
});
