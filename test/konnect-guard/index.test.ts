import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import konnectGuard, {
	GUARDRAIL_SECTION,
	GUARDRAILS,
	hasKonnectTools,
	KONNECT_TOOL_PREFIX,
} from "../../extensions/konnect-guard/index.ts";

type BeforeAgentStartHandler = (event: {
	systemPromptOptions: { sections: Record<string, string> };
}) => void;

/** Run the extension's before_agent_start handler against a fake pi. */
function startRun(toolNames: string[], sections: Record<string, string> = {}) {
	let handler: BeforeAgentStartHandler | undefined;
	const pi = {
		on: (name: string, fn: BeforeAgentStartHandler) => {
			if (name === "before_agent_start") handler = fn;
		},
		getAllTools: () => toolNames.map((name) => ({ name })),
	};
	konnectGuard(pi as unknown as ExtensionAPI);
	assert.ok(handler, "extension registers a before_agent_start handler");
	handler({ systemPromptOptions: { sections } });
	return sections;
}

describe("konnect-guard: session gating", () => {
	test("detects Konnect MCP tools", () => {
		assert.equal(hasKonnectTools([`${KONNECT_TOOL_PREFIX}load_toolset`]), true);
		assert.equal(hasKonnectTools(["read", "bash", `${KONNECT_TOOL_PREFIX}run_erc`]), true);
	});

	test("ignores sessions without Konnect tools", () => {
		assert.equal(hasKonnectTools([]), false);
		assert.equal(hasKonnectTools(["read", "bash", "mcp__notion__notion-fetch"]), false);
	});

	test("does not match a prefix without the separator", () => {
		assert.equal(hasKonnectTools(["mcp__konnect"]), false);
		assert.equal(hasKonnectTools(["mcp__konnect-other__tool"]), false);
	});
});

describe("konnect-guard: prompt section", () => {
	test("adds the guardrails when Konnect tools are registered", () => {
		const sections = startRun(["read", `${KONNECT_TOOL_PREFIX}load_toolset`]);
		assert.equal(sections[GUARDRAIL_SECTION], GUARDRAILS);
	});

	test("leaves sessions without Konnect tools untouched", () => {
		const sections = startRun(["read", "bash"]);
		assert.deepEqual(sections, {});
	});

	test("keeps existing sections and an existing guardrail override", () => {
		const sections = startRun([`${KONNECT_TOOL_PREFIX}run_erc`], {
			konnect_guardrails: "local override",
			other: "kept",
		});
		assert.equal(sections[GUARDRAIL_SECTION], "local override");
		assert.equal(sections.other, "kept");
	});
});

describe("konnect-guard: guardrail text", () => {
	test("names each board-state regime", () => {
		for (const expected of ["Live-IPC", "closed-board fallback", "board closed", "dry run"]) {
			assert.match(GUARDRAILS, new RegExp(expected));
		}
	});

	test("forbids bypassing server guards", () => {
		assert.match(GUARDRAILS, /never bypass/i);
		assert.match(GUARDRAILS, /never force a file edit/i);
	});
});
