/**
 * Page-Injected Script — D365 CIF API Bridge
 * 
 * Runs in the D365 page's JavaScript context.
 * Has access to Microsoft.CIFramework and Omnichannel widget internals.
 * Communicates with the content script via window.postMessage.
 * 
 * IMPORTANT: D365 Contact Center (Omnichannel) renders call notifications and
 * controls using Fluent UI / Power Apps PCF. The selectors here must match
 * whatever version of the Omnichannel agent UI is running. We use broad
 * text-based button search as the primary strategy, with CSS selectors as fallback.
 */

const BRIDGE_PREFIX = 'BOSE_D365_BRIDGE';

// ── Utility: send message to content script ──
function sendToContentScript(type, payload) {
  window.postMessage({
    bridge: BRIDGE_PREFIX,
    direction: 'page-to-content',
    type,
    payload,
  }, '*');
}

// ── CIF Event Handlers ──

let cifAvailable = false;

function initCIF() {
  if (typeof Microsoft === 'undefined' || !Microsoft.CIFramework) {
    return false;
  }

  cifAvailable = true;
  console.log('[PageScript] Microsoft.CIFramework detected, version:', Microsoft.CIFramework.getEnvironment?.() || 'unknown');

  try {
    // CIF v2 events for Omnichannel
    Microsoft.CIFramework.addHandler('onclicktoact', (eventData) => {
      console.log('[PageScript] onclicktoact:', eventData);
    });

    Microsoft.CIFramework.addHandler('onSessionClosed', () => {
      console.log('[PageScript] Session closed');
      sendToContentScript('CALL_STATE_CHANGED', { state: 'idle', detectedBy: 'cif' });
    });

    Microsoft.CIFramework.addHandler('onSessionSwitched', (sessionId) => {
      console.log('[PageScript] Session switched:', sessionId);
    });

    // Try v2 mode-changed (panel opened = possible incoming)
    Microsoft.CIFramework.addHandler('onmodechanged', (eventData) => {
      console.log('[PageScript] Mode changed:', eventData);
    });

    // Try to get all sessions to detect active calls
    if (Microsoft.CIFramework.getAllSessions) {
      setInterval(async () => {
        try {
          const sessions = await Microsoft.CIFramework.getAllSessions();
          if (sessions && typeof sessions === 'string') {
            const parsed = JSON.parse(sessions);
            console.log('[PageScript] Active sessions:', parsed.length);
          }
        } catch (_) { /* ignore */ }
      }, 5000);
    }

  } catch (err) {
    console.warn('[PageScript] CIF handler registration error:', err);
  }

  return true;
}

// ── Broad button search by text content ──
// This is the PRIMARY strategy. It searches all interactive elements on the page
// for text that matches call-related actions. This works regardless of the exact
// CSS classes or data-attributes D365 uses in any given version.

function findButtonByText(...terms) {
  // Search buttons, links, and any element with a click role
  const candidates = document.querySelectorAll(
    'button, [role="button"], [role="menuitem"], a[href], div[onclick], span[onclick], ' +
    'div[tabindex="0"], span[tabindex="0"]'
  );
  
  for (const el of candidates) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    
    const text = (el.textContent || '').trim().toLowerCase();
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const dataId = (el.getAttribute('data-id') || '').toLowerCase();
    const combined = `${text} ${label} ${title} ${dataId}`;

    for (const term of terms) {
      if (combined.includes(term.toLowerCase())) {
        // Verify element is visible (has layout)
        if (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0 ||
            getComputedStyle(el).display !== 'none') {
          return el;
        }
      }
    }
  }
  return null;
}

// Also search inside iframes we can access (same-origin)
function findButtonInFrames(...terms) {
  // First try current document
  let btn = findButtonByText(...terms);
  if (btn) return btn;

  // Try accessible iframes
  try {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (!doc) continue;
        const candidates = doc.querySelectorAll(
          'button, [role="button"], [role="menuitem"], a[role="button"], [data-id]'
        );
        for (const el of candidates) {
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
          const text = (el.textContent || '').trim().toLowerCase();
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const dataId = (el.getAttribute('data-id') || '').toLowerCase();
          const combined = `${text} ${label} ${title} ${dataId}`;
          for (const term of terms) {
            if (combined.includes(term.toLowerCase())) {
              if (el.offsetParent !== null || el.offsetWidth > 0) return el;
            }
          }
        }
      } catch (_) { /* cross-origin iframe, skip */ }
    }
  } catch (_) { /* ignore */ }

  return null;
}

function clickButton(selectorList) {
  for (const sel of selectorList) {
    try {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
    } catch (_) { /* invalid selector, skip */ }
  }
  return false;
}

// ── Action handlers (from headset buttons) ──

