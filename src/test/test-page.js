import { MSG, SOURCE } from '../shared/messages.js';
import { HID_FILTERS, isSupportedVendor, identifyDeviceModel } from '../shared/bose-hid-protocol.js';

const logPanel = document.getElementById('event-log');
const deviceDetails = document.getElementById('device-details');
const testResults = document.getElementById('test-results');

function log(msg, cls = 'info') {
  const ts = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = `log-entry log-${cls}`;
  div.textContent = `[${ts}] ${msg}`;
  logPanel.appendChild(div);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function deviceLog(msg) {
  deviceDetails.textContent += msg + '\n';
  deviceDetails.scrollTop = deviceDetails.scrollHeight;
}

// ── Status refresh ──

async function refreshStatus() {
  // WebHID
  const webhid = !!navigator.hid;
  document.getElementById('stat-webhid').textContent = webhid ? 'Available' : 'Not available';
  document.getElementById('stat-webhid').className = `status-value ${webhid ? 'ok' : 'err'}`;

  // Service worker status
  try {
    const resp = await chrome.runtime.sendMessage({ source: SOURCE.POPUP, type: MSG.GET_STATUS });
    if (resp) {
      document.getElementById('stat-sw').textContent = 'Running';
      document.getElementById('stat-sw').className = 'status-value ok';

      document.getElementById('stat-device').textContent = resp.device
        ? `${resp.device.productName || resp.device.model}`
        : 'Not connected';
      document.getElementById('stat-device').className = `status-value ${resp.device ? 'ok' : 'warn'}`;

      document.getElementById('stat-d365').textContent = resp.d365Connected ? 'Connected' : 'No tab found';
      document.getElementById('stat-d365').className = `status-value ${resp.d365Connected ? 'ok' : 'warn'}`;

      document.getElementById('stat-call').textContent = resp.callState || 'Idle';
      document.getElementById('stat-mute').textContent = resp.muted ? 'ON' : 'OFF';
      document.getElementById('stat-mute').className = `status-value ${resp.muted ? 'err' : 'ok'}`;
    }
  } catch (err) {
    document.getElementById('stat-sw').textContent = 'Error';
    document.getElementById('stat-sw').className = 'status-value err';
    log(`SW status error: ${err.message}`, 'error');
  }
}

// ── HID Device test ──

document.getElementById('btn-pair').addEventListener('click', async () => {
  try {
    log('Requesting USB device via WebHID picker...', 'info');
    const devices = await navigator.hid.requestDevice({ filters: HID_FILTERS });
    if (devices.length === 0) {
      log('No device selected', 'warn');
      return;
    }
    const dev = devices[0];
    log(`Selected: ${dev.productName} (VID: 0x${dev.vendorId.toString(16)}, PID: 0x${dev.productId.toString(16)})`, 'success');

    deviceDetails.textContent = '';
    deviceLog(`Product: ${dev.productName}`);
    deviceLog(`Vendor ID:  0x${dev.vendorId.toString(16).toUpperCase()}`);
    deviceLog(`Product ID: 0x${dev.productId.toString(16).toUpperCase()}`);
    deviceLog(`Collections: ${dev.collections.length}`);
    for (const col of dev.collections) {
      deviceLog(`  Page: 0x${col.usagePage.toString(16)} Usage: 0x${col.usage.toString(16)} Inputs: ${col.inputReports?.length || 0} Outputs: ${col.outputReports?.length || 0}`);
    }

    // Tell service worker to connect via offscreen
    chrome.runtime.sendMessage({ source: SOURCE.POPUP, type: MSG.HID_REQUEST_CONNECT });
    log('Sent connect request to offscreen...', 'info');

    // Also open and listen directly for testing
    if (!dev.opened) await dev.open();
    dev.addEventListener('inputreport', (e) => {
      const bytes = [];
      for (let i = 0; i < e.data.byteLength; i++) bytes.push(e.data.getUint8(i).toString(16).padStart(2, '0'));
      log(`HID Input: reportId=${e.reportId} data=[${bytes.join(' ')}]`, 'event');
    });
    log('Direct HID listener active — press headset buttons!', 'success');

    setTimeout(refreshStatus, 1000);
  } catch (err) {
    log(`Pair error: ${err.message}`, 'error');
  }
});

document.getElementById('btn-list-devices').addEventListener('click', async () => {
  try {
    const devices = await navigator.hid.getDevices();
    deviceDetails.textContent = '';
    if (devices.length === 0) {
      deviceLog('No paired HID devices found');
      log('No paired devices', 'warn');
    } else {
      for (const dev of devices) {
        deviceLog(`${dev.productName} — VID: 0x${dev.vendorId.toString(16)} PID: 0x${dev.productId.toString(16)} Opened: ${dev.opened}`);
        log(`Found: ${dev.productName}`, 'info');
      }
    }
  } catch (err) {
    log(`List error: ${err.message}`, 'error');
  }
});

document.getElementById('btn-disconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: SOURCE.POPUP, type: MSG.HID_REQUEST_DISCONNECT });
  log('Disconnect request sent', 'info');
  setTimeout(refreshStatus, 500);
});

