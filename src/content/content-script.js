/**
 * Content Script — D365 Contact Center Bridge
 * 
 * Injected into D365 pages. Responsibilities:
 * 1. Inject page-level script for D365 CIF API access
 * 2. Bridge messages between service worker ↔ page context
 * 3. Monitor D365 Omnichannel widget for call state changes via DOM observation
 * 
 * CALL DETECTION STRATEGY:
 * The D365 Contact Center / Omnichannel agent UI renders call notifications
 * and controls using Fluent UI / Power Apps PCF components. The exact CSS 
 * classes and data-attributes vary by version. We use THREE detection strategies:
 *   A) Text-based button search (most reliable — looks for "Accept", "End call", etc.)
 *   B) CSS selector matching (known selectors from various D365 versions)
 *   C) Timer pattern detection (for active calls showing duration)
 * 
 * NOTE: Content scripts in Manifest V3 run as classic scripts (NOT ES modules).
 * All constants from shared/messages.js are inlined here to avoid import errors.
 */

// ── Inlined from shared/messages.js (keep in sync!) ──
const MSG = {
  CALL_STATE_CHANGED: 'CALL_STATE_CHANGED',
  MUTE_STATE_CHANGED: 'MUTE_STATE_CHANGED',
  PAGE_BRIDGE_ACTION: 'BOSE_D365_ACTION',
  PAGE_BRIDGE_STATE:  'BOSE_D365_STATE',
};
const SOURCE = {
  SERVICE_WORKER: 'service-worker',
  CONTENT_SCRIPT: 'content-script',
};
const CALL_STATE = {
  IDLE:    'idle',
  RINGING: 'ringing',
  ACTIVE:  'active',
  HOLD:    'hold',
};

const EXTENSION_ID = chrome.runtime.id;
const BRIDGE_PREFIX = 'BOSE_D365_BRIDGE';

// ── Inject page-level script ──

function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/content/page-injected.js');
  script.type = 'module';
  script.dataset.extensionId = EXTENSION_ID;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

// ── Message bridge: window.postMessage ↔ chrome.runtime ──

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.bridge !== BRIDGE_PREFIX) return;
  if (event.data.direction !== 'page-to-content') return;

  const { type, payload } = event.data;

  chrome.runtime.sendMessage({
    source: SOURCE.CONTENT_SCRIPT,
    type,
    payload,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.source !== SOURCE.SERVICE_WORKER) return;

  window.postMessage({
    bridge: BRIDGE_PREFIX,
    direction: 'content-to-page',
    type: message.type,
    payload: message.payload,
  }, '*');
});

// ── Text-based button search (Strategy A) ──
// Searches ALL interactive elements for text matching call-related actions.
// This is the most robust approach across D365 versions.

function findButtonByText(...terms) {
  const candidates = document.querySelectorAll(
    'button, [role="button"], [role="menuitem"], a[role="button"]'
  );
  for (const el of candidates) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const text = (el.textContent || '').trim().toLowerCase();
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const dataId = (el.getAttribute('data-id') || '').toLowerCase();
    const combined = `${text} | ${label} | ${title} | ${dataId}`;

    for (const term of terms) {
      if (combined.includes(term.toLowerCase())) {
        // Verify element is visible (not hidden)
        const style = getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' &&
            (el.offsetParent !== null || el.offsetWidth > 0)) {
          return el;
        }
      }
    }
  }
  return null;
}

// CSS selector-based search (Strategy B) — fallback
function queryAny(selectorList) {
  for (const sel of selectorList) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (_) { /* invalid selector */ }
  }
  return null;
}

// Timer pattern detection (Strategy C) — active call indicator
function findCallTimer() {
  // Look for visible text matching MM:SS or HH:MM:SS pattern
  const timerRegex = /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/;
  const elements = document.querySelectorAll('span, div, p, label, time');
  for (const el of elements) {
    const text = el.textContent?.trim();
    if (text && timerRegex.test(text) && text.length <= 12) {
      if (el.offsetParent !== null || el.offsetWidth > 0) {
        return el;
      }
    }
  }
  return null;
}

// ── Known CSS selectors (Strategy B) for various D365 versions ──
const SELECTORS = {
  incomingCallPanel: [
    '[data-id="oc-lcw-incoming-call"]',
    '.oc-incoming-call-notification',
    '[aria-label*="incoming call" i]',
    '[aria-label*="Incoming call"]',
    '[data-id*="notification"][data-id*="call" i]',
    '[data-id*="Notification"][data-id*="Call"]',
    '.notification-container [data-id*="call" i]',
    '[data-id*="IncomingCall"]',
    '[data-id*="incoming-call"]',
  ],
  activeCallPanel: [
    '[data-id="oc-lcw-active-call"]',
    '.oc-active-call-container',
    '[data-id*="voice-call-timer"]',
    '.call-timer',
    '[aria-label*="call duration" i]',
    '[data-id*="CallTimer"]',
    '[data-id*="calltimer"]',
    '[data-id*="ActiveCall"]',
  ],
  holdIndicator: [
    '[data-id*="hold-button"][aria-pressed="true"]',
    '.oc-call-hold-active',
    'button[aria-label="Resume"]',
    'button[title="Resume"]',
    '[aria-label*="on hold" i]',
  ],
  muteButton: [
    '[data-id*="mute-button"]',
    'button[aria-label*="Mute" i]',
    'button[aria-label*="Unmute" i]',
    '[data-id*="microphone" i]',
    'button[title*="Mute"]',
    'button[title*="Unmute"]',
  ],
};

