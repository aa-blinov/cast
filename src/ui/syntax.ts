/**
 * Syntax highlighting for fenced code blocks in the TUI.
 *
 * A reply's code used to be one flat colour, which is where a terminal renderer
 * gives up on the thing it is best at: strings, comments and keywords carry the
 * shape of a snippet, and the eye finds them long before it reads the words.
 *
 * highlight.js does the tokenizing (the web UI already uses it), through its
 * emitter interface rather than its HTML output — parsing HTML back into spans
 * to draw in a terminal would be silly. Only a curated language list is
 * registered: the full package is 386 languages and every one of them lands in
 * the release bundle. An unknown or missing tag returns null and the block stays
 * plain, deliberately: `highlightAuto` guesses, costs a scan against every
 * registered grammar, and a wrong guess colours the snippet *misleadingly*,
 * which is worse than not colouring it.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** One piece of a highlighted line: its text, and the hljs scope that owns it. */
export interface Token {
	text: string;
	/** e.g. "keyword", "string", "comment", "title.function" — absent for plain text. */
	scope?: string;
}

const LANGUAGES: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
	["bash", bash],
	["c", c],
	["cpp", cpp],
	["csharp", csharp],
	["css", css],
	["diff", diff],
	["dockerfile", dockerfile],
	["go", go],
	["ini", ini],
	["java", java],
	["javascript", javascript],
	["json", json],
	["kotlin", kotlin],
	["lua", lua],
	["markdown", markdown],
	["php", php],
	["python", python],
	["ruby", ruby],
	["rust", rust],
	["scss", scss],
	["sql", sql],
	["swift", swift],
	["typescript", typescript],
	["xml", xml],
	["yaml", yaml],
];

/** Tags a model actually writes after ``` , mapped to the grammars above. */
const ALIASES: Record<string, string> = {
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	node: "javascript",
	ts: "typescript",
	tsx: "typescript",
	py: "python",
	python3: "python",
	rb: "ruby",
	rs: "rust",
	kt: "kotlin",
	yml: "yaml",
	toml: "ini",
	conf: "ini",
	html: "xml",
	svg: "xml",
	vue: "xml",
	md: "markdown",
	patch: "diff",
	"c++": "cpp",
	cs: "csharp",
	golang: "go",
	dockerfile: "dockerfile",
	docker: "dockerfile",
	postgres: "sql",
	psql: "sql",
	mysql: "sql",
};

/**
 * Collects (scope, text) pairs instead of HTML. Scopes nest, and the innermost
 * one is the specific one, so the stack's top wins.
 */
class TokenEmitter {
	readonly tokens: Token[] = [];
	private scopes: string[] = [];

	startScope(name: string): void {
		this.scopes.push(name);
	}

	endScope(): void {
		this.scopes.pop();
	}

	// The engine opens a scope two ways — `startScope` for keywords, and
	// `openNode`/`closeNode` for every mode with a `scope` (see core.js's
	// emitKeyword and startNewMode). Implementing only the documented pair
	// collected nothing but keywords, so both go to the same stack.
	openNode(name: string): void {
		this.startScope(name);
	}

	closeNode(): void {
		this.endScope();
	}

	addText(text: string): void {
		if (!text) return;
		const scope = this.scopes[this.scopes.length - 1];
		const last = this.tokens[this.tokens.length - 1];
		// Merge neighbours with the same scope: fewer Ink elements per row, and
		// the wrapper downstream has less to walk.
		if (last && last.scope === scope) last.text += text;
		else this.tokens.push(scope ? { text, scope } : { text });
	}

	/** A sub-language block (JS inside HTML, SQL in a string) arrives whole. */
	__addSublanguage(emitter: TokenEmitter, _name: string): void {
		for (const token of emitter.tokens) this.addText(token.text);
	}

	finalize(): void {}

	toHTML(): string {
		return this.tokens.map((token) => token.text).join("");
	}
}

let registered = false;

function ensureRegistered(): void {
	if (registered) return;
	for (const [name, language] of LANGUAGES) hljs.registerLanguage(name, language);
	// Swap the HTML emitter for the token collector, once, for every call.
	hljs.configure({ __emitter: TokenEmitter as never });
	registered = true;
}

/** The grammar for a fence tag, or undefined when we have none for it. */
export function resolveLanguage(tag: string | undefined): string | undefined {
	if (!tag) return undefined;
	const name = tag.trim().toLowerCase();
	if (!name) return undefined;
	const resolved = ALIASES[name] ?? name;
	return LANGUAGES.some(([id]) => id === resolved) ? resolved : undefined;
}

/**
 * Tokens per line of `code`, or null when the language is unknown (leave it
 * plain) or highlighting failed. Lines are split after tokenizing, so a token
 * spanning a newline — a block comment, a template literal — keeps its scope on
 * every line it covers.
 */
export function highlightCode(code: string, tag: string | undefined): Token[][] | null {
	const language = resolveLanguage(tag);
	if (!language) return null;
	ensureRegistered();
	let tokens: Token[];
	try {
		// ignoreIllegals: a grammar's "illegal" rule aborts the whole highlight,
		// and a snippet in a reply is routinely a fragment rather than a valid
		// file. A fragment colours fine; refusing to colour it does not help.
		const result = hljs.highlight(code, { language, ignoreIllegals: true });
		// hljs builds the emitter itself (from the configured class) and hands it
		// back on the result — that is where the tokens are.
		tokens = (result as unknown as { _emitter?: TokenEmitter })._emitter?.tokens ?? [{ text: code }];
	} catch {
		return null;
	}
	const lines: Token[][] = [[]];
	for (const token of tokens) {
		const pieces = token.text.split("\n");
		pieces.forEach((piece, index) => {
			if (index > 0) lines.push([]);
			if (piece) lines[lines.length - 1]!.push(token.scope ? { text: piece, scope: token.scope } : { text: piece });
		});
	}
	return lines;
}