// ── Simulator buttons ──

const simActions = {
  hookOn:  { type: MSG.HID_HOOK_SWITCH, payload: { value: true } },
  hookOff: { type: MSG.HID_HOOK_SWITCH, payload: { value: false } },
  mute:    { type: MSG.HID_PHONE_MUTE,  payload: { value: true } },
  hold:    { type: MSG.HID_FLASH,        payload: {} },
  reject:  { type: MSG.HID_DROP,         payload: {} },
  volUp:   { type: MSG.HID_VOLUME_UP,    payload: {} },
  volDown: { type: MSG.HID_VOLUME_DOWN,  payload: {} },
  redial:  { type: MSG.HID_REDIAL,       payload: {} },
  drop:    { type: MSG.HID_DROP,         payload: {} },
};

document.querySelectorAll('.sim-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    const msg = simActions[action];
    if (!msg) return;

    // Send as if from offscreen (simulating the HID event)
    chrome.runtime.sendMessage({
      source: SOURCE.OFFSCREEN,
      type: msg.type,
      payload: msg.payload,
    });
    log(`Simulated: ${action} → ${msg.type}`, 'event');
  });
});

// ── LED test buttons ──

document.getElementById('led-offhook').addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: SOURCE.SERVICE_WORKER, type: MSG.SET_HEADSET_LED, payload: { offHook: true, ring: false, mute: false, hold: false } });
  log('LED: Off-Hook ON', 'info');
});

document.getElementById('led-ring').addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: SOURCE.SERVICE_WORKER, type: MSG.SET_HEADSET_LED, payload: { offHook: false, ring: true, mute: false, hold: false } });
  log('LED: Ring ON', 'info');
});

document.getElementById('led-mute').addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: SOURCE.SERVICE_WORKER, type: MSG.SET_HEADSET_LED, payload: { offHook: false, ring: false, mute: true, hold: false } });
  log('LED: Mute ON', 'info');
});

document.getElementById('led-hold').addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: SOURCE.SERVICE_WORKER, type: MSG.SET_HEADSET_LED, payload: { offHook: false, ring: false, mute: false, hold: true } });
  log('LED: Hold ON', 'info');
});

document.getElementById('led-all-off').addEventListener('click', () => {
  chrome.runtime.sendMessage({ source: SOURCE.SERVICE_WORKER, type: MSG.SET_HEADSET_LED, payload: { offHook: false, ring: false, mute: false, hold: false } });
  log('LED: All OFF', 'info');
});

// ── Automated tests ──

