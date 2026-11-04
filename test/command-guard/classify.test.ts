import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ALLOWLIST } from "../../extensions/command-guard/allowlist.ts";
import { classifyCommand } from "../../extensions/command-guard/classify.ts";

const HOME = "/Users/me";
const CWD = "/Users/me/proj";
const classify = (command: string, opts: { cwd?: string; hosts?: string[] } = {}) =>
	classifyCommand(command, {
		cwd: opts.cwd ?? CWD,
		home: HOME,
		entries: DEFAULT_ALLOWLIST,
		hosts: opts.hosts,
	}).kind;

describe("readonly: plain reads and compositions of them", () => {
	for (const cmd of [
		"ls -la",
		"pwd",
		"cat README.md",
		"rg -n TODO src",
		"grep -rn TODO .",
		"ls | head -20",
		"ls | sort | head",
		"rg -n TODO . 2>/dev/null",
		"cat README.md >/dev/null",
		"cd /opt/vendor && rg -n 'tool_call' -A 30 docs/extensions.md | sed -n '30,140p'",
		"cd sub && cat ../README.md",
		"git status && git diff",
		"find . -name '*.ts' | head",
		"sed -n '30,140p' README.md",
		"sed -n 's/a/b/g' README.md | head",
		"cat /opt/homebrew/lib/node_modules/x/docs/a.md | tail -60",
		"wc -l src/a.ts",
		"echo hello",
	]) {
		test(cmd, () => assert.equal(classify(cmd), "readonly", cmd));
	}
});

describe("readonly: expansions and anything the shell could reinterpret", () => {
	for (const cmd of [
		"ls $(whoami)",
		"ls `id`",
		"ls $" + "{HOME}",
		"ls *.ts",
		"ls f?.txt",
		"ls {a,b}",
		"ls (x)",
		"cat a\\ b",
		'cat "a$(id)"',
		"cat 'unterminated",
		'cat "unterminated',
		"ls &",
		"ls &> /tmp/x",
		"cat f |& head",
	]) {
		test(cmd, () => assert.notEqual(classify(cmd), "readonly", cmd));
	}
});

describe("readonly: writes, deleted files, and redirections", () => {
	for (const cmd of [
		"cat f > out.txt",
		"cat f >> out.txt",
		"tee out.txt",
		"rm -rf build",
		"mv a b",
		"mkdir -p new",
		"find . -delete",
		"find . -name x -exec rm {} \\;",
		"git commit -m msg",
		"git push",
		"npm test",
		"pnpm install",
		"cargo build",
		"make",
		"cat > /tmp/x <<'EOF'\nhello\nEOF",
	]) {
		test(cmd, () => assert.equal(classify(cmd), "mutate", cmd));
	}
});

describe("readonly: reads that are too broad to certify", () => {
	for (const cmd of [
		"rg -L foo",
		"rg --pre cat foo",
		"grep -R foo",
		"rg foo ~",
		"grep -rn foo ~",
		"cat ~/.ssh/id_rsa",
		"cat .env",
		"sed -n 1p ~/.ssh/id_rsa",
		"sed 1w/tmp/x README.md",
		"sed -i s/a/b/ README.md",
		"cd - && ls",
		"cd a b",
	]) {
		test(cmd, () => assert.notEqual(classify(cmd), "readonly", cmd));
	}
});

describe("readonly: egress and privilege outrank the rest", () => {
	for (const cmd of ["curl https://example.com", "wget https://example.com/x"]) {
		test(cmd, () => assert.equal(classify(cmd, { hosts: ["example.com"] }), "egress", cmd));
	}
	for (const cmd of ["sudo ls", "doas cat f", "sudo -u root ls"]) {
		test(cmd, () => assert.equal(classify(cmd), "privileged", cmd));
	}
});

describe("readonly: visible payloads that no target names", () => {
	for (const cmd of [
		"node -e 'console.log(1)'",
		"python3 -c 'print(1)'",
		"npx tsx harness.mts",
		"kicad-cli pcb export --help",
		"deepseek --frobnicate",
		"xargs rm",
	]) {
		test(cmd, () => assert.equal(classify(cmd), "inspect", cmd));
	}
});
