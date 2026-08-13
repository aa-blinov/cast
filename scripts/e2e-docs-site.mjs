import assert from "node:assert/strict";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const repo = resolve(new URL("..", import.meta.url).pathname);
const site = join(repo, "site");

function playwrightExecutable() {
	if (process.env.CAST_PLAYWRIGHT_EXECUTABLE) return process.env.CAST_PLAYWRIGHT_EXECUTABLE;
	if (process.platform === "linux") {
		const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
		try {
			const shell = readdirSync(browserRoot)
				.filter((entry) => entry.startsWith("chromium_headless_shell-"))
				.sort()
				.reverse()
				.map((entry) => join(browserRoot, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"))
				.find((candidate) => existsSync(candidate));
			if (shell) return shell;
		} catch {
			// Fall back to Playwright's regular Chromium binary below.
		}
	}
	return chromium.executablePath();
}

function contentType(path) {
	return {
		".css": "text/css; charset=utf-8",
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
	}[extname(path)] ?? "application/octet-stream";
}

function startSiteServer() {
	const server = createServer((request, response) => {
		const requested = request.url?.split("?", 1)[0] ?? "/";
		const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
		const file = normalize(join(site, relative));
		if (!file.startsWith(`${site}/`) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
			response.writeHead(404).end("Not found");
			return;
		}
		response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
		createReadStream(file).pipe(response);
	});
	return new Promise((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise(server)));
}

execFileSync(process.execPath, ["--import", "tsx", "scripts/build-site.mjs"], { cwd: repo, stdio: "ignore" });
const server = await startSiteServer();
const port = server.address().port;
let browser;
try {
	browser = await chromium.launch({
		headless: true,
		executablePath: playwrightExecutable(),
		args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
	});

	const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	desktop.setDefaultTimeout(15_000);
	await desktop.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:" + port });
	await desktop.goto(`http://127.0.0.1:${port}/getting-started.html`, { waitUntil: "networkidle" });
	const codeCheck = await desktop.locator(".content pre.code-block").first().evaluate((pre) => {
		const code = pre.querySelector("code");
		const style = getComputedStyle(pre);
		return {
			background: style.backgroundColor,
			backgroundImage: style.backgroundImage,
			borderStyle: style.borderTopStyle,
			overflowX: style.overflowX,
			language: pre.getAttribute("data-language"),
			codeClass: code?.className ?? "",
			scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
			scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
		};
	});
	assert.notEqual(codeCheck.backgroundImage, "none", "code block must have a visible background");
	assert.equal(codeCheck.borderStyle, "solid", "code block must have a visible border");
	assert.equal(codeCheck.overflowX, "auto", "long code must scroll inside its block");
	assert.equal(codeCheck.language, "bash", "language label must be preserved");
	assert.match(codeCheck.codeClass, /hljs/, "code must use the syntax-highlighting class");
	assert.equal(codeCheck.scrollbarWidth, "thin", "documentation page must use a themed thin scrollbar");
	assert.notEqual(codeCheck.scrollbarColor, "auto", "documentation page must define scrollbar colors");
	assert((await desktop.locator('.content pre.code-block span[class^="hljs-"]').count()) > 0, "highlighted code must contain syntax spans");

	await desktop.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
	await desktop.screenshot({ path: "/tmp/cast-workspace-desktop.png", fullPage: false });
	assert.equal(await desktop.locator(".workspace-ui").count(), 1, "actual Web UI preview must be present");
	assert.equal(await desktop.locator(".workspace-ui-sidebar").count(), 1, "preview must include the sessions sidebar");
	assert.equal(await desktop.locator(".workspace-ui-new").count(), 1, "preview must include New session");
	assert.equal(await desktop.locator(".workspace-ui-persona").count(), 4, "preview must include switchable personas");
	assert.equal(await desktop.locator(".workspace-ui-metrics").count(), 0, "landing must not show fabricated metrics");
	assert.equal(await desktop.locator(".workspace-ui input, .workspace-ui textarea").count(), 0, "preview must not show an empty input");
	assert.equal(await desktop.locator(".workspace-role").count(), 0, "landing must not repeat personas in a lower card");
	assert.equal(await desktop.locator(".workspace-ui-role").count(), 0, "preview must not repeat the active persona near build");
	assert.equal(await desktop.locator(".workspace-copy-btn").count(), 2, "install commands must have copy buttons");
	assert.equal(await desktop.locator(".workspace-copy-btn svg").count(), 2, "copy buttons must use project-style SVG icons");
	await desktop.getByRole("button", { name: "Copy macOS and Linux install command" }).click();
	assert.equal(await desktop.getByRole("button", { name: "Copied" }).count(), 1, "copy button must acknowledge a successful copy");
	const previewText = await desktop.locator(".workspace-ui").innerText();
	assert(!previewText.includes("ready"), "preview must not show the ready label");
	assert(!previewText.includes("session · auth-service"), "preview must not show the session subtitle");
	assert(!previewText.includes("cast ·"), "preview must not prefix persona labels with cast");
	assert(!previewText.includes("cast / agent workspace"), "landing must not show the workspace kicker");
	const landingText = await desktop.locator(".workspace-shell").innerText();
	assert(!landingText.includes("Same repository. Same tools. Different judgment."), "landing must not show the redundant status line");
	assert(!landingText.includes("One repo, one session, a role that matches the job in front of you."), "landing must not show the redundant section subtitle");
	assert(!landingText.includes("Self-contained bundle for macOS, Linux, and Windows. Works with OpenAI-compatible APIs."), "landing must not show the redundant install subtitle");
	assert(!landingText.includes("The whole surface area, organized for quick lookup."), "landing must not show the redundant docs subtitle");
	assert(!landingText.includes("cast is open source under the MIT License"), "landing must not show the old footer sentence");
	assert(landingText.includes("MIT License"), "landing footer must retain a quiet MIT License link");
	const previewHeaderText = await desktop.locator(".workspace-ui-header").innerText();
	assert(!previewHeaderText.includes("~/projects/auth-service"), "preview top bar must not show the repository path");
	assert(!previewHeaderText.includes("cast"), "preview top bar must not show the product name");
	assert.equal(await desktop.locator(".workspace-ui-status").evaluate((dot) => getComputedStyle(dot).backgroundColor), "rgb(34, 197, 94)", "connected status must be green");
	await desktop.getByRole("tab", { name: "Reviewer" }).click();
	assert.equal(await desktop.getByRole("tab", { name: "Reviewer" }).getAttribute("aria-selected"), "true", "selected persona tab must update after switching");
	assert.equal(await desktop.locator('[data-persona-panel="reviewer"]').isHidden(), false, "selected persona panel must be visible");
	assert.equal(await desktop.locator('[data-persona-panel="senior"]').isHidden(), true, "previous persona panel must be hidden");

	const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
	await mobile.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
	const mobileCheck = await mobile.evaluate(() => ({
		viewport: window.innerWidth,
		documentWidth: document.documentElement.scrollWidth,
		panelWidth: document.querySelector(".workspace-ui")?.getBoundingClientRect().width ?? 0,
		titleSize: getComputedStyle(document.querySelector(".workspace-title")).fontSize,
		scrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
	}));
	assert.equal(mobileCheck.documentWidth, mobileCheck.viewport, "mobile landing page must not overflow horizontally");
	assert(mobileCheck.panelWidth <= mobileCheck.viewport - 32, "workspace preview must fit the mobile gutter");
	assert.equal(mobileCheck.scrollbarWidth, "thin", "mobile landing page must use a themed thin scrollbar");
	await mobile.screenshot({ path: "/tmp/cast-workspace-mobile.png", fullPage: false });

	console.log(JSON.stringify({ codeCheck, mobileCheck }, null, 2));
	console.log("Docs and workspace Playwright checks passed");
} finally {
	await browser?.close();
	server.close();
}