const TESTS = [
  {
    name: 'WebHID API available',
    fn: () => {
      if (!navigator.hid) throw new Error('WebHID not available in this browser');
      return 'navigator.hid exists';
    }
  },
  {
    name: 'Service worker responding',
    fn: async () => {
      const resp = await chrome.runtime.sendMessage({ source: SOURCE.POPUP, type: MSG.GET_STATUS });
      if (!resp) throw new Error('No response from service worker');
      return `SW responded with callState: ${resp.callState}`;
    }
  },
  {
    name: 'Offscreen document exists',
    fn: async () => {
      const exists = await chrome.offscreen.hasDocument();
      if (!exists) throw new Error('Offscreen document not created');
      return 'Offscreen document is running';
    }
  },
  {
    name: 'HID permissions (previously paired devices)',
    fn: async () => {
      const devices = await navigator.hid.getDevices();
      if (devices.length === 0) return { skip: true, msg: 'No paired devices — pair a USB headset first' };
      const supported = devices.find(d => isSupportedVendor(d.vendorId));
      if (!supported) return { skip: true, msg: 'Paired devices exist but none are supported (Bose/Jabra/Poly)' };
      return `USB HID device paired: ${supported.productName}`;
    }
  },
  {
    name: 'Bose HID protocol parser — telephony input',
    fn: async () => {
      const { parseTelephonyInput } = await import('../shared/bose-hid-protocol.js');
      const buf = new ArrayBuffer(1);
      const view = new DataView(buf);
      view.setUint8(0, 0b00000101); // hookSwitch=1, phoneMute=0, flash=1
      const result = parseTelephonyInput(view);
      if (!result.hookSwitch) throw new Error('hookSwitch should be true');
      if (result.phoneMute) throw new Error('phoneMute should be false');
      if (!result.flash) throw new Error('flash should be true');
      return 'Parser correctly decoded 0x05 → hookSwitch=true, flash=true';
    }
  },
  {
    name: 'Bose HID protocol parser — output report builder',
    fn: async () => {
      const { buildOutputReport } = await import('../shared/bose-hid-protocol.js');
      const report = buildOutputReport({ offHook: true, ring: false, mute: true, hold: false });
      if (report[0] !== 0b00000101) throw new Error(`Expected 0x05 got 0x${report[0].toString(16)}`);
      return 'Builder correctly encoded offHook=1,mute=1 → 0x05';
    }
  },
  {
    name: 'Message types integrity',
    fn: async () => {
      const { MSG } = await import('../shared/messages.js');
      const required = ['HID_HOOK_SWITCH', 'HID_PHONE_MUTE', 'HID_FLASH', 'HID_DROP',
        'CALL_STATE_CHANGED', 'MUTE_STATE_CHANGED', 'SET_HEADSET_LED', 'GET_STATUS'];
      for (const key of required) {
        if (!MSG[key]) throw new Error(`Missing MSG.${key}`);
      }
      return `All ${required.length} required message types present`;
    }
  },
  {
    name: 'Simulate hook switch → service worker routes',
    fn: async () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for status after sim')), 3000);
        chrome.runtime.sendMessage({ source: SOURCE.OFFSCREEN, type: MSG.HID_HOOK_SWITCH, payload: { value: true } });
        // Give the SW time to process
        setTimeout(async () => {
          try {
            const resp = await chrome.runtime.sendMessage({ source: SOURCE.POPUP, type: MSG.GET_STATUS });
            clearTimeout(timeout);
            resolve(`SW processed hook event, current state: ${resp?.callState}`);
          } catch (e) {
            clearTimeout(timeout);
            reject(e);
          }
        }, 500);
      });
    }
  },
];

document.getElementById('btn-run-tests').addEventListener('click', async () => {
  testResults.innerHTML = '';
  log('Running automated tests...', 'info');

  let pass = 0, fail = 0, skip = 0;

  for (const test of TESTS) {
    const div = document.createElement('div');
    try {
      const result = await test.fn();
      if (result && typeof result === 'object' && result.skip) {
        div.className = 'test-result test-skip';
        div.textContent = `⚠️ ${test.name}: ${result.msg}`;
        skip++;
      } else {
        div.className = 'test-result test-pass';
        div.textContent = `✅ ${test.name}: ${result}`;
        pass++;
      }
    } catch (err) {
      div.className = 'test-result test-fail';
      div.textContent = `❌ ${test.name}: ${err.message}`;
      fail++;
    }
    testResults.appendChild(div);
  }

  log(`Tests complete: ${pass} passed, ${fail} failed, ${skip} skipped`, fail > 0 ? 'error' : 'success');
});

// ── Listen for live events from service worker ──

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.STATUS_UPDATE) {
    refreshStatus();
    log(`Status update: device=${!!message.payload.device} call=${message.payload.callState} mute=${message.payload.muted}`, 'event');
  }
});

// ── Init ──

document.getElementById('btn-refresh').addEventListener('click', refreshStatus);
document.getElementById('btn-clear-log').addEventListener('click', () => { logPanel.innerHTML = ''; });

// ── Service Worker Diagnostic Log + DOM Scan ──

const swLogPanel = document.getElementById('sw-log');

function refreshSWLog() {
  chrome.runtime.sendMessage(
    { source: SOURCE.POPUP, type: MSG.GET_LOGS },
    (response) => {
      if (response && response.logs) {
        swLogPanel.innerHTML = response.logs.map(line => {
          const cls = (line.includes('ERROR') || line.includes('FAIL') || line.includes('disconnect'))
            ? 'log-error'
            : line.includes('KEY:')
            ? 'log-event'
            : line.includes('btn[')
            ? 'log-warn'
            : 'log-info';
          return `<div class="log-entry ${cls}">${escapeHtml(line)}</div>`;
        }).join('');
        swLogPanel.scrollTop = swLogPanel.scrollHeight;
      } else {
        swLogPanel.textContent = '(no logs yet — reload extension)';
      }
    }
  );
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.getElementById('btn-scan-dom').addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { source: SOURCE.POPUP, type: MSG.SCAN_DOM },
    () => {
      log('DOM scan triggered — results will appear in SW log', 'info');
      setTimeout(refreshSWLog, 2000);
    }
  );
});

document.getElementById('btn-refresh-sw-log').addEventListener('click', refreshSWLog);

refreshStatus();
refreshSWLog();
log('Diagnostics page loaded', 'success');