const ACTIONS = {
  acceptCall() {
    console.log('[PageScript] acceptCall: searching for Accept/Answer button...');

    // Strategy 1: Broad text search (most reliable across D365 versions)
    const btn = findButtonInFrames(
      'accept', 'answer', 'pick up', 'atender', 'aceptar', 'annehmen',
      'accepter', 'accetta', 'akceptuj'
    );
    if (btn) {
      console.log('[PageScript] acceptCall: found button by text:', btn.textContent?.trim());
      btn.click();
      return true;
    }

    // Strategy 2: Known D365 CSS selectors
    const clicked = clickButton([
      '[data-id*="accept" i]',
      '[data-id*="Accept"]',
      '[data-id*="answer" i]',
      'button[aria-label*="Accept" i]',
      'button[aria-label*="Answer" i]',
      'button[aria-label*="Pick up" i]',
      '.oc-accept-call-button',
      'button[title*="Accept" i]',
      'button[title*="Answer" i]',
      // D365 Omnichannel voice/call notification buttons
      '[data-id*="notification"] button:first-child',
      '[data-id*="Notification"] button:first-child',
      '[data-id*="voice"] button:first-child',
      '[data-id*="Voice"] button:first-child',
      // Fluent UI / PCF notification action buttons
      '.ms-Panel button.ms-Button--primary',
      '.ms-Dialog button.ms-Button--primary',
      // Phone icon button (green phone = accept)
      'button[class*="accept" i]',
      'button[class*="answer" i]',
      'button[class*="pickup" i]',
    ]);

    if (clicked) {
      console.log('[PageScript] acceptCall: clicked via CSS selector');
      return true;
    }

    // Strategy 3: CIF approach
    if (cifAvailable) {
      try {
        Microsoft.CIFramework.raiseEvent('BoseHeadsetAction', JSON.stringify({ action: 'accept' }));
        console.log('[PageScript] acceptCall: raised CIF event');
      } catch (_) { /* ignore */ }
    }

    // Auto DOM-dump for debugging — log every clickable element on page
    console.log('[PageScript] acceptCall: NO ACCEPT BUTTON FOUND — dumping all buttons/interactive elements:');
    const allClickable = document.querySelectorAll('button, [role="button"], [role="menuitem"], a[role="button"], [data-id], input[type="button"], input[type="submit"]');
    allClickable.forEach((el, i) => {
      const text = (el.textContent || '').trim().substring(0, 80);
      const label = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const dataId = el.getAttribute('data-id') || '';
      const cls = el.className?.toString?.()?.substring(0, 80) || '';
      const tag = el.tagName;
      const vis = el.offsetParent !== null ? 'visible' : 'hidden';
      console.log(`[DOM-DUMP] #${i} <${tag}> vis=${vis} text="${text}" aria-label="${label}" title="${title}" data-id="${dataId}" class="${cls}"`);
    });
    // Also scan iframes
    try {
      document.querySelectorAll('iframe').forEach((iframe, fi) => {
        try {
          const doc = iframe.contentDocument;
          if (!doc) return;
          const iframeBtns = doc.querySelectorAll('button, [role="button"], [role="menuitem"], a[role="button"], [data-id]');
          iframeBtns.forEach((el, i) => {
            const text = (el.textContent || '').trim().substring(0, 80);
            const label = el.getAttribute('aria-label') || '';
            const dataId = el.getAttribute('data-id') || '';
            const vis = el.offsetParent !== null ? 'visible' : 'hidden';
            console.log(`[DOM-DUMP] iframe#${fi} #${i} <${el.tagName}> vis=${vis} text="${text}" aria-label="${label}" data-id="${dataId}"`);
          });
        } catch (_) { /* cross-origin */ }
      });
    } catch (_) {}
    // Send diagnostic back so user can see this in logs
    sendToContentScript('ACTION_RESULT', {
      action: 'acceptCall',
      success: false,
      message: 'No Accept/Answer button found on page — check console for DOM dump',
    });
    return false;
  },

  rejectCall() {
    const btn = findButtonInFrames('decline', 'reject', 'recusar', 'rechazar', 'ablehnen', 'refuser', 'rifiuta');
    if (btn) { btn.click(); return true; }
    return clickButton([
      '[data-id*="reject" i]', '[data-id*="decline" i]',
      'button[aria-label*="Reject" i]', 'button[aria-label*="Decline" i]',
      'button[title*="Decline" i]', 'button[title*="Reject" i]',
    ]);
  },

  endCall() {
    const btn = findButtonInFrames('end call', 'hang up', 'end', 'encerrar', 'finalizar', 'auflegen', 'raccrocher');
    if (btn) { btn.click(); return true; }
    return clickButton([
      '[data-id*="end-call" i]', '[data-id*="EndCall" i]', '[data-id*="endcall" i]',
      'button[aria-label*="End call" i]', 'button[aria-label*="Hang up" i]',
      'button[aria-label*="End" i]',
      '.oc-end-call-button', 'button[title*="End call" i]', 'button[title*="End Call" i]',
    ]);
  },

  holdCall() {
    const btn = findButtonByText('hold');
    if (btn && !(btn.textContent || '').toLowerCase().includes('unhold') &&
        !(btn.getAttribute('aria-label') || '').toLowerCase().includes('unhold')) {
      btn.click();
      return true;
    }
    return clickButton([
      '[data-id*="hold"][aria-pressed="false"]',
      'button[aria-label="Hold"]', 'button[title="Hold"]',
    ]);
  },

  resumeCall() {
    const btn = findButtonByText('resume', 'unhold');
    if (btn) { btn.click(); return true; }
    return clickButton([
      '[data-id*="hold"][aria-pressed="true"]',
      'button[aria-label="Resume"]', 'button[aria-label*="Unhold"]', 'button[title="Resume"]',
    ]);
  },

  toggleMute(payload) {
    // Try text search first
    const muteBtn = findButtonByText('mute', 'unmute');
    if (muteBtn) {
      const isMuted = (muteBtn.getAttribute('aria-pressed') === 'true') ||
                      (muteBtn.getAttribute('aria-label') || '').toLowerCase().includes('unmute') ||
                      (muteBtn.textContent || '').toLowerCase().includes('unmute');
      if (payload?.muted !== undefined && payload.muted !== isMuted) {
        muteBtn.click();
        return true;
      } else if (payload?.muted === undefined) {
        muteBtn.click();
        return true;
      }
    }
    // CSS fallback
    const cssBtn = document.querySelector('[data-id*="mute-button"]') ||
                   document.querySelector('[data-id*="microphone"]') ||
                   document.querySelector('button[title*="Mute"]') ||
                   document.querySelector('button[title*="Unmute"]');
    if (cssBtn && !cssBtn.disabled) {
      cssBtn.click();
      return true;
    }
    return false;
  },

  volumeUp() {
    adjustVolume(0.1);
  },

  volumeDown() {
    adjustVolume(-0.1);
  },

  redial() {
    const btn = findButtonByText('redial');
    if (btn) { btn.click(); return true; }
    return clickButton([
      'button[aria-label*="Redial"]', 'button[title*="Redial"]', '[data-id*="redial"]',
    ]);
  },

  // Diagnostic: scan the DOM and report what interactive elements exist
  scanDOM() {
    const results = {
      buttons: [],
      iframeCount: document.querySelectorAll('iframe').length,
      cifAvailable,
      url: window.location.href,
    };

    const candidates = document.querySelectorAll(
      'button, [role="button"], [role="menuitem"]'
    );

    candidates.forEach(el => {
      const text = (el.textContent || '').trim().substring(0, 80);
      const label = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const dataId = el.getAttribute('data-id') || '';
      const visible = el.offsetParent !== null || el.offsetWidth > 0;
      const tagName = el.tagName.toLowerCase();
      // Only include elements with some text content
      if (text || label || title || dataId) {
        results.buttons.push({ tagName, text, label, title, dataId, visible });
      }
    });

    // Limit to 60 most relevant
    results.buttons = results.buttons.slice(0, 60);

    console.log('[PageScript] DOM Scan results:', results);
    sendToContentScript('DOM_SCAN_RESULT', results);
    return true;
  },
};

