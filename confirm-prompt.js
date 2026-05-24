"use strict";

const { ipcRenderer } = require("electron");

const messageEl = document.getElementById("message");
const btnBack = document.getElementById("btnBack");
const btnConfirm = document.getElementById("btnConfirm");

let choiceSent = false;

function sendChoice(proceed) {
  if (choiceSent) return;
  choiceSent = true;
  btnBack.disabled = true;
  btnConfirm.disabled = true;
  ipcRenderer.send("confirm-prompt-choice", { proceed: !!proceed });
}

btnBack.addEventListener("click", () => sendChoice(false));
btnConfirm.addEventListener("click", () => sendChoice(true));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    sendChoice(false);
  }
});

ipcRenderer.on("confirm-prompt-init", (_e, payload) => {
  if (!payload || typeof payload !== "object") return;
  if (payload.windowTitle) document.title = payload.windowTitle;
  if (messageEl && payload.message) {
    messageEl.textContent = payload.message;
  }
  if (btnConfirm && payload.confirmLabel) {
    btnConfirm.textContent = payload.confirmLabel;
  }
});
