"use strict";

const { ipcRenderer } = require("electron");

const params = new URLSearchParams(window.location.search);
const target = params.get("target") || "";
const host = params.get("host") || "";

const hostLine = document.getElementById("hostLine");
const advanced = document.getElementById("advanced");

const provider = params.get("provider") || "";

if (hostLine) {
  const prefix = provider ? `${provider}: ` : "";
  hostLine.textContent = host
    ? `${prefix}Blocked host: ${host}`
    : target
      ? `${prefix}${target}`
      : "Unknown site";
}

document.getElementById("btnBack")?.addEventListener("click", () => {
  ipcRenderer.sendToHost("bavarium-unsafe-warning-back");
});

document.getElementById("btnDetails")?.addEventListener("click", () => {
  if (advanced) advanced.classList.toggle("open");
});

document.getElementById("btnProceed")?.addEventListener("click", () => {
  if (!target) return;
  ipcRenderer.sendToHost("bavarium-unsafe-warning-proceed", target);
});
