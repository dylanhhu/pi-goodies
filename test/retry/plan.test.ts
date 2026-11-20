import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	planContinue,
	planRetryLast,
	planRetryTurn,
	projectSteps,
	type RetryPlan,
} from "../../extensions/retry.ts";
import { Tree } from "./tree.ts";

/** The branch leaf: restart plans keep it in place when `navigateTo` is null. */
const LEAF = "leaf";

function last(tree: Tree): RetryPlan {
	return planRetryLast(projectSteps(tree.projection()), tree);
}

function resume(tree: Tree): RetryPlan {
	return planContinue(projectSteps(tree.projection()), tree);
}

function turn(tree: Tree): RetryPlan {
	return planRetryTurn(projectSteps(tree.projection()));
}

/** The entry whose prompt the plan re-sends, or where it branches. */
function target(plan: RetryPlan): string {
	switch (plan.kind) {
		case "replay":
			return plan.prompt.id;
		case "restart":
			return plan.navigateTo?.id ?? LEAF;
		default:
			return `${plan.kind}: ${plan.message}`;
	}
}

function navigateTo(plan: RetryPlan): string {
	switch (plan.kind) {
		case "replay":
		case "restart":
			return plan.navigateTo?.id ?? LEAF;
		default:
			return plan.message;
	}
}

/** The steps the model would read if the branch ended at `entry`. */
function stepsAt(tree: Tree, entry: { id: string }) {
	const index = tree.entries.findIndex((candidate) => candidate.id === entry.id);
	return projectSteps(tree.projection().slice(0, index + 1));
}

describe("planRetryLast", () => {
	test("replays the prompt a discarded tool call belonged to", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		tree.toolResult(call.id);

		const plan = last(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), user.id);
	});

	test("continues from the tool result instead of injecting a retry prompt", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		tree.assistantText(result.id);

		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), result.id);
	});

	test("continues from the previous result after an interrupted tool call", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		tree.assistantCall(result.id, "c2");

		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), result.id);
	});

	test("drops the step an assistant leaf represents, not the message above it", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		const interleaved = tree.assistantCall(result.id, "c2");
		tree.toolResult(interleaved.id, "c2");

		// Leaf sits on the interleaved assistant message, as `/tree` leaves it
		const plan = planRetryLast(projectSteps(tree.projection()), tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), result.id);
	});

	test("keeps trailing state entries when branching", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		const state = tree.state(result.id);
		tree.assistantText(state.id);

		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		// State entry, not the tool result, so the state survives the branch
		assert.equal(navigateTo(plan), state.id);
	});

	test("replays the user prompt behind a plain answer", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id);

		const plan = last(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), user.id);
		assert.equal(navigateTo(plan), user.id);
	});

	test("ignores attempts pi already omitted from context", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		const failed = tree.assistantText(result.id, "529 overloaded");
		const answer = tree.assistantText(failed.id);
		tree.omit(failed);

		// Without the omission the branch point would look like an assistant
		// message and the plan would replay the prompt instead.
		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		assert.ok(plan.kind === "restart" && plan.navigateTo);
		assert.equal(stepsAt(tree, plan.navigateTo).at(-1)?.entry.id, result.id);
		assert.notEqual(navigateTo(plan), answer.id);
	});

	test("falls back to the prompt when a run cannot start above the branch point", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const answer = tree.assistantText(user.id);
		tree.assistantCall(answer.id);

		const plan = last(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), user.id);
	});

	test("skips state entries when picking the newest step", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		tree.assistantText(result.id);
		tree.state(result.id);
		tree.state(result.id);

		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), result.id);
	});

	test("continues from a compaction summary", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const compacted = tree.compaction(user.id);
		tree.assistantText(compacted.id);
		tree.state(compacted.id);

		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), compacted.id);
	});

	test("replays a custom message that follows a tool result", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		const custom = tree.customMessage(result.id);
		tree.assistantText(custom.id);

		const plan = last(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), custom.id);
	});

	test("replays a root prompt but refuses a root reply", () => {
		const tree = new Tree();
		tree.assistantCall(null);
		assert.equal(last(tree).kind, "error");

		const other = new Tree();
		const user = other.user(null);
		const plan = last(other);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), user.id);
	});

	test("reports an empty context", () => {
		const tree = new Tree();
		tree.state(null);
		assert.equal(last(tree).kind, "error");
	});

	test("keeps a branch summary as a continue point", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const summary = tree.branchSummary(user.id);
		tree.assistantText(summary.id);

		const plan = last(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), summary.id);
	});
});

