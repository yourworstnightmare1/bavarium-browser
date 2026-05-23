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

/** @type {string | null} */
let lastProxiedTarget = null;

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
		const srcObs = new MutationObserver(notifyBavariumPageMeta);
		srcObs.observe(frameEl, { attributes: true, attributeFilter: ["src"] });
	} catch (_) {}
	setInterval(notifyBavariumPageMeta, 600);
}

function deepLinkTargetFromLocation() {
	return new URLSearchParams(location.search).get("url");
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
	lastProxiedTarget = url;

	const frame = document.getElementById("uv-frame");
	if (!frame) return;
	hookProxyFrameNavigation(frame);
	frame.style.display = "block";
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	if ((await connection.getTransport()) !== "/epoxy/index.mjs") {
		await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
	}
	const proxied = __uv$config.prefix + __uv$config.encodeUrl(url);
	// Reset the persistent iframe so a new target cannot keep showing the previous site
	// (macOS Electron webviews often skip iframe updates when only the shell ?url= changes).
	if (frame.src && frame.src !== "about:blank" && frame.src !== proxied) {
		frame.src = "about:blank";
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	frame.src = proxied;
	notifyBavariumPageMeta();
}

/** Called from Bavarium renderer without reloading this shell (macOS UV fix). */
window.bavariumStartProxyNavigation = startProxyNavigation;

async function runDeepLinkNavigation() {
	const deepLink = deepLinkTargetFromLocation();
	if (!deepLink) return false;
	address.value = deepLink;
	await startProxyNavigation(deepLink);
	if (window.history?.replaceState) {
		const path =
			location.pathname && location.pathname !== "/"
				? location.pathname
				: "/";
		window.history.replaceState({}, "", path);
	}
	return true;
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		await startProxyNavigation(address.value);
	} catch {
		/* surfaced in startProxyNavigation */
	}
});

runDeepLinkNavigation().catch((err) => {
	error.textContent = "Navigation failed.";
	errorCode.textContent = err?.stack || String(err);
});

window.addEventListener("pageshow", () => {
	runDeepLinkNavigation().catch((err) => {
		error.textContent = "Navigation failed.";
		errorCode.textContent = err?.stack || String(err);
	});
});
