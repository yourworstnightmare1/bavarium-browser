"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("uv-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("uv-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("uv-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("uv-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("uv-error-code");
const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

/**
 * @param {string} rawInput address bar / search text or full URL
 */
async function startProxyNavigation(rawInput) {
	try {
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		throw err;
	}

	const url = search(rawInput, searchEngine.value);

	const frame = document.getElementById("uv-frame");
	frame.style.display = "block";
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	if ((await connection.getTransport()) !== "/epoxy/index.mjs") {
		await connection.setTransport("/epoxy/index.mjs", [
			{ wisp: wispUrl },
		]);
	}
	frame.src = __uv$config.prefix + __uv$config.encodeUrl(url);
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		await startProxyNavigation(address.value);
	} catch {
		/* surfaced in startProxyNavigation */
	}
});

const deepLink = new URLSearchParams(location.search).get("url");
if (deepLink) {
	address.value = deepLink;
	startProxyNavigation(deepLink).catch((err) => {
		error.textContent = "Navigation failed.";
		errorCode.textContent = err?.stack || String(err);
	});
	if (window.history?.replaceState) {
		window.history.replaceState({}, "", location.pathname || "/");
	}
}
