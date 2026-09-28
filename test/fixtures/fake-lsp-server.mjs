// A minimal language server for tests. Files are lines of text:
//   `def NAME`   declares NAME (definition, documentSymbol, workspaceSymbol)
//   `ERR text`   is an error diagnostic with message "text"
//   `need NAME`  is an error unless some open file declares NAME
// Any other occurrence of a declared name is a reference. Hovering `CRASH`
// makes the server exit. FAKE_LSP_PULL=1 serves diagnostics by pull only;
// otherwise they are published (an empty publish first, like tsserver).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pull = process.env.FAKE_LSP_PULL === "1";
const docs = new Map();
let buffer = Buffer.alloc(0);

function send(msg) {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function lines(uri) {
	return (docs.get(uri) ?? readFileSync(fileURLToPath(uri), "utf-8")).split("\n");
}

function diagnostics(uri) {
	const declared = new Set(declarations().map((d) => d.name));
	return lines(uri).flatMap((text, line) => {
		const range = { start: { line, character: 0 }, end: { line, character: text.length } };
		const at = text.indexOf("ERR ");
		if (at !== -1) return [{ range: { ...range, start: { line, character: at } }, severity: 1, source: "fake", message: text.slice(at + 4) }];
		const need = /^need (\w+)/.exec(text);
		if (need && !declared.has(need[1])) return [{ range, severity: 1, source: "fake", message: `${need[1]} is not declared` }];
		return [];
	});
}

function wordAt(uri, { line, character }) {
	const text = lines(uri)[line] ?? "";
	const re = /\w+/g;
	for (let m; (m = re.exec(text)); ) if (m.index <= character && character <= m.index + m[0].length) return m[0];
	return undefined;
}

function declarations() {
	const out = [];
	for (const uri of docs.keys()) {
		lines(uri).forEach((text, line) => {
			const m = /^def (\w+)/.exec(text);
			if (m) out.push({ uri, name: m[1], range: { start: { line, character: 4 }, end: { line, character: 4 + m[1].length } } });
		});
	}
	return out;
}

// Like tsserver: an early empty publish for the changed file, then every open file's real set.
function publish(uri) {
	if (pull) return;
	send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
	setTimeout(() => {
		for (const u of docs.keys()) send({ method: "textDocument/publishDiagnostics", params: { uri: u, diagnostics: diagnostics(u) } });
	}, 40);
}

function handle(msg) {
	const { id, method, params } = msg;
	const reply = (result) => send({ id, result });
	switch (method) {
		case "initialize":
			return reply({
				capabilities: {
					textDocumentSync: 1,
					hoverProvider: true,
					definitionProvider: true,
					referencesProvider: true,
					documentSymbolProvider: true,
					workspaceSymbolProvider: true,
					...(pull ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } : {}),
				},
			});
		case "initialized":
			// Ask the client something, as real servers do; it must answer.
			return send({ id: 9001, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
		case "textDocument/didOpen":
			docs.set(params.textDocument.uri, params.textDocument.text);
			return publish(params.textDocument.uri);
		case "textDocument/didChange":
			docs.set(params.textDocument.uri, params.contentChanges.at(-1).text);
			return publish(params.textDocument.uri);
		case "textDocument/diagnostic":
			return reply({ kind: "full", items: diagnostics(params.textDocument.uri) });
		case "textDocument/hover": {
			const word = wordAt(params.textDocument.uri, params.position);
			if (word === "CRASH") process.exit(3);
			return reply(word ? { contents: { kind: "markdown", value: `hover: ${word}` } } : null);
		}
		case "textDocument/definition": {
			const word = wordAt(params.textDocument.uri, params.position);
			return reply(declarations().filter((d) => d.name === word).map(({ uri, range }) => ({ uri, range })));
		}
		case "textDocument/references": {
			const word = wordAt(params.textDocument.uri, params.position);
			const out = [];
			for (const uri of docs.keys()) {
				lines(uri).forEach((text, line) => {
					const re = new RegExp(`\\b${word}\\b`, "g");
					for (let m; (m = re.exec(text)); ) out.push({ uri, range: { start: { line, character: m.index }, end: { line, character: m.index + word.length } } });
				});
			}
			return reply(out);
		}
		case "textDocument/documentSymbol":
			return reply(
				declarations()
					.filter((d) => d.uri === params.textDocument.uri)
					.map((d) => ({ name: d.name, kind: 12, range: d.range, selectionRange: d.range })),
			);
		case "workspace/symbol":
			return reply(
				declarations()
					.filter((d) => d.name.includes(params.query))
					.map((d) => ({ name: d.name, kind: 12, location: { uri: d.uri, range: d.range } })),
			);
		case "shutdown":
			return reply(null);
		case "exit":
			return process.exit(0);
		default:
			if (id !== undefined && method) reply(null);
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end === -1) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		handle(msg);
	}
});
