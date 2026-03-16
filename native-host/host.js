#!/usr/bin/env node
/**
 * D365 Native Messaging Host
 * 
 * Captures headset button presses (which Windows translates to
 * global media key events via AVRCP/HFP) and relays them to the 
 * browser extension via Chrome Native Messaging protocol.
 * 
 * Supported headsets (any Bluetooth headset using AVRCP):
 * 
 * Bose 700 HP button mapping:
 *   Multi-function button → MEDIA_PLAY_PAUSE (answer/hangup)
 *   Volume Up             → VOLUME_UP
 *   Volume Down           → VOLUME_DOWN
 *   ANC button            → (handled locally on headset)
 * 
 * Apple AirPods / AirPods Pro button mapping:
 *   Stem press (single)   → MEDIA_PLAY_PAUSE (answer/hangup)
 *   Stem press (double)   → MEDIA_NEXT (next track / hold-resume)
 *   Stem press (triple)   → MEDIA_PREV (prev track / redial)
 *   Stem press & hold     → (noise control, handled locally)
 * 
 * Chrome Native Messaging protocol:
 *   - stdin:  receives JSON messages from extension (4-byte length prefix + JSON)
 *   - stdout: sends JSON messages to extension (4-byte length prefix + JSON)
 */

const { GlobalKeyboardListener } = require('node-global-key-listener');
const path = require('path');

// ── Resolve WinKeyServer.exe path ──
// WinKeyServer.exe ships alongside host.js in the native-host folder.
const keyListenerConfig = {
  windows: { serverPath: path.join(__dirname, 'WinKeyServer.exe') }
};

// ── Native Messaging I/O ──

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.alloc(4 + Buffer.byteLength(json, 'utf8'));
  buf.writeUInt32LE(Buffer.byteLength(json, 'utf8'), 0);
  buf.write(json, 4, 'utf8');
  process.stdout.write(buf);
}

function readMessage() {
  return new Promise((resolve) => {
    let headerBuf = Buffer.alloc(0);

    function onData(chunk) {
      headerBuf = Buffer.concat([headerBuf, chunk]);

      // Read 4-byte length header
      if (headerBuf.length >= 4) {
        const len = headerBuf.readUInt32LE(0);
        const totalNeeded = 4 + len;

        if (headerBuf.length >= totalNeeded) {
          const jsonStr = headerBuf.slice(4, totalNeeded).toString('utf8');
          headerBuf = headerBuf.slice(totalNeeded);
          process.stdin.removeListener('data', onData);
          try {
            resolve(JSON.parse(jsonStr));
          } catch {
            resolve(null);
          }
        }
      }
    }

    process.stdin.on('data', onData);
  });
}

// ── State ──

let callState = 'idle'; // idle, ringing, active, hold
let muted = false;
let listening = true;

// ── Key Mapping ──
// Standard AVRCP media keys — sent by Bose, AirPods, and other BT headsets:

const MEDIA_KEY_MAP = {
  // node-global-key-listener key names for media keys
  'MEDIA PLAY/PAUSE':  'hookSwitch',
  'MEDIA_PLAY_PAUSE':  'hookSwitch',
  'MEDIA PLAY PAUSE':  'hookSwitch',
  'MEDIA_PLAY/PAUSE':  'hookSwitch',
  'PLAY/PAUSE MEDIA':  'hookSwitch',
  'MEDIA STOP':        'drop',
  'MEDIA_STOP':        'drop',
  'VOLUME UP':         'volumeUp',
  'VOLUME_UP':         'volumeUp',
  'VOLUME DOWN':       'volumeDown',
  'VOLUME_DOWN':       'volumeDown',
  'VOLUME MUTE':       'mute',
  'VOLUME_MUTE':       'mute',
  'MUTE':              'mute',
  'MEDIA NEXT':        'flash',     // Bose: N/A | AirPods: double-press → hold/resume
  'MEDIA_NEXT':        'flash',
  'MEDIA NEXT TRACK':  'flash',
  'MEDIA PREV':        'redial',    // Bose: N/A | AirPods: triple-press → redial
  'MEDIA_PREV':        'redial',
  'MEDIA PREV TRACK':  'redial',
};

// Virtual key codes for fallback matching
const VK_MAP = {
  0xB3: 'hookSwitch',   // VK_MEDIA_PLAY_PAUSE
  0xB2: 'drop',         // VK_MEDIA_STOP
  0xAF: 'volumeUp',     // VK_VOLUME_UP
  0xAE: 'volumeDown',   // VK_VOLUME_DOWN
  0xAD: 'mute',         // VK_VOLUME_MUTE
  0xB0: 'flash',        // VK_MEDIA_NEXT_TRACK
  0xB1: 'redial',       // VK_MEDIA_PREV_TRACK
};

// ── Keyboard Listener ──

// Double-click detection for hookSwitch (play/pause button)
const DOUBLE_CLICK_MS = 400; // Max gap between clicks to count as double-click
let hookClickTimer = null;
let hookClickCount = 0;

