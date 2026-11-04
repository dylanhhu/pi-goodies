import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDeniedFlag } from "../../extensions/command-guard/allowlist.ts";
import { isReadOnlySedScript, readOnlySedFiles } from "../../extensions/command-guard/sed.ts";

describe("sed scripts: read-only forms", () => {
	for (const script of [
		"30,140p",
		"1p",
		"$p",
		"/foo/p",
		"/foo;bar/p",
		"/^\\/tmp\\//p",
		"1,5d",
		"1~2p",
		"0,/re/p",
		"/re/!p",
		"s/a/b/",
		"s/a/b/g",
		"s/;/X/g",
		"s|a|b|g",
		"s/a/b/2",
		"s/a/b/gp",
		"y/abc/def/",
		"{p;d}",
		"1{p;d}",
		"b end",
		"b",
		":label",
		"h;g;x",
		"n;N;P;D",
		"=",
		"l",
		"q",
		"p\np",
		"s/a/b/ ",
	]) {
		test(JSON.stringify(script), () => assert.equal(isReadOnlySedScript(script), true));
	}
});

describe("sed scripts: anything that writes, reads, or executes", () => {
	for (const script of [
		"w /tmp/x",
		"1w/tmp/x",
		"W /tmp/x",
		"r /etc/passwd",
		"1r/etc/passwd",
		"R /etc/passwd",
		"e id",
		"1e id",
		"s/a/b/w out",
		"s/a/b/e",
		"s/a/b/gw out",
		"a\\appended",
		"i\\inserted",
		"c\\changed",
		"f",
		"v 4.0",
		"z",
	]) {
		test(JSON.stringify(script), () => assert.equal(isReadOnlySedScript(script), false));
	}
});

describe("sed scripts: malformed scripts are not trusted", () => {
	for (const script of ["", "/unterminated", "s/a/b", "s|a|b", "1,", "y/abc/def"]) {
		test(JSON.stringify(script), () => assert.equal(isReadOnlySedScript(script), false));
	}
});

const DENY = ["-i", "--in-place", "-f", "--file"];
const files = (args: string[]) => readOnlySedFiles(args, DENY, isDeniedFlag);

describe("sed arguments: scripts and input files", () => {
	test("script then file", () => {
		assert.deepEqual(files(["30,140p", "README.md"]), ["README.md"]);
	});

	test("-n before the script", () => {
		assert.deepEqual(files(["-n", "30,140p", "f"]), ["f"]);
	});

	test("several -e scripts", () => {
		assert.deepEqual(files(["-n", "-e", "1p", "-e", "2p", "f"]), ["f"]);
	});

	test("bundled -ne takes the next argument as the script", () => {
		assert.deepEqual(files(["-ne", "1p", "f"]), ["f"]);
	});

	test("--expression=value", () => {
		assert.deepEqual(files(["--expression=1p", "f"]), ["f"]);
	});

	test("a script with no file reads stdin", () => {
		assert.deepEqual(files(["-n", "1p"]), []);
	});

	for (const args of [
		["-i", "s/a/b/", "f"],
		["-i.bak", "s/a/b/", "f"],
		["-f", "script.sed", "f"],
		["--file=script.sed", "f"],
		["--in-place", "s/a/b/", "f"],
		["s/a/b/w out", "f"],
	]) {
		test(`rejected: ${args.join(" ")}`, () => {
			assert.equal(files(args), undefined);
		});
	}

	test("rejected: no script at all", () => {
		assert.equal(files(["-n", "f"]), undefined);
	});
});
