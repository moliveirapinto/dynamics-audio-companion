/**
 * Shared message types for communication between extension components.
 * Offscreen ↔ Service Worker ↔ Content Script ↔ Page Script
 */

// ── HID → D365 (headset button press → call action) ──
export const MSG = {
  // From offscreen (HID events)
  HID_HOOK_SWITCH:  'HID_HOOK_SWITCH',   // { value: bool } — answer/end call
  HID_PHONE_MUTE:   'HID_PHONE_MUTE',    // { value: bool } — toggle mute
  HID_FLASH:        'HID_FLASH',          // {} — hold/resume toggle
  HID_DROP:         'HID_DROP',           // {} — drop/end call
  HID_REDIAL:       'HID_REDIAL',        // {} — redial
  HID_VOLUME_UP:    'HID_VOLUME_UP',     // {} — volume up
  HID_VOLUME_DOWN:  'HID_VOLUME_DOWN',   // {} — volume down

  // From D365 content script (call state changes)
  CALL_STATE_CHANGED: 'CALL_STATE_CHANGED',  // { state: 'idle'|'ringing'|'active'|'hold' }
  MUTE_STATE_CHANGED: 'MUTE_STATE_CHANGED',  // { muted: bool }

  // LED sync (service worker → offscreen)
  SET_HEADSET_LED:  'SET_HEADSET_LED',    // { offHook, ring, mute, hold }

  // Device connection management
  HID_DEVICE_CONNECTED:    'HID_DEVICE_CONNECTED',    // { model, productName }
  HID_DEVICE_DISCONNECTED: 'HID_DEVICE_DISCONNECTED', // {}
  HID_REQUEST_CONNECT:     'HID_REQUEST_CONNECT',     // {} — user requests device pairing
  HID_REQUEST_DISCONNECT:  'HID_REQUEST_DISCONNECT',  // {} — user requests disconnect
  NATIVE_HOST_CONNECT:     'NATIVE_HOST_CONNECT',     // {} — try connecting native host for BT

  // Status queries
  GET_STATUS:    'GET_STATUS',    // {} → returns full state
  STATUS_UPDATE: 'STATUS_UPDATE', // { device, callState, muted, d365Connected }
  GET_LOGS:      'GET_LOGS',      // {} → returns diagnostic log entries
  SCAN_DOM:      'SCAN_DOM',      // {} → trigger DOM scan in D365 tab for diagnostics

  // Content script → page script bridge (via window.postMessage)
  PAGE_BRIDGE_ACTION: 'BOSE_D365_ACTION',  // { action, payload }
  PAGE_BRIDGE_STATE:  'BOSE_D365_STATE',   // { state, payload }

  // Media Session (Bluetooth headset media key capture)
  MEDIA_KEY_ACTION:      'MEDIA_KEY_ACTION',       // { action } — media key mapped to call action
  START_MEDIA_CAPTURE:   'START_MEDIA_CAPTURE',     // {} — start capturing media keys
  STOP_MEDIA_CAPTURE:    'STOP_MEDIA_CAPTURE',      // {} — stop capturing media keys

  // Offscreen lifecycle
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  OFFSCREEN_PING:  'OFFSCREEN_PING',
};

// Call states
export const CALL_STATE = {
  IDLE:    'idle',
  RINGING: 'ringing',
  ACTIVE:  'active',
  HOLD:    'hold',
};

// Source identifiers for message routing
export const SOURCE = {
  OFFSCREEN:      'offscreen',
  SERVICE_WORKER: 'service-worker',
  CONTENT_SCRIPT: 'content-script',
  PAGE_SCRIPT:    'page-script',
  POPUP:          'popup',
};
