import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const EXTENSION = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"extensions",
	"command-guard",
);

test("pi's real extension loader loads the directory extension and registers its handlers", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "cg-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "cg-cwd-"));
	const result = await discoverAndLoadExtensions([EXTENSION], cwd, agentDir);

	assert.deepEqual(result.errors, []);
	const ext = result.extensions.find((e) => e.path.includes("command-guard"));
	assert.ok(ext, "extension loaded");
	for (const event of ["tool_call", "message_end", "agent_end", "session_start"]) {
		assert.ok(ext.handlers.has(event), event);
	}
	assert.ok(ext.commands.has("permissions"), "/permissions is registered");
});
