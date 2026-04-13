"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

scramjet.init();

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

	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
		await connection.setTransport("/libcurl/index.mjs", [
			{ websocket: wispUrl },
		]);
	}
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	document.body.appendChild(frame.frame);
	frame.go(url);
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
