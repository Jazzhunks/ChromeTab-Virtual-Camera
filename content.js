/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Chrome Tab Virtual Camera - Isolated Content Script Bridge
 */

console.log("[TabCam Bridge] Initialized Content Script Bridge.");

// 1. Inject the webpage hook (inject.js) into the page's global main execution environment/context
try {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.async = false;
  script.onload = () => {
    script.remove(); // Clean up tag once executed
  };
  (document.head || document.documentElement).appendChild(script);
} catch (error) {
  console.error("[TabCam Bridge] Script injection failed:", error);
}

// 2. Listen for messages from page context ("inject.js") and relay them to background service worker
window.addEventListener("message", (event) => {
  // Guard clause - only accept messages originating from the same page we are injected in and matching our namespace
  if (event.source !== window || !event.data || event.data.source !== "TABCAM_INJECT") {
    return;
  }

  const { type, payload } = event.data;

  // Send to background service worker
  chrome.runtime.sendMessage({
    action: "SIGNAL_TO_OFFSCREEN",
    payload: {
      type: type, // "INIT_CONNECTION" | "ANSWER" | "ICE_CANDIDATE" | "DISCONNECT"
      ...payload
    }
  }).catch(() => {
    // Might fail if extension background worker is sleeping/stale
  });
});

// 3. Listen for messages from background service worker/offscreen and forward to webpage context
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  if (action === "SIGNAL_FROM_EXTENSION") {
    // Forward to webpage context via window.postMessage
    window.postMessage({
      source: "TABCAM_CONTENT",
      type: payload.type, // "OFFER" | "ICE_CANDIDATE"
      payload: payload
    }, "*");
    sendResponse({ status: "success" });
  }
});
