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

/** Serialize overlapping navigations (Bavarium may trigger many in quick succession). */
let proxyNavChain = Promise.resolve();

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
	const fromQuery = new URLSearchParams(location.search).get("url");
	if (fromQuery) return fromQuery;
	const hash = (location.hash || "").replace(/^#/, "");
	if (hash.startsWith("url=")) {
		return decodeURIComponent(hash.slice(4));
	}
	return null;
}

function shellPathForHistory() {
	const path =
		location.pathname && location.pathname !== "/"
			? location.pathname
			: "/";
	const hash = location.hash || "";
	return path + hash;
}

/**
 * @param {string} rawInput address bar / search text or full URL
 */
function proxiedHrefForTarget(url) {
	const proxiedPath = __uv$config.prefix + __uv$config.encodeUrl(url);
	return new URL(proxiedPath, location.origin).href;
}

function frameShowsProxiedTarget(frame, url) {
	if (!frame || !frame.src || frame.src === "about:blank") return false;
	const targetHref = proxiedHrefForTarget(url);
	if (frame.src === targetHref) return true;
	try {
		const path = __uv$config.prefix + __uv$config.encodeUrl(url);
		return frame.src.endsWith(path);
	} catch (_) {
		return false;
	}
}

async function startProxyNavigation(rawInput) {
	const run = async () => {
		try {
			await registerSW();
		} catch (err) {
			error.textContent = "Failed to register service worker.";
			errorCode.textContent = err.toString();
			throw err;
		}

		const url = search(rawInput, searchEngine.value);
		const frame = document.getElementById("uv-frame");
		if (!frame) {
			return;
		}

		if (lastProxiedTarget === url && frameShowsProxiedTarget(frame, url)) {
			document.body.classList.add("uv-active");
			return;
		}

		lastProxiedTarget = url;
		hookProxyFrameNavigation(frame);
		frame.style.display = "block";
		document.body.classList.add("uv-active");
		const wispUrl =
			(location.protocol === "https:" ? "wss" : "ws") +
			"://" +
			location.host +
			"/wisp/";
		if ((await connection.getTransport()) !== "/epoxy/index.mjs") {
			await connection.setTransport("/epoxy/index.mjs", [{ wisp: wispUrl }]);
		}
		const proxiedHref = proxiedHrefForTarget(url);
		if (
			frame.src &&
			frame.src !== "about:blank" &&
			!frameShowsProxiedTarget(frame, url)
		) {
			frame.src = "about:blank";
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		if (!frameShowsProxiedTarget(frame, url)) {
			frame.src = proxiedHref;
		}
		notifyBavariumPageMeta();
	};

	proxyNavChain = proxyNavChain.then(run, run);
	return proxyNavChain;
}

/** Called from Bavarium renderer without reloading this shell (macOS UV fix). */
window.bavariumStartProxyNavigation = startProxyNavigation;

async function runDeepLinkNavigation() {
	const deepLink = deepLinkTargetFromLocation();
	if (!deepLink) return false;
	address.value = deepLink;
	await startProxyNavigation(deepLink);
	if (window.history?.replaceState) {
		window.history.replaceState({}, "", shellPathForHistory());
	}
	return true;
}

function installBavariumHashNavigation() {
	if (window.__bavariumUvHashHook) return;
	window.__bavariumUvHashHook = true;
	window.addEventListener("hashchange", () => {
		runDeepLinkNavigation().catch((err) => {
			error.textContent = "Navigation failed.";
			errorCode.textContent = err?.stack || String(err);
		});
	});
}

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	try {
		await startProxyNavigation(address.value);
	} catch {
		/* surfaced in startProxyNavigation */
	}
});

installBavariumHashNavigation();

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
