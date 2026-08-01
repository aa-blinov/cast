const form = document.querySelector("#login-form");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const submit = document.querySelector("#login-submit");
const error = document.querySelector("#login-error");
const logo = document.querySelector("#login-logo");

async function renderLogo() {
	try {
		const lines = await fetch("/cast-banner-grid.json").then((response) => response.json());
		const cell = 10;
		const width = Math.max(...lines.map((line) => line.length)) * cell;
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", `0 0 ${width} ${lines.length * cell}`);
		svg.setAttribute("aria-hidden", "true");
		const defs = document.createElementNS(ns, "defs");
		const gradient = document.createElementNS(ns, "linearGradient");
		gradient.setAttribute("id", "login-logo-gradient");
		gradient.setAttribute("x1", "0%");
		gradient.setAttribute("y1", "0%");
		gradient.setAttribute("x2", "100%");
		gradient.setAttribute("y2", "100%");
		for (const [offset, color] of [
			["0%", "--gradient-from"],
			["100%", "--gradient-to"],
		]) {
			const stop = document.createElementNS(ns, "stop");
			stop.setAttribute("offset", offset);
			stop.setAttribute("stop-color", getComputedStyle(document.documentElement).getPropertyValue(color).trim());
			gradient.append(stop);
		}
		defs.append(gradient);
		svg.append(defs);
		const opacity = { "░": "0.35", "▒": "0.6", "▓": "0.85", "█": "1" };
		for (const [y, line] of lines.entries()) {
			for (const [x, character] of [...line].entries()) {
				if (!opacity[character]) continue;
				const rect = document.createElementNS(ns, "rect");
				rect.setAttribute("x", String(x * cell));
				rect.setAttribute("y", String(y * cell));
				rect.setAttribute("width", String(cell));
				rect.setAttribute("height", String(cell));
				rect.setAttribute("fill", "url(#login-logo-gradient)");
				rect.setAttribute("opacity", opacity[character]);
				svg.append(rect);
			}
		}
		logo.replaceChildren(svg);
	} catch {}
}

async function redirectIfAuthenticated() {
	try {
		const response = await fetch("/api/auth/session");
		const session = await response.json();
		if (session.authenticated) window.location.replace("/");
	} catch {}
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	error.hidden = true;
	submit.disabled = true;
	submit.textContent = "Signing in…";
	try {
		const response = await fetch("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: username.value, password: password.value }),
		});
		const result = await response.json().catch(() => null);
		if (!response.ok) throw new Error(result?.error || "Could not sign in");
		window.location.replace("/");
	} catch (err) {
		error.textContent = err instanceof Error ? err.message : "Could not sign in";
		error.hidden = false;
		password.focus();
	} finally {
		submit.disabled = false;
		submit.textContent = "Sign in";
	}
});

redirectIfAuthenticated();
renderLogo();
