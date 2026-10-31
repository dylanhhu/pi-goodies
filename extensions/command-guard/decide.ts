/**
 * The decision pipeline: Layer 1 rules, the allowlist fast path, then the
 * decision model. Pure with respect to the UI; callers turn a "confirm"
 * outcome into a dialog.
 *
 * Size limit: an action over `limits.maxActionChars` is never handed to the
 * decision model (which would have to clip it, and clipped text can hide the
 * dangerous part). A bash command that large is also never waved through as
 * "unmatched". Both go to the human, or are blocked, per `limits.onOversize`.
 */

import { isAllowlisted } from "./allowlist.ts";
import type { CompiledRule, Policy } from "./config.ts";
import type { JudgeHint, JudgeInput, JudgeVerdict } from "./judge.ts";
import { matchRules, resolveMatches } from "./match.ts";
import type { Action, Descriptor } from "./types.ts";

export interface DecideDeps {
	home: string;
	/** The user's messages for the current run */
	userMessages: () => string[];
	/** The run was started by another model, so its user messages are not the user's words */
	delegated?: boolean;
	/** Cancels a pending decision model call */
	signal?: AbortSignal;
	/** Undefined when no decision model is configured */
	judge?: (input: JudgeInput) => Promise<JudgeVerdict>;
}

export interface Decision {
	outcome: "allow" | "confirm" | "block";
	source: "rule" | "allowlist" | "unmatched" | "judge" | "oversize";
	/** The rule that decided (or, for judged calls, the first rule that flagged it) */
	rule?: CompiledRule;
	matched: CompiledRule[];
	verdict?: JudgeVerdict;
	/** Why, when the outcome is not self-explanatory */
	reason?: string;
}

/** The size the limit applies to: the command for bash, the written text for write and edit. */
function actionChars(d: Descriptor): number {
	return (d.tool === "bash" ? d.command : d.content)?.length ?? 0;
}

function oversize(d: Descriptor, matched: CompiledRule[], policy: Policy): Decision {
	const { maxActionChars, onOversize } = policy.limits;
	return {
		outcome: onOversize,
		source: "oversize",
		rule: matched[0],
		matched,
		reason: `action too large for automatic review: ${actionChars(d).toLocaleString("en-US")} characters, limit ${maxActionChars.toLocaleString("en-US")}`,
	};
}

async function consultJudge(
	d: Descriptor,
	matched: CompiledRule[],
	deps: DecideDeps,
): Promise<Decision> {
	const rule = matched[0];
	if (!deps.judge) {
		// A rule asked for the decision model but none is configured: ask the human instead
		return {
			outcome: "confirm",
			source: "rule",
			rule,
			matched,
			reason: "the decision model is not configured",
		};
	}
	const hints: JudgeHint[] = matched.map((m) => ({
		id: m.id,
		label: m.rule.label ?? m.rule.pattern ?? m.id,
		category: m.rule.category,
	}));
	const verdict = await deps.judge({
		descriptor: d,
		hints,
		userMessages: deps.userMessages(),
		delegated: deps.delegated,
		signal: deps.signal,
	});
	return { outcome: verdict.outcome, source: "judge", rule, matched, verdict };
}

export async function decide(d: Descriptor, policy: Policy, deps: DecideDeps): Promise<Decision> {
	const matched = matchRules(policy.rules, d, {
		allowedHosts: policy.allowedHosts,
		home: deps.home,
	});
	const resolution = resolveMatches(matched);
	const tooLarge = actionChars(d) > policy.limits.maxActionChars;

	if (resolution) {
		if (resolution.action === "judge") {
			return tooLarge ? oversize(d, matched, policy) : consultJudge(d, matched, deps);
		}
		// A rule that only asks the human yields to a policy of blocking oversized actions
		if (tooLarge && resolution.action === "confirm" && policy.limits.onOversize === "block") {
			return oversize(d, matched, policy);
		}
		return {
			outcome: resolution.action as "confirm" | "block",
			source: "rule",
			rule: resolution.primary,
			matched,
		};
	}

	// Nothing matched, but nobody can vouch for a command this long
	if (tooLarge && d.tool === "bash") return oversize(d, matched, policy);

	if (
		d.tool === "bash" &&
		policy.allowlist.enabled &&
		isAllowlisted(d.command ?? "", {
			cwd: d.cwd,
			home: deps.home,
			entries: policy.allowlist.entries,
		})
	) {
		return { outcome: "allow", source: "allowlist", matched };
	}

	const action: Action = policy.unmatched[d.tool];
	switch (action) {
		case "block":
		case "confirm":
			return { outcome: action, source: "unmatched", matched };
		case "judge":
			if (!deps.judge) return { outcome: "allow", source: "unmatched", matched };
			return tooLarge ? oversize(d, matched, policy) : consultJudge(d, matched, deps);
		default:
			return { outcome: "allow", source: "unmatched", matched };
	}
}