function dispatchHookAction(clickCount) {
  let d365Action = null;

  if (clickCount >= 2) {
    // Double-click during active/hold: end call
    if (callState === 'active' || callState === 'hold') {
      d365Action = 'endCall';
    }
  } else {
    // Single click during active/hold: toggle mute
    if (callState === 'active' || callState === 'hold') {
      muted = !muted;
      d365Action = 'toggleMute';
    }
  }

  if (d365Action) {
    sendMessage({
      type: 'HEADSET_ACTION',
      action: d365Action,
      source: 'native-host',
      key: 'HOOK_' + (clickCount >= 2 ? 'DOUBLE' : 'SINGLE'),
      timestamp: Date.now(),
    });
  }
}

const keyboard = new GlobalKeyboardListener(keyListenerConfig);

keyboard.addListener((event, down) => {
  if (!listening) return;
  if (event.state !== 'DOWN') return; // Only on key down

  // Try name-based mapping first
  const keyName = (event.name || '').toUpperCase();
  let action = MEDIA_KEY_MAP[keyName];

  // Fallback to vKey code
  if (!action && event.vKey) {
    action = VK_MAP[event.vKey];
  }

  // Also try rawKey
  if (!action && event.rawKey) {
    const rawName = (typeof event.rawKey === 'string' ? event.rawKey : '').toUpperCase();
    action = MEDIA_KEY_MAP[rawName];
  }

  // Log every media key we see (for debugging)
  if (action) {
    sendMessage({
      type: 'DEBUG_KEY',
      key: keyName,
      vKey: event.vKey,
      rawKey: event.rawKey,
      mappedAction: action,
      callState,
      muted,
      timestamp: Date.now(),
    });
  }

  if (!action) return;

  // Map action to specific D365 call control based on current call state
  let d365Action = null;

  switch (action) {
    case 'hookSwitch':
      if (callState === 'ringing' || callState === 'idle') {
        // Accept immediately — no delay
        d365Action = 'acceptCall';
        break;
      }
      // During active/hold: use double-click detection (single=mute, double=end)
      hookClickCount++;
      if (hookClickTimer) clearTimeout(hookClickTimer);
      hookClickTimer = setTimeout(() => {
        dispatchHookAction(hookClickCount);
        hookClickCount = 0;
        hookClickTimer = null;
      }, DOUBLE_CLICK_MS);
      return true; // Consume key immediately so Spotify/other apps don't receive it

    case 'drop':
      if (callState === 'ringing') {
        d365Action = 'rejectCall';
      } else if (callState === 'active' || callState === 'hold') {
        d365Action = 'endCall';
      } else {
        return;
      }
      break;

    case 'mute':
      if (callState === 'active' || callState === 'hold') {
        muted = !muted;
        d365Action = 'toggleMute';
      } else {
        return; // Let system handle volume mute
      }
      break;

    case 'flash':
      // Next Track — sent by AirPods double-tap (firmware), or Next Track button
      // Ringing: accept. Active/Hold: end call.
      if (callState === 'ringing' || callState === 'idle') {
        d365Action = 'acceptCall';
      } else if (callState === 'active' || callState === 'hold') {
        d365Action = 'endCall';
      }
      break;

    case 'volumeUp':
      d365Action = 'volumeUp';
      break;

    case 'volumeDown':
      d365Action = 'volumeDown';
      break;

    case 'redial':
      // Previous Track — sent by AirPods triple-tap (firmware)
      // Active: hold. Hold: resume. Idle: redial.
      if (callState === 'active') {
        d365Action = 'holdCall';
      } else if (callState === 'hold') {
        d365Action = 'resumeCall';
      } else if (callState === 'idle') {
        d365Action = 'redial';
      }
      break;
  }

  if (d365Action) {
    sendMessage({
      type: 'HEADSET_ACTION',
      action: d365Action,
      source: 'native-host',
      key: keyName,
      timestamp: Date.now(),
    });

    // During active/hold: consume the key so Spotify/other apps don't receive it.
    // During ringing/idle: let the key pass through so Media Session also fires
    // as a redundant backup path for accept-call.
    if (callState === 'active' || callState === 'hold') {
      return true;
    }
  }
});

// ── Listen for messages from extension ──

async function messageLoop() {
  while (true) {
    const msg = await readMessage();
    if (!msg) {
      // stdin closed — extension disconnected
      process.exit(0);
    }

    switch (msg.type) {
      case 'CALL_STATE_UPDATE':
        callState = msg.callState || 'idle';
        muted = msg.muted || false;
        break;

      case 'PING':
        sendMessage({ type: 'PONG', timestamp: Date.now() });
        break;

      case 'SET_LISTENING':
        listening = msg.enabled !== false;
        break;

      case 'SHUTDOWN':
        process.exit(0);
        break;

      default:
        sendMessage({ type: 'ERROR', message: `Unknown message type: ${msg.type}` });
    }
  }
}

// ── Init ──

// Send ready message
sendMessage({
  type: 'READY',
  version: '1.11.2',
  platform: process.platform,
  timestamp: Date.now(),
});

// Start message loop
messageLoop().catch((err) => {
  sendMessage({ type: 'ERROR', message: err.message });
  process.exit(1);
});

// Handle exit
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err) => {
  try {
    sendMessage({ type: 'ERROR', message: `Uncaught: ${err.message}` });
  } catch (_) { /* ignore */ }
  process.exit(1);
});
