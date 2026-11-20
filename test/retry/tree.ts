import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EntryLookup } from "../../extensions/retry.ts";

type Projected = ProjectedSessionEntry["messages"][number];

/** Minimal session tree: entries keyed by id, each knowing its parent. */
export class Tree implements EntryLookup {
	readonly entries: SessionEntry[] = [];
	private readonly byId = new Map<string, SessionEntry>();
	private readonly omitted = new Set<string>();
	private n = 0;

	private push(entry: Record<string, unknown> & { parentId: string | null }): SessionEntry {
		const id = `e${++this.n}`;
		const full = { ...entry, id, timestamp: new Date(0).toISOString() } as unknown as SessionEntry;
		this.entries.push(full);
		this.byId.set(id, full);
		return full;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/** Simulate a `context_edit` with a null replacement, as pi writes for a retried attempt. */
	omit(entry: SessionEntry): SessionEntry {
		this.omitted.add(entry.id);
		return entry;
	}

	/** The projection pi would build for this branch. */
	projection(): ProjectedSessionEntry[] {
		return this.entries.map((sourceEntry) => ({
			sourceEntry,
			messages: this.omitted.has(sourceEntry.id) ? [] : project(sourceEntry),
		}));
	}

	user(parentId: string | null, text = "do the thing"): SessionEntry {
		return this.push({
			type: "message",
			parentId,
			message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
		});
	}

	assistantText(parentId: string | null, text = "done", stopReason = "stop"): SessionEntry {
		return this.push({
			type: "message",
			parentId,
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
				timestamp: 0,
			},
		});
	}

	assistantCall(parentId: string | null, callId = "c1", stopReason = "toolUse"): SessionEntry {
		return this.push({
			type: "message",
			parentId,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
				stopReason,
				timestamp: 0,
			},
		});
	}

	toolResult(parentId: string | null, callId = "c1"): SessionEntry {
		return this.push({
			type: "message",
			parentId,
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				timestamp: 0,
			},
		});
	}

	customMessage(parentId: string | null, text = "a check-in fired"): SessionEntry {
		return this.push({
			type: "custom_message",
			parentId,
			customType: "checkin",
			content: text,
			display: true,
		});
	}

	state(parentId: string | null): SessionEntry {
		return this.push({ type: "custom", parentId, customType: "state", data: {} });
	}

	compaction(parentId: string | null, summary = "history"): SessionEntry {
		return this.push({
			type: "compaction",
			parentId,
			summary,
			firstKeptEntryId: "e1",
			tokensBefore: 1,
		});
	}

	branchSummary(parentId: string | null): SessionEntry {
		return this.push({ type: "branch_summary", parentId, fromId: "e1", summary: "other branch" });
	}
}

/** What one entry contributes to the model transcript. */
function project(entry: SessionEntry): Projected[] {
	switch (entry.type) {
		case "message":
			return [entry.message as Projected];
		case "custom_message":
			return [
				{
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					timestamp: 0,
				} as Projected,
			];
		case "compaction":
			return [{ role: "compactionSummary", summary: entry.summary, timestamp: 0 } as Projected];
		case "branch_summary":
			return [{ role: "branchSummary", summary: entry.summary, timestamp: 0 } as Projected];
		default:
			return [];
	}
}
