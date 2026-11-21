"use strict";
(() => {
  const tab = crypto.randomUUID();
  function pulse(closed) {
    const body = JSON.stringify({tab, closed});
    if (closed) {
      navigator.sendBeacon("/api/session", new Blob([body], {type: "application/json"}));
    } else {
      fetch("/api/session", {method: "POST", headers: {"Content-Type": "application/json"}, body}).catch(() => {});
    }
  }
  window.addEventListener("pageshow", () => pulse(false));
  window.addEventListener("pagehide", () => pulse(true));
  setInterval(() => pulse(false), 60000);
})();
