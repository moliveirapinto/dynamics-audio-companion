/**
 * Service Worker (Background Script)
 * 
 * Central message router between:
 * - Offscreen document (WebHID ↔ USB headsets)
 * - Content scripts (D365 pages)
 * - Popup UI
 * - Native host (Bluetooth headset media key capture)
 * 
 * Supports Bose, Jabra, Poly/Plantronics, Yealink, Apple AirPods, and other headsets.
 * Also manages extension state and offscreen document lifecycle.
 */

import { MSG, SOURCE, CALL_STATE } from '../shared/messages.js';
import { getFriendlyName } from '../shared/bose-hid-protocol.js';

// ── Diagnostic log buffer (kept in memory, shown in popup) ──
const LOG_MAX = 100;
const logBuffer = [];
function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = `[${ts}] ${msg}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  console.log('[SW]', msg);
}

// ── Global state ──
const state = {
  device: null,          // { model, productName, vendorId, productId }
  callState: CALL_STATE.IDLE,
  muted: false,
  d365TabId: null,       // active D365 tab
  offscreenReady: false,
  nativeHostConnected: false,
  connectionMode: null,  // 'usb' | 'bluetooth' | null
  lastDeviceError: null, // error message from last connection attempt
};

// ── Native Messaging Host (for Bluetooth headsets) ──

const NATIVE_HOST_NAME = 'com.bose.d365.headset';
let nativePort = null;
let nativeReconnectTimer = null;
let nativePortGeneration = 0; // Track port identity to prevent stale callbacks

function connectNativeHost() {
  // If already connected and healthy, just broadcast status
  if (nativePort && state.nativeHostConnected) {
    log('connectNativeHost() — already connected');
    broadcastStatus();
    return;
  }

  // If a port is connecting (exists but READY not received yet), don't recreate
  if (nativePort && !state.nativeHostConnected) {
    log('connectNativeHost() — port connecting, waiting for READY...');
    return;
  }

  // Cancel any pending reconnect timer
  clearTimeout(nativeReconnectTimer);

  // Increment generation so any old port's callbacks become no-ops
  const gen = ++nativePortGeneration;

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    log('connectNativeHost() → connecting (gen=' + gen + ')...');

    nativePort.onMessage.addListener((msg) => {
      if (gen !== nativePortGeneration) return; // Stale port — ignore

      log('Native host msg: ' + JSON.stringify(msg));

      switch (msg.type) {
        case 'READY':
          state.nativeHostConnected = true;
          state.connectionMode = state.connectionMode || 'bluetooth';
          state.lastDeviceError = null;
          state.device = state.device || {
            model: 'BT_HEADSET',
            productName: 'Bluetooth Headset (via Native Host)',
          };
          log('Native host READY v' + msg.version);
          syncNativeHostState();
          broadcastStatus();
          break;

        case 'HEADSET_ACTION':
          log(`Headset button: ${msg.action} (key=${msg.key}, callState=${state.callState})`);
          handleNativeAction(msg.action);
          break;

        case 'DEBUG_KEY':
          log(`KEY: "${msg.key}" vk=0x${(msg.vKey||0).toString(16)} → ${msg.mappedAction} (host sees callState=${msg.callState})`);
          break;

        case 'PONG':
          break;

        case 'ERROR':
          log('Native host ERROR: ' + msg.message);
          break;
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError;
      if (gen !== nativePortGeneration) {
        // This is an old port — don't touch current state
        return;
      }
      log('Native host DISCONNECTED: ' + (lastError?.message || 'unknown'));
      nativePort = null;
      state.nativeHostConnected = false;
      if (state.connectionMode === 'bluetooth') {
        state.device = null;
        state.connectionMode = null;
      }
      broadcastStatus();

      // Auto-reconnect after 5 seconds
      clearTimeout(nativeReconnectTimer);
      nativeReconnectTimer = setTimeout(() => {
        log('Attempting native host reconnect...');
        connectNativeHost();
      }, 5000);
    });

  } catch (err) {
    log('FAILED to connect native host: ' + err.message);
    nativePort = null;
  }
}

function disconnectNativeHost() {
  clearTimeout(nativeReconnectTimer);
  if (nativePort) {
    try {
      nativePort.postMessage({ type: 'SHUTDOWN' });
      nativePort.disconnect();
    } catch (_) { /* ignore */ }
    nativePort = null;
    state.nativeHostConnected = false;
    if (state.connectionMode === 'bluetooth') {
      state.device = null;
      state.connectionMode = null;
    }
  }
}

function syncNativeHostState() {
  if (nativePort) {
    try {
      log(`Syncing to native host: callState=${state.callState} muted=${state.muted}`);
      nativePort.postMessage({
        type: 'CALL_STATE_UPDATE',
        callState: state.callState,
        muted: state.muted,
      });
    } catch (_) { /* ignore if disconnected */ }
  }
}

function handleNativeAction(action) {
  log(`Native action: ${action} (callState: ${state.callState})`);

  switch (action) {
    case 'acceptCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'acceptCall' });
      break;
    case 'rejectCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'rejectCall' });
      break;
    case 'endCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'endCall' });
      break;
    case 'toggleMute':
      state.muted = !state.muted;
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'toggleMute', payload: { muted: state.muted } });
      syncHeadsetLeds();
      syncNativeHostState();
      broadcastStatus();
      break;
    case 'holdCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'holdCall' });
      break;
    case 'resumeCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'resumeCall' });
      break;
    case 'volumeUp':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'volumeUp' });
      break;
    case 'volumeDown':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'volumeDown' });
      break;
    case 'redial':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'redial' });
      break;
  }
}

// ── Media Session capture control ──
// Tells offscreen to start/stop capturing media keys based on call state.
// During ringing/active calls → capture keys for headset control.
// During idle → release keys so normal media apps work.

function syncMediaCapture() {
  if (state.callState === CALL_STATE.RINGING ||
      state.callState === CALL_STATE.ACTIVE ||
      state.callState === CALL_STATE.HOLD) {
    sendToOffscreen(MSG.START_MEDIA_CAPTURE, {
      callState: state.callState,
      muted: state.muted,
    });
    if (!state.device) {
      // No USB device — mark as Bluetooth mode via media session
      state.connectionMode = 'media-session';
      state.device = {
        model: 'BT_HEADSET',
        productName: 'Bluetooth Headset',
      };
    }
  } else {
    sendToOffscreen(MSG.STOP_MEDIA_CAPTURE, {});
    if (state.connectionMode === 'media-session') {
      state.device = null;
      state.connectionMode = null;
    }
  }
}

function handleMediaKeyAction(action) {
  switch (action) {
    case 'acceptCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'acceptCall' });
      break;
    case 'rejectCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'rejectCall' });
      break;
    case 'endCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'endCall' });
      break;
    case 'toggleMute':
      state.muted = !state.muted;
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'toggleMute', payload: { muted: state.muted } });
      syncHeadsetLeds();
      broadcastStatus();
      break;
    case 'holdCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'holdCall' });
      break;
    case 'resumeCall':
      sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'resumeCall' });
      break;
  }
}

// ── Offscreen document management ──

let offscreenCreating = null;

async function ensureOffscreen() {
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    try {
      const existing = await chrome.offscreen.hasDocument();
      if (!existing) {
        await chrome.offscreen.createDocument({
          url: 'src/offscreen/offscreen.html',
          reasons: ['AUDIO_PLAYBACK'],
          justification: 'WebHID communication and Media Session capture for headset call control',
        });
        log('Offscreen document created');
      }
    } finally {
      offscreenCreating = null;
    }
  })();
  return offscreenCreating;
}

// Create offscreen on install/startup
chrome.runtime.onInstalled.addListener(() => {
  log('Extension installed');
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});

// Also ensure on service worker activation
ensureOffscreen();

// Auto-detect D365 tabs on startup
findD365Tab().then(tab => {
  if (tab) {
    state.d365TabId = tab.id;
    log('D365 tab found on startup: ' + tab.id);
  }
});

// Auto-connect to headset if already paired (USB)
// Wait a bit so native host (BT) has time to connect first
ensureOffscreen().then(() => {
  setTimeout(() => {
    if (!state.nativeHostConnected) {
      log('No native host yet — trying USB auto-connect');
      sendToOffscreen(MSG.HID_REQUEST_CONNECT, {});
    } else {
      log('Native host already connected — skipping USB auto-connect');
    }
  }, 2000);
});

// Auto-connect native host for Bluetooth headset support
log('Startup: auto-connecting native host...');
connectNativeHost();

// ── Find D365 tab ──

async function findD365Tab() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://*.dynamics.com/*',
      'https://*.crm.dynamics.com/*',
      'https://*.crm2.dynamics.com/*',
      'https://*.crm3.dynamics.com/*',
      'https://*.crm4.dynamics.com/*',
      'https://*.crm5.dynamics.com/*',
      'https://*.crm6.dynamics.com/*',
      'https://*.crm7.dynamics.com/*',
      'https://*.crm8.dynamics.com/*',
      'https://*.crm9.dynamics.com/*',
      'https://*.crm10.dynamics.com/*',
      'https://*.crm11.dynamics.com/*',
    ]
  });
  return tabs.length > 0 ? tabs[0] : null;
}

async function sendToD365(type, payload) {
  try {
    let tab = state.d365TabId ? await chrome.tabs.get(state.d365TabId).catch(() => null) : null;
    if (!tab) {
      tab = await findD365Tab();
    }
    if (!tab) {
      log('No D365 tab found');
      return;
    }
    state.d365TabId = tab.id;
    try {
      await chrome.tabs.sendMessage(tab.id, { source: SOURCE.SERVICE_WORKER, type, payload });
    } catch (sendErr) {
      // Content script not loaded — inject it programmatically, then retry
      log('Content script not loaded in D365 tab — injecting...');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/content/content-script.js'],
        });
        log('Content script injected, retrying message...');
        // Small delay for script to initialize
        await new Promise(r => setTimeout(r, 500));
        await chrome.tabs.sendMessage(tab.id, { source: SOURCE.SERVICE_WORKER, type, payload });
      } catch (injectErr) {
        log('Failed to inject content script: ' + injectErr.message);
      }
    }
  } catch (err) {
    log('Error sending to D365: ' + err.message);
  }
}

async function sendToOffscreen(type, payload) {
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ source: SOURCE.SERVICE_WORKER, type, payload });
  } catch (err) {
    log('Error sending to offscreen: ' + err.message);
  }
}

function broadcastStatus() {
  const status = {
    device: state.device,
    callState: state.callState,
    muted: state.muted,
    d365Connected: !!state.d365TabId,
    nativeHostConnected: state.nativeHostConnected,
    connectionMode: state.connectionMode,
    lastDeviceError: state.lastDeviceError,
    btReady: !!state.d365TabId, // BT media session works when D365 tab exists
  };
  // Broadcast to all extension views (popup, etc.)
  chrome.runtime.sendMessage({
    source: SOURCE.SERVICE_WORKER,
    type: MSG.STATUS_UPDATE,
    payload: status,
  }).catch(() => {}); // Ignore if no listeners
}

/**
 * Update headset LEDs based on current call state.
 */
function syncHeadsetLeds() {
  const ledState = {
    offHook: state.callState === CALL_STATE.ACTIVE || state.callState === CALL_STATE.HOLD,
    ring:    state.callState === CALL_STATE.RINGING,
    mute:    state.muted,
    hold:    state.callState === CALL_STATE.HOLD,
  };
  sendToOffscreen(MSG.SET_HEADSET_LED, ledState);
}

// ── Message routing ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { source, type, payload } = message;

  // ── From offscreen (HID events) ──
  if (source === SOURCE.OFFSCREEN) {
    switch (type) {
      case MSG.OFFSCREEN_READY:
        state.offscreenReady = true;
        log('Offscreen ready');
        break;

      case MSG.HID_DEVICE_CONNECTED:
        state.device = {
          ...payload,
          friendlyName: getFriendlyName(payload.model),
        };
        state.connectionMode = 'usb';
        state.lastDeviceError = null;
        log(`USB headset connected: ${state.device.friendlyName} (${payload.productName})`);
        broadcastStatus();
        syncHeadsetLeds();
        break;

      case MSG.HID_DEVICE_DISCONNECTED:
        // If native host (BT) is connected, ignore USB HID disconnect entirely
        if (state.nativeHostConnected && state.connectionMode === 'bluetooth') {
          log('Ignoring USB HID disconnect — BT native host active');
          break;
        }
        if (state.connectionMode === 'usb') {
          state.device = null;
          state.connectionMode = null;
        }
        // Only set error if we don't have an active connection via another mode
        if (!state.device && !state.nativeHostConnected) {
          state.lastDeviceError = payload?.message || null;
        }
        log('HID disconnected: ' + (payload?.reason || '') + ' ' + (payload?.message || ''));
        broadcastStatus();
        break;

      case MSG.HID_HOOK_SWITCH:
        if (payload.momentary) {
          // Momentary hook (Poly/Jabra): decide action based on call state
          if (state.callState === CALL_STATE.RINGING) {
            sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'acceptCall' });
          } else if (state.callState === CALL_STATE.ACTIVE || state.callState === CALL_STATE.HOLD) {
            sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'endCall' });
          }
        } else {
          // Stateful hook (Bose): off-hook=accept, on-hook=end
          if (payload.value) {
            if (state.callState === CALL_STATE.RINGING || state.callState === CALL_STATE.IDLE) {
              sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'acceptCall' });
            }
          } else {
            if (state.callState === CALL_STATE.ACTIVE || state.callState === CALL_STATE.HOLD) {
              sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'endCall' });
            } else if (state.callState === CALL_STATE.RINGING) {
              sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'rejectCall' });
            }
          }
        }
        break;

      case MSG.HID_PHONE_MUTE:
        if (payload.momentary) {
          // Momentary mute (Poly/Jabra): toggle
          state.muted = !state.muted;
        } else {
          // Stateful mute (Bose): set directly
          state.muted = payload.value;
        }
        sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'toggleMute', payload: { muted: state.muted } });
        syncHeadsetLeds();
        broadcastStatus();
        break;

      case MSG.HID_FLASH:
        // Flash = hold/resume toggle
        if (state.callState === CALL_STATE.ACTIVE) {
          sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'holdCall' });
        } else if (state.callState === CALL_STATE.HOLD) {
          sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'resumeCall' });
        }
        break;

      case MSG.HID_DROP:
        sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'endCall' });
        break;

      case MSG.HID_REDIAL:
        sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'redial' });
        break;

      case MSG.HID_VOLUME_UP:
        sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'volumeUp' });
        break;

      case MSG.HID_VOLUME_DOWN:
        sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'volumeDown' });
        break;

      // ── Media Session (Bluetooth headset media keys) ──
      case MSG.MEDIA_KEY_ACTION:
        log(`Media key action: ${payload.action} (callState: ${state.callState})`);
        handleMediaKeyAction(payload.action);
        break;
    }
  }

  // ── From content script (D365 state changes) ──
  if (source === SOURCE.CONTENT_SCRIPT) {
    switch (type) {
      case MSG.CALL_STATE_CHANGED:
        state.callState = payload.state;
        state.d365TabId = sender.tab?.id ?? state.d365TabId;
        log(`Call state changed: ${state.callState}`);
        syncHeadsetLeds();
        syncNativeHostState();
        syncMediaCapture();
        broadcastStatus();
        break;

      case MSG.MUTE_STATE_CHANGED:
        state.muted = payload.muted;
        syncHeadsetLeds();
        syncNativeHostState();
        syncMediaCapture();
        broadcastStatus();
        break;

      case 'DOM_SCAN_RESULT':
        log('DOM SCAN from ' + (payload.url || 'unknown'));
        log('  iframes: ' + payload.iframeCount + ', CIF: ' + payload.cifAvailable);
        if (payload.buttons?.length) {
          payload.buttons.forEach((b, i) => {
            const parts = [b.text, b.label, b.title, b.dataId].filter(Boolean);
            log(`  btn[${i}]: <${b.tagName}> ${parts.join(' | ')} ${b.visible ? '' : '(hidden)'}`);
          });
        } else {
          log('  No buttons found on page');
        }
        break;

      case 'ACTION_RESULT':
        log(`Action ${payload.action}: ${payload.success ? 'OK' : 'FAILED'} — ${payload.message || ''}`);
        break;
    }
  }

  // ── From popup ──
  if (source === SOURCE.POPUP) {
    switch (type) {
      case MSG.HID_REQUEST_CONNECT:
        // Try USB (offscreen) first, then also try native host for BT
        sendToOffscreen(MSG.HID_REQUEST_CONNECT, {});
        connectNativeHost();
        sendResponse({ ok: true });
        return false;

      case MSG.NATIVE_HOST_CONNECT:
        connectNativeHost();
        sendResponse({ ok: true, nativeHostConnected: state.nativeHostConnected });
        return false;

      case MSG.HID_REQUEST_DISCONNECT:
        sendToOffscreen(MSG.HID_REQUEST_DISCONNECT, {});
        sendResponse({ ok: true });
        return false;

      case MSG.GET_STATUS:
        // Actively scan for D365 tabs instead of relying on cached id
        findD365Tab().then(tab => {
          if (tab) state.d365TabId = tab.id;
          else state.d365TabId = null;
          sendResponse({
            device: state.device,
            callState: state.callState,
            muted: state.muted,
            d365Connected: !!state.d365TabId,
            connectionMode: state.connectionMode,
            lastDeviceError: state.lastDeviceError,
          });
        });
        return true; // async sendResponse

      case MSG.GET_LOGS:
        sendResponse({ logs: logBuffer.slice() });
        return false;

      case MSG.SCAN_DOM:
        // Ask content script in D365 tab to scan the DOM
        log('Triggering DOM scan...');
        sendToD365(MSG.PAGE_BRIDGE_ACTION, { action: 'scanDOM' });
        sendResponse({ ok: true });
        return false;
    }
  }
});

// ── Tab management ──

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.d365TabId) {
    state.d365TabId = null;
    state.callState = CALL_STATE.IDLE;
    state.muted = false;
    syncHeadsetLeds();
    syncMediaCapture();
    broadcastStatus();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && /\.dynamics\.com/.test(tab.url)) {
    state.d365TabId = tabId;
  }
});

log('Service worker loaded');
