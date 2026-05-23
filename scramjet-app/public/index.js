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

function notifyBavariumPageMeta() {
	try {
		require("electron").ipcRenderer.sendToHost("bavarium-page-meta-changed");
	} catch (_) {}
}

function hookProxyFrameNavigation(frameEl) {
	if (!frameEl || frameEl.__bavariumNavHook) return;
	frameEl.__bavariumNavHook = true;
	frameEl.addEventListener("load", notifyBavariumPageMeta);
	try {
		const w = frameEl.contentWindow;
		if (w && w.history && !w.__bavariumHistoryHook) {
			w.__bavariumHistoryHook = true;
			const push = w.history.pushState;
			const replace = w.history.replaceState;
			if (push) {
				w.history.pushState = function () {
					const r = push.apply(this, arguments);
					notifyBavariumPageMeta();
					return r;
				};
			}
			if (replace) {
				w.history.replaceState = function () {
					const r = replace.apply(this, arguments);
					notifyBavariumPageMeta();
					return r;
				};
			}
			w.addEventListener("popstate", notifyBavariumPageMeta);
			w.addEventListener("hashchange", notifyBavariumPageMeta);
		}
	} catch (_) {}
	setInterval(notifyBavariumPageMeta, 600);
}

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

	const existingFrame = document.getElementById("sj-frame");
	if (existingFrame) {
		existingFrame.remove();
	}

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
	hookProxyFrameNavigation(frame.frame);
	frame.go(url);
	notifyBavariumPageMeta();
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
