import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import retry from "../../extensions/retry.ts";
import { Tree } from "./tree.ts";

type Sent =
	| { kind: "user"; content: unknown }
	| {
			kind: "custom";
			customType: string;
			content: unknown;
			display: unknown;
			triggerTurn: unknown;
	  };

type AgentMessage = ContextEvent["messages"][number];

type ContextHandler = (event: ContextEvent) => { messages?: AgentMessage[] } | undefined;

interface Harness {
	sent: Sent[];
	navigated: string[];
	notices: string[];
	editor: string;
	context: ContextHandler;
	run: (args?: string, command?: string) => Promise<void>;
}

/** Wire the extension to a stub pi and a stub command context. */
function harness(tree: Tree): Harness {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const sent: Sent[] = [];
	const navigated: string[] = [];
	const notices: string[] = [];
	let context: ContextHandler = () => undefined;
	const state = { editor: "unsent draft" };

	const pi = {
		on(event: string, handler: ContextHandler) {
			if (event === "context") context = handler;
			return () => {};
		},
		registerCommand(name: string, options: { handler: never }) {
			commands.set(name, options.handler as never);
		},
		sendUserMessage(content: unknown) {
			sent.push({ kind: "user", content });
		},
		sendMessage(
			message: { customType: string; content: unknown; display: unknown },
			options: { triggerTurn?: boolean } = {},
		) {
			sent.push({
				kind: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				triggerTurn: options.triggerTurn,
			});
		},
	} as unknown as ExtensionAPI;

	retry(pi);

	const ctx = {
		isIdle: () => true,
		abort: () => {},
		waitForIdle: async () => {},
		navigateTree: async (id: string) => {
			navigated.push(id);
			return { cancelled: false };
		},
		ui: {
			notify: (message: string) => notices.push(message),
			getEditorText: () => state.editor,
			setEditorText: (text: string) => {
				state.editor = text;
			},
		},
		sessionManager: {
			buildSessionProjection: () => ({ entries: tree.projection(), messages: [] }),
			getEntry: (id: string) => tree.getEntry(id),
		},
	} as unknown as ExtensionCommandContext;

	return {
		sent,
		navigated,
		notices,
		get editor() {
			return state.editor;
		},
		get context() {
			return context;
		},
		run: async (args = "last", command = "retry") => {
			const handler = commands.get(command);
			assert.ok(handler, `command ${command} is registered`);
			await handler(args, ctx);
		},
	};
}

describe("/retry last", () => {
	test("starts a run from the branch point without injecting a message", async () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		tree.assistantText(result.id);

		const h = harness(tree);
		await h.run();

		assert.deepEqual(h.navigated, [result.id]);
		assert.equal(h.sent.length, 1);
		const sent = h.sent[0];
		assert.equal(sent.kind, "custom");
		if (sent.kind !== "custom") return;
		assert.equal(sent.customType, "retry-trigger");
		assert.equal(sent.triggerTurn, true);
		// Hidden from the transcript and empty, so nothing reads as an instruction
		assert.equal(sent.display, false);
		assert.equal(sent.content, "");
		assert.equal(h.editor, "unsent draft");
	});

	test("replays the prompt when the branch point is a prompt", async () => {
		const tree = new Tree();
		const user = tree.user(null, "fix the bug");
		tree.assistantText(user.id);

		const h = harness(tree);
		await h.run();

		assert.deepEqual(h.navigated, [user.id]);
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.sent[0], {
			kind: "user",
			content: [{ type: "text", text: "fix the bug" }],
		});
		assert.equal(h.editor, "unsent draft");
	});

	test("says why it cannot retry instead of sending anything", async () => {
		const tree = new Tree();
		tree.state(null);

		const h = harness(tree);
		await h.run();

		assert.deepEqual(h.sent, []);
		assert.deepEqual(h.navigated, []);
		assert.match(h.notices[0] ?? "", /no message to retry/i);
	});
});

describe("/continue", () => {
	test("resumes an interrupted run without moving the branch", async () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		tree.toolResult(call.id);

		const h = harness(tree);
		await h.run("", "continue");

		assert.deepEqual(h.navigated, []);
		assert.equal(h.sent.length, 1);
		const sent = h.sent[0];
		assert.equal(sent.kind, "custom");
		if (sent.kind !== "custom") return;
		assert.equal(sent.customType, "retry-trigger");
		assert.equal(sent.triggerTurn, true);
	});

	test("climbs out of a cut-off answer instead of replaying the prompt", async () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id, "half an ans", "aborted");

		const h = harness(tree);
		await h.run("", "continue");

		assert.deepEqual(h.navigated, []);
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]?.kind, "custom");
	});

	test("does nothing when the last turn finished", async () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id);

		const h = harness(tree);
		await h.run("", "continue");

		assert.deepEqual(h.navigated, []);
		assert.deepEqual(h.sent, []);
		assert.match(h.notices[0] ?? "", /nothing to continue/i);
		assert.equal(h.editor, "unsent draft");
	});

	test("falls back to the /retry last plan for a tool call with no result", async () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantCall(user.id);

		const h = harness(tree);
		await h.run("", "continue");

		assert.deepEqual(h.navigated, [user.id]);
		assert.equal(h.sent[0]?.kind, "user");
	});
});

describe("context handler", () => {
	test("strips every retry trigger and leaves other messages alone", () => {
		const h = harness(new Tree());
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: 0,
		};
		const trigger: AgentMessage = {
			role: "custom",
			customType: "retry-trigger",
			content: "",
			display: false,
			timestamp: 0,
		};
		const other: AgentMessage = {
			role: "custom",
			customType: "checkin",
			content: "ping",
			display: true,
			timestamp: 0,
		};

		const result = h.context({ type: "context", messages: [user, trigger, other] });
		assert.deepEqual(result?.messages, [user, other]);
	});

	test("reports no change when there is no trigger", () => {
		const h = harness(new Tree());
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: 0,
		};
		assert.equal(h.context({ type: "context", messages: [user] }), undefined);
	});
});
