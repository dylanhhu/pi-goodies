/** Layer 1 rule matching and severity resolution. */

import type { CompiledRule } from "./config.ts";
import { pathForms } from "./paths.ts";
import { type Action, type Descriptor, type HostMatcher, SEVERITY } from "./types.ts";

export interface MatchContext {
	allowedHosts: string[];
	home: string;
}

function inDomain(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function ipv4Octets(host: string): number[] | undefined {
	const parts = host.split(".");
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
	const octets = parts.map(Number);
	return octets.every((o) => o <= 255) ? octets : undefined;
}

function isLoopbackOrPrivate(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
	const o = ipv4Octets(host);
	if (!o) return false;
	return (
		o[0] === 127 ||
		o[0] === 10 ||
		o[0] === 0 ||
		(o[0] === 192 && o[1] === 168) ||
		(o[0] === 172 && o[1] >= 16 && o[1] <= 31)
	);
}

function hostMatches(host: string, m: HostMatcher, allowedHosts: string[]): boolean {
	if (m.tlds?.some((tld) => host.endsWith(`.${tld}`))) return true;
	if (m.domains?.some((d) => inDomain(host, d))) return true;
	if (m.ipLiteral && ipv4Octets(host) && !isLoopbackOrPrivate(host)) return true;
	if (m.notInAllowed && !isLoopbackOrPrivate(host)) {
		return !allowedHosts.some((d) => inDomain(host, d));
	}
	return false;
}

function matches(rule: CompiledRule, d: Descriptor, ctx: MatchContext): boolean {
	if (rule.action === "allow" || !rule.tools.includes(d.tool)) return false;

	// Text matchers see the bash command, or the content of a write or edit
	const text = d.scanText ?? d.command ?? d.content ?? "";
	if (rule.pattern && !rule.pattern.test(text)) return false;
	if (rule.allOf && !rule.allOf.every((re) => re.test(text))) return false;
	if (rule.hosts) {
		const m = rule.hosts;
		if (!d.hosts.some((h) => hostMatches(h, m, ctx.allowedHosts))) return false;
	}
	if (rule.paths) {
		const regexes = rule.paths;
		const hit = d.paths.some((p) =>
			pathForms(p, ctx.home).some((form) => regexes.some((re) => re.test(form))),
		);
		if (!hit) return false;
	}
	return true;
}

/** Every rule that applies to this call, in rule order. */
export function matchRules(
	rules: CompiledRule[],
	d: Descriptor,
	ctx: MatchContext,
): CompiledRule[] {
	return rules.filter((rule) => matches(rule, d, ctx));
}

export interface Resolution {
	action: Action;
	/** The first rule carrying the winning action; supplies the message and label */
	primary: CompiledRule;
	all: CompiledRule[];
}

/** Collapse several matches into the single most severe action. */
export function resolveMatches(matched: CompiledRule[]): Resolution | undefined {
	if (matched.length === 0) return undefined;
	let primary = matched[0];
	for (const rule of matched) {
		if (SEVERITY[rule.action] > SEVERITY[primary.action]) primary = rule;
	}
	return { action: primary.action, primary, all: matched };
}