describe("projectSteps", () => {
	test("records side, tool calls, and replayability per step", () => {
		const tree = new Tree();
		tree.user(null);
		const call = tree.assistantCall(tree.entries[0].id);
		tree.toolResult(call.id);
		const state = tree.state(call.id);
		tree.customMessage(state.id);

		const steps = projectSteps(tree.projection());
		assert.deepEqual(
			steps.map((step) => [step.side, step.toolCalls, step.replayable]),
			[
				["user", false, true],
				["assistant", true, false],
				["toolResult", false, false],
				["user", false, true],
			],
		);
	});

	test("drops omitted and state-only entries", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const answer = tree.assistantText(user.id);
		tree.state(answer.id);
		tree.omit(answer);

		const steps = projectSteps(tree.projection());
		assert.equal(steps.length, 1);
		assert.equal(steps[0].entry.id, user.id);
	});
});

describe("planRetryTurn", () => {
	test("re-sends the newest user prompt", () => {
		const tree = new Tree();
		const user = tree.user(null, "fix the build");
		tree.assistantCall(user.id);

		const plan = turn(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), user.id);
		assert.equal(navigateTo(plan), user.id);
	});

	test("branches before an interrupted tool call that precedes the prompt", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		const result = tree.toolResult(call.id);
		const dangling = tree.assistantCall(result.id, "c2");
		const prompt = tree.user(dangling.id, "now try again");

		const plan = turn(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), prompt.id);
		// The dangling call and the prompt are both dropped by branching at the result
		assert.equal(navigateTo(plan), result.id);
	});

	test("reports when no user prompt exists", () => {
		const tree = new Tree();
		tree.customMessage(null);
		assert.match(turn(tree) && target(turn(tree)), /no user message/i);
	});
});

describe("planContinue", () => {
	test("does nothing when the last turn finished", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id);

		const plan = resume(tree);
		assert.equal(plan.kind, "none");
	});

	test("resumes a run interrupted during a tool call", () => {
		const tree = new Tree();
		const user = tree.user(null);
		const call = tree.assistantCall(user.id);
		tree.toolResult(call.id);

		const plan = resume(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), LEAF);
		assert.equal(stepsAt(tree, user).length, 1);
	});

	test("resumes from a cut-off answer instead of replaying the prompt", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id, "half an ans", "aborted");

		const plan = resume(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), LEAF);
	});

	test("continues a truncated answer", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id, "cut off", "length");

		assert.equal(resume(tree).kind, "restart");
	});

	test("continues a failed answer", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id, "", "error");

		assert.equal(resume(tree).kind, "restart");
	});

	test("answers a prompt that never ran", () => {
		const tree = new Tree();
		tree.user(null, "hello?");

		const plan = resume(tree);
		assert.equal(plan.kind, "restart");
		assert.equal(navigateTo(plan), LEAF);
	});

	test("re-issues an interrupted tool call with no result", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantCall(user.id);

		// Same plan as /retry last: the call cannot be resumed, it has to be re-issued
		const plan = resume(tree);
		assert.equal(plan.kind, "replay");
		assert.equal(target(plan), user.id);
	});

	test("does nothing after a shell record or summary", () => {
		const tree = new Tree();
		const user = tree.user(null);
		tree.assistantText(user.id);
		tree.compaction(tree.entries[1].id);

		assert.equal(resume(tree).kind, "none");
	});

	test("reports an empty session", () => {
		const tree = new Tree();
		assert.equal(resume(tree).kind, "none");
	});
});
