import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { createServer } from "node:http";
import express from "express";
import wisp from "wisp-server-node";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../public");

const app = express();

const licenseFile = join(__dirname, "../LICENSE");

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function buildLicenseHtml(title, licenseText) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — License</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 1.25rem 1.5rem 2rem;
    font-family: system-ui, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    background: #f5f5f5;
    color: #111;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e8e8e8; }
  }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 0.8125rem;
    line-height: 1.45;
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)} — GNU Affero General Public License</h1>
<pre>${escapeHtml(licenseText)}</pre>
</body>
</html>`;
}

let licenseHtmlCache = null;
async function getLicenseHtml() {
	if (!licenseHtmlCache) {
		const text = await readFile(licenseFile, "utf8");
		licenseHtmlCache = buildLicenseHtml("Ultraviolet", text);
	}
	return licenseHtmlCache;
}

// AGPL-3.0 §13: offer through customary means—the full license text used with this deployment.
app.get("/LICENSE", async (req, res) => {
	res.type("text/html; charset=utf-8");
	res.send(await getLicenseHtml());
});

// Load our publicPath first and prioritize it over UV.
app.use(express.static(publicDir));

// Bavarium shell navigations use this path so macOS webviews reload when ?url= changes.
app.get(["/bavarium-nav", "/bavarium-nav/"], (_req, res) => {
	res.sendFile(join(publicDir, "index.html"));
});

// Load vendor files last.
// The vendor's uv.config.js won't conflict with our uv.config.js inside the publicPath directory.
app.use("/uv/", express.static(uvPath));
app.use("/epoxy/", express.static(epoxyPath));
app.use("/baremux/", express.static(baremuxPath));

// Error for everything else
app.use((req, res) => {
	res.status(404);
	res.sendFile(join(publicDir, "404.html"));
});

const server = createServer();

server.on("request", (req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	app(req, res);
});
server.on("upgrade", (req, socket, head) => {
	if (req.url.endsWith("/wisp/")) {
		wisp.routeRequest(req, socket, head);
		return;
	} 
	socket.end();
});

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

server.on("listening", () => {
	const address = server.address();

	// by default we are listening on 0.0.0.0 (every interface)
	// we just need to list a few
	console.log("Listening on:");
	console.log(`\thttp://localhost:${address.port}`);
	console.log(`\thttp://${hostname()}:${address.port}`);
	console.log(
		`\thttp://${
			address.family === "IPv6" ? `[${address.address}]` : address.address
		}:${address.port}`
	);
});

// https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("SIGTERM signal received: closing HTTP server");
	server.close();
	process.exit(0);
}

server.on("error", (err) => {
	if (err && err.code === "EADDRINUSE") {
		console.error(
			`Ultraviolet: port ${port} is already in use. Close the other program or pick another port in Bavarium Settings.`
		);
		process.exit(1);
		return;
	}
	throw err;
});

server.listen({
	port,
});