function adjustVolume(delta) {
  const audioElements = document.querySelectorAll('audio, video');
  audioElements.forEach(el => {
    el.volume = Math.max(0, Math.min(1, el.volume + delta));
  });
}

// ── Listen for commands from content script ──

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.bridge !== BRIDGE_PREFIX) return;
  if (event.data.direction !== 'content-to-page') return;

  const { type, payload } = event.data;

  if (type === 'BOSE_D365_ACTION') {
    const action = payload?.action;
    if (action && ACTIONS[action]) {
      const result = ACTIONS[action](payload?.payload);
      console.log(`[PageScript] Action ${action}: ${result ? 'success' : 'no button found'}`);
    }
  }
});

// ── CIF initialization with retry ──

let cifRetries = 0;
const MAX_CIF_RETRIES = 30;
const CIF_RETRY_INTERVAL = 2000;

function tryCifInit() {
  if (initCIF()) {
    console.log('[PageScript] CIF initialized successfully');
    return;
  }
  cifRetries++;
  if (cifRetries < MAX_CIF_RETRIES) {
    setTimeout(tryCifInit, CIF_RETRY_INTERVAL);
  } else {
    console.log('[PageScript] CIF not available — using DOM observation only');
  }
}

tryCifInit();

console.log('[PageScript] Dynamics Audio Companion page bridge loaded');