// ── Combined call state detection ──

let lastDetectedState = CALL_STATE.IDLE;
let lastDetectedMute = false;
let detectionLog = ''; // last detection reason for diagnostics

function detectCallState() {
  // === RINGING DETECTION ===
  
  // A) Text-based: look for Accept + Decline buttons appearing together
  const acceptBtn = findButtonByText('accept', 'answer');
  const declineBtn = findButtonByText('decline', 'reject');
  if (acceptBtn) {
    detectionLog = 'RINGING: found Accept button via text search';
    return CALL_STATE.RINGING;
  }
  
  // B) CSS-based
  if (queryAny(SELECTORS.incomingCallPanel)) {
    detectionLog = 'RINGING: matched incoming call CSS selector';
    return CALL_STATE.RINGING;
  }

  // === ACTIVE CALL DETECTION ===
  
  // A) Text-based: look for "End call" or "Hang up" button
  const endBtn = findButtonByText('end call', 'hang up');
  if (endBtn) {
    // Check if on hold
    const resumeBtn = findButtonByText('resume', 'unhold');
    if (resumeBtn || queryAny(SELECTORS.holdIndicator)) {
      detectionLog = 'HOLD: found End call + Resume buttons';
      return CALL_STATE.HOLD;
    }
    detectionLog = 'ACTIVE: found End call button via text search';
    return CALL_STATE.ACTIVE;
  }

  // B) Timer-based: active calls show a duration counter
  if (findCallTimer()) {
    if (findButtonByText('resume', 'unhold') || queryAny(SELECTORS.holdIndicator)) {
      detectionLog = 'HOLD: found call timer + hold indicator';
      return CALL_STATE.HOLD;
    }
    detectionLog = 'ACTIVE: found call timer';
    return CALL_STATE.ACTIVE;
  }

  // C) CSS-based
  if (queryAny(SELECTORS.activeCallPanel)) {
    if (queryAny(SELECTORS.holdIndicator)) {
      detectionLog = 'HOLD: matched active call + hold CSS selectors';
      return CALL_STATE.HOLD;
    }
    detectionLog = 'ACTIVE: matched active call CSS selector';
    return CALL_STATE.ACTIVE;
  }

  detectionLog = '';
  return CALL_STATE.IDLE;
}

function detectMuteState() {
  // Text-based search
  const muteBtn = findButtonByText('unmute');
  if (muteBtn) return true;

  // If we find a "Mute" button with aria-pressed="true"
  const muteBtnAria = findButtonByText('mute');
  if (muteBtnAria && muteBtnAria.getAttribute('aria-pressed') === 'true') return true;

  // CSS fallback
  const cssBtn = queryAny(SELECTORS.muteButton);
  if (!cssBtn) return false;
  if (cssBtn.getAttribute('aria-pressed') === 'true') return true;
  if ((cssBtn.getAttribute('aria-label') || '').toLowerCase().includes('unmute')) return true;
  return false;
}

// ── DOM observation + periodic polling ──

function checkAndNotify() {
  const newState = detectCallState();
  const newMute = detectMuteState();

  if (newState !== lastDetectedState) {
    if (detectionLog) {
      console.log('[Content Script]', detectionLog);
    }
    console.log(`[Content Script] Call state: ${lastDetectedState} → ${newState}`);
    lastDetectedState = newState;
    chrome.runtime.sendMessage({
      source: SOURCE.CONTENT_SCRIPT,
      type: MSG.CALL_STATE_CHANGED,
      payload: { state: newState, detectedBy: 'dom', detail: detectionLog },
    });
  }

  if (newMute !== lastDetectedMute) {
    lastDetectedMute = newMute;
    chrome.runtime.sendMessage({
      source: SOURCE.CONTENT_SCRIPT,
      type: MSG.MUTE_STATE_CHANGED,
      payload: { muted: newMute, detectedBy: 'dom' },
    });
  }
}

const observer = new MutationObserver(() => {
  checkAndNotify();
});

function startObserving() {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'aria-label', 'class', 'style', 'data-id', 'title', 'aria-disabled', 'disabled'],
  });
  // Poll every 1.5 seconds as backup (faster than before since detection is cheap)
  setInterval(checkAndNotify, 1500);
}

// ── Init ──

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    injectPageScript();
    startObserving();
  });
} else {
  injectPageScript();
  startObserving();
}

console.log('[Content Script] Dynamics Audio Companion bridge loaded on:', window.location.hostname);
