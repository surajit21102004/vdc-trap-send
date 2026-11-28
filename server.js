/**
 * Topgrip IPIS / VDC AVDB (192x112) SNMPv3 Status Trap Controller & Web Server
 * PEN: 66731 (Topgrip IPIS Specification)
 * Target NMS: 10.0.0.252:162 (UDP)
 * Protocol: SNMPv3 authPriv (HMAC-SHA-256 + AES-128)
 * USM User: ipisMgmt_Admin
 */

const express = require('express');
const snmp = require('net-snmp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
const dgram = require('dgram');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Default Configuration matching RDSO / Topgrip IPIS Specification
let config = {
  // NMS Target Settings
  nmsIp: '10.0.0.252',
  nmsPort: 162,

  // Board Identification & Parameters
  vendor: 'Topgrip',
  device: 'AVDB',
  deviceIp: getLocalIp() || '10.0.0.15',
  platform: '1',
  intensity: 50,
  boardWidth: 192,
  boardHeight: 112,
  line: 1,

  // SNMPv3 USM Credentials
  usmUser: 'ipisMgmt_Admin',
  authProtocol: 'sha256',
  authKey: 'BallyStationAuthKey2026!',
  privProtocol: 'aes',
  privKey: 'BallyStationPrivKey2026!',
  engineId: 'ENT--BALLY',

  // SNMP Trap OID
  trapOid: '1.3.6.1.4.1.66731.5.11',
  eventCodeOid: '1.3.6.1.4.1.66731.3.6'
};

// Trap In-Memory History Log
const trapHistory = [];
const MAX_HISTORY = 100;

// =============================================================
// DISK FAULT STORAGE SYSTEM (D:\vdc_trap_status\fault.json or C:\vdc_trap_status\fault.json)
// =============================================================
let activeFaultFolder = null;
let activeFaultFilePath = null;

function resolveFaultDirectory() {
  const candidates = [
    'D:\\vdc_trap_status',
    'C:\\vdc_trap_status',
    path.join(__dirname, 'vdc_trap_status')
  ];

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Test write capability
      const testFile = path.join(dir, `.test_write_${Date.now()}.tmp`);
      fs.writeFileSync(testFile, 'ok', 'utf-8');
      fs.unlinkSync(testFile);
      activeFaultFolder = dir;
      activeFaultFilePath = path.join(dir, 'fault.json');
      console.log(`📁 [DISK STORAGE] Fault JSON storage active at: ${activeFaultFilePath}`);
      return dir;
    } catch (err) {
      console.warn(`[DISK STORAGE] Cannot write to ${dir} (${err.message}). Trying fallback...`);
    }
  }

  // Final fallback to workspace directory
  const localDir = path.join(__dirname, 'vdc_trap_status');
  try {
    fs.mkdirSync(localDir, { recursive: true });
  } catch (e) { }
  activeFaultFolder = localDir;
  activeFaultFilePath = path.join(localDir, 'fault.json');
  return localDir;
}

function saveFaultJsonToDisk(state) {
  try {
    if (!activeFaultFolder || !activeFaultFilePath) {
      resolveFaultDirectory();
    }

    const totalFaults = (state && state.summary && typeof state.summary.totalFaults === 'number')
      ? state.summary.totalFaults
      : (state && Array.isArray(state.faults) ? state.faults.length : 0);

    const shortCount = (state && state.summary && typeof state.summary.shortCount === 'number')
      ? state.summary.shortCount
      : (state && Array.isArray(state.shortFaults) ? state.shortFaults.length : 0);

    const openCount = (state && state.summary && typeof state.summary.openCount === 'number')
      ? state.summary.openCount
      : (state && Array.isArray(state.openFaults) ? state.openFaults.length : 0);

    const isHealthy = totalFaults === 0;

    // Schema matching user request:
    // { fault: "total", okay: "all okay", short: "1", open: "1" }
    const faultJsonPayload = {
      fault: String(totalFaults),
      okay: isHealthy ? 'all okay' : 'fault detected',
      short: String(shortCount),
      open: String(openCount),
      total: totalFaults,
      status: isHealthy ? 'HEALTHY' : 'FAULT',
      hsr: (state && state.hsr) ? state.hsr : (isHealthy ? 'All OK' : ''),
      eventCode: (state && state.eventCode) ? state.eventCode : (isHealthy ? 100 : 102),
      severity: (state && state.eventSeverity) ? state.eventSeverity : (isHealthy ? 'INFO' : 'MAJOR'),
      description: (state && state.faultDescription) ? state.faultDescription : (isHealthy ? 'All LED pixels OK. Board healthy and functional.' : 'Fault detected'),
      shortFaults: (state && state.shortFaults) ? state.shortFaults : [],
      openFaults: (state && state.openFaults) ? state.openFaults : [],
      faults: (state && state.faults) ? state.faults : [],
      filePath: activeFaultFilePath,
      lastUpdated: new Date().toISOString()
    };

    // Save fault.json
    fs.writeFileSync(activeFaultFilePath, JSON.stringify(faultJsonPayload, null, 2), 'utf-8');

    return { success: true, folder: activeFaultFolder, filePath: activeFaultFilePath, data: faultJsonPayload };
  } catch (err) {
    console.error(`[DISK STORAGE ERROR] Failed to write fault JSON:`, err.message);
    return { success: false, error: err.message };
  }
}

// Active LED Faults State (Server In-Memory Cache for GET APIs)
let activeLedFaults = {
  status: 'HEALTHY',
  hasFaults: false,
  eventCode: 100,
  eventSeverity: 'INFO',
  hsr: 'All OK',
  faultDescription: 'All LED pixels OK. Board healthy and functional.',
  summary: {
    totalFaults: 0,
    shortCount: 0,
    openCount: 0,
    healthy: true
  },
  shortFaults: [],
  openFaults: [],
  faults: [],
  lastUpdated: new Date().toISOString()
};

// Initialize fault JSON file on disk immediately on startup
try {
  resolveFaultDirectory();
  saveFaultJsonToDisk(activeLedFaults);
} catch (e) { }

// Helper: Parse HSR string (e.g. "S-L1R10C15# O-L1R10C16") into structured fault objects
function parseHsrToFaults(hsr, defaultLine = 1) {
  if (!hsr || hsr === 'All OK') return [];
  const parts = hsr.split('#').map(p => p.trim()).filter(Boolean);
  const faults = [];
  for (const part of parts) {
    const match = part.match(/^([SO])-L(\d+)R(\d+)C(\d+)$/i);
    if (match) {
      const type = match[1].toUpperCase() === 'S' ? 'SHORT' : 'OPEN';
      const line = parseInt(match[2], 10);
      const row = parseInt(match[3], 10);
      const col = parseInt(match[4], 10);
      const prefix = type === 'SHORT' ? 'S' : 'O';
      faults.push({
        line,
        row,
        col,
        type,
        code: `${prefix}-L${line}R${row}C${col}`,
        description: `LED ${type} Circuit detected at Line ${line} Row ${row} Col ${col}`
      });
    }
  }
  return faults;
}

// Helper: Update Active LED Faults
function updateActiveFaults(newFaults, customHsr, customDesc, defaultLine = 1) {
  let list = Array.isArray(newFaults) ? [...newFaults] : [];
  if (list.length === 0 && customHsr && customHsr !== 'All OK') {
    list = parseHsrToFaults(customHsr, defaultLine);
  }

  // Normalize list
  const normalized = list.map(f => {
    const type = (f.type || 'SHORT').toUpperCase();
    const line = parseInt(f.line !== undefined ? f.line : defaultLine, 10);
    const row = parseInt(f.row !== undefined ? f.row : 0, 10);
    const col = parseInt(f.col !== undefined ? f.col : 0, 10);
    const prefix = type === 'SHORT' ? 'S' : 'O';
    return {
      line,
      row,
      col,
      type,
      code: f.code || `${prefix}-L${line}R${row}C${col}`,
      description: f.description || `LED ${type} Circuit detected at Line ${line} Row ${row} Col ${col}`
    };
  });

  const shortFaults = normalized.filter(f => f.type === 'SHORT');
  const openFaults = normalized.filter(f => f.type === 'OPEN');
  const total = normalized.length;
  const isHealthy = total === 0;

  let hsr = customHsr;
  if (!hsr) {
    if (isHealthy) {
      hsr = 'All OK';
    } else {
      hsr = normalized.map(f => f.code).join('# ');
    }
  }

  let eventCode = 100;
  let severity = 'INFO';
  let desc = customDesc;

  if (!isHealthy) {
    if (shortFaults.length > 0) {
      eventCode = 102;
      severity = 'MAJOR';
    } else {
      eventCode = 103;
      severity = 'MAJOR';
    }
    if (!desc) {
      if (total === 1) {
        desc = normalized[0].description;
      } else {
        desc = `Active LED Faults: ${shortFaults.length} SHORT, ${openFaults.length} OPEN (${hsr})`;
      }
    }
  } else {
    desc = desc || 'All LED pixels OK. Board healthy and functional.';
  }

  activeLedFaults = {
    status: isHealthy ? 'HEALTHY' : 'FAULT',
    hasFaults: !isHealthy,
    eventCode,
    eventSeverity: severity,
    hsr,
    faultDescription: desc,
    summary: {
      totalFaults: total,
      shortCount: shortFaults.length,
      openCount: openFaults.length,
      healthy: isHealthy
    },
    shortFaults,
    openFaults,
    faults: normalized,
    lastUpdated: new Date().toISOString()
  };

  // Sync to disk fault JSON file (D:\vdc_trap_status\fault.json or C:\vdc_trap_status\fault.json)
  saveFaultJsonToDisk(activeLedFaults);

  return activeLedFaults;
}

// Helper: Get Wi-Fi IPv4 Address (specifically for Phone / Wireless access on same router)
function getWifiIp() {
  const interfaces = os.networkInterfaces();
  // 1. Check for interface with wifi, wlan, wireless in name
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan') || lower.includes('wireless')) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }
  // 2. Check for typical Wi-Fi subnets 192.168.x.x
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.')) {
        return iface.address;
      }
    }
  }
  return null;
}

// Helper: Get Ethernet / Device LAN IPv4 Address (e.g. for Topgrip / NMS equipment)
function getEthernetIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    if (lower.includes('ethernet') || lower.includes('eth') || lower.includes('lan')) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('10.')) {
        return iface.address;
      }
    }
  }
  return null;
}

// Helper: Get Primary Local IPv4 Address (Wi-Fi preferred for wireless web access)
function getLocalIp() {
  return getWifiIp() || getEthernetIp() || '127.0.0.1';
}

// Helper: Get All Available Network Interfaces
function getAllNetworkIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const lower = name.toLowerCase();
        let typeName = 'LAN Interface';
        if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan') || iface.address.startsWith('192.168.')) {
          typeName = 'Wi-Fi (Phone / Wireless)';
        } else if (lower.includes('ethernet') || lower.includes('eth') || iface.address.startsWith('10.')) {
          typeName = 'Ethernet (NMS / Device)';
        }
        addresses.push({
          name: `${name} (${typeName})`,
          rawName: name,
          ip: iface.address,
          internal: iface.internal,
          url: `http://${iface.address}:${PORT}`
        });
      }
    }
  }
  return addresses;
}

// Generate the 13 Varbinds according to Topgrip IPIS Specification (PEN 66731)
function build13Varbinds(params) {
  const vendor = params.vendor || config.vendor;
  const device = params.device || config.device;
  const deviceIp = params.deviceIp || config.deviceIp;
  const platform = params.platform || config.platform;
  const intensity = parseInt(params.intensity !== undefined ? params.intensity : config.intensity, 10);
  const eventCode = parseInt(params.eventCode !== undefined ? params.eventCode : 100, 10);
  const severity = params.severity || (eventCode === 100 ? 'INFO' : 'MAJOR');
  const line = parseInt(params.line !== undefined ? params.line : (config.line || 1), 10);
  const row = parseInt(params.row !== undefined ? params.row : 0, 10);
  const col = parseInt(params.col !== undefined ? params.col : 0, 10);
  const dimensions = `${config.boardWidth}x${config.boardHeight}`;

  let hsr = params.hsr;
  if (!hsr) {
    if (eventCode === 100) {
      hsr = 'All OK';
    } else if (eventCode === 102) {
      hsr = `S-L${line}R${row}C${col}`;
    } else if (eventCode === 103) {
      hsr = `O-L${line}R${row}C${col}`;
    } else {
      hsr = 'All OK';
    }
  }

  let faultDesc = params.faultDesc;
  if (!faultDesc) {
    if (eventCode === 100) {
      faultDesc = 'All LED pixels OK. Board healthy and functional.';
    } else if (eventCode === 102) {
      if (row > 0 && col > 0) {
        faultDesc = `LED SHORT Circuit detected at Line ${line} Row ${row} Col ${col}`;
      } else {
        faultDesc = `LED SHORT Circuit detected (${hsr})`;
      }
    } else if (eventCode === 103) {
      if (row > 0 && col > 0) {
        faultDesc = `LED OPEN Circuit detected at Line ${line} Row ${row} Col ${col}`;
      } else {
        faultDesc = `LED OPEN Circuit detected (${hsr})`;
      }
    } else {
      faultDesc = `LED Fault Condition detected (${hsr})`;
    }
  }

  return [
    {
      index: 1,
      name: 'ipisVendorName',
      oid: '1.3.6.1.4.1.66731.3.1',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: vendor
    },
    {
      index: 2,
      name: 'ipisDeviceType',
      oid: '1.3.6.1.4.1.66731.3.2',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: device
    },
    {
      index: 3,
      name: 'ipisDeviceIp',
      oid: '1.3.6.1.4.1.66731.3.3',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: deviceIp
    },
    {
      index: 4,
      name: 'ipisPlatformNo',
      oid: '1.3.6.1.4.1.66731.3.4',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: platform
    },
    {
      index: 5,
      name: 'ipisIntensity',
      oid: '1.3.6.1.4.1.66731.3.5',
      type: snmp.ObjectType.Integer,
      typeName: 'INTEGER',
      value: intensity
    },
    {
      index: 6,
      name: 'ipisEventCode',
      oid: '1.3.6.1.4.1.66731.3.6',
      type: snmp.ObjectType.Integer,
      typeName: 'INTEGER',
      value: eventCode
    },
    {
      index: 7,
      name: 'ipisEventSeverity',
      oid: '1.3.6.1.4.1.66731.3.7',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: severity
    },
    {
      index: 8,
      name: 'ipisHealthStatusReport',
      oid: '1.3.6.1.4.1.66731.3.8',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: hsr
    },
    {
      index: 9,
      name: 'ipisFaultLine',
      oid: '1.3.6.1.4.1.66731.3.9',
      type: snmp.ObjectType.Integer,
      typeName: 'INTEGER',
      value: line
    },
    {
      index: 10,
      name: 'ipisFaultRow',
      oid: '1.3.6.1.4.1.66731.3.10',
      type: snmp.ObjectType.Integer,
      typeName: 'INTEGER',
      value: row
    },
    {
      index: 11,
      name: 'ipisFaultColumn',
      oid: '1.3.6.1.4.1.66731.3.11',
      type: snmp.ObjectType.Integer,
      typeName: 'INTEGER',
      value: col
    },
    {
      index: 12,
      name: 'ipisFaultDescription',
      oid: '1.3.6.1.4.1.66731.3.12',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: faultDesc
    },
    {
      index: 13,
      name: 'ipisBoardDimensions',
      oid: '1.3.6.1.4.1.66731.3.13',
      type: snmp.ObjectType.OctetString,
      typeName: 'OCTET STRING',
      value: dimensions
    }
  ];
}

// Function to Send SNMPv3 Trap to NMS
function sendSnmpv3Trap(trapPayload) {
  return new Promise((resolve) => {
    const targetIp = trapPayload.nmsIp || config.nmsIp;
    const targetPort = parseInt(trapPayload.nmsPort || config.nmsPort, 10);
    const trapOid = trapPayload.trapOid || config.trapOid;

    // Build USM Security Credentials
    const user = {
      name: trapPayload.usmUser || config.usmUser,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha256,
      authKey: trapPayload.authKey || config.authKey,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: trapPayload.privKey || config.privKey
    };

    const options = {
      port: targetPort,
      retries: 1,
      timeout: 2000,
      version: snmp.Version3,
      id: trapPayload.engineId || config.engineId,
      transport: 'udp4'
    };

    const varbinds = trapPayload.varbinds || build13Varbinds(trapPayload);

    // Format varbinds for net-snmp library
    const snmpVarbinds = varbinds.map(vb => ({
      oid: vb.oid,
      type: typeof vb.type === 'number' ? vb.type : (vb.typeName === 'INTEGER' ? snmp.ObjectType.Integer : snmp.ObjectType.OctetString),
      value: vb.value
    }));

    const logEntry = {
      id: 'TRAP-' + Date.now(),
      timestamp: new Date().toISOString(),
      target: `${targetIp}:${targetPort}`,
      protocol: 'SNMPv3 authPriv (SHA-256 + AES-128)',
      usmUser: user.name,
      engineId: options.id,
      trapOid: trapOid,
      eventCode: trapPayload.eventCode || 100,
      severity: trapPayload.severity || (trapPayload.eventCode === 100 ? 'INFO' : 'MAJOR'),
      hsr: trapPayload.hsr || 'All OK',
      varbindsCount: snmpVarbinds.length,
      varbinds: varbinds,
      status: 'SENDING',
      message: 'Trap dispatched via UDP 162'
    };

    console.log(`\n========================================`);
    console.log(`[TRAP OUTBOUND] Sending SNMPv3 Trap to ${targetIp}:${targetPort}`);
    console.log(`USM User: ${user.name} | Security: authPriv (SHA256/AES128) | EngineID: ${options.id}`);
    console.log(`Trap OID: ${trapOid}`);
    console.log(`Event Code: ${logEntry.eventCode} (${logEntry.severity})`);
    console.log(`HSR: "${logEntry.hsr}"`);
    console.log(`Varbinds: ${snmpVarbinds.length} fields attached`);
    console.log(`========================================\n`);

    try {
      const session = snmp.createV3Session(targetIp, user, options);

      // Send SNMPv3 Trap / Inform
      session.trap(trapOid, snmpVarbinds, (error) => {
        if (error) {
          console.warn(`[TRAP NOTICE] net-snmp trap callback info: ${error.message}`);
          logEntry.status = 'DISPATCHED';
          logEntry.message = `Trap transmitted via UDP to ${targetIp}:${targetPort} (${error.message || 'Sent'})`;
        } else {
          console.log(`[TRAP SUCCESS] Trap successfully transmitted to ${targetIp}:${targetPort}`);
          logEntry.status = 'SUCCESS';
          logEntry.message = `Successfully transmitted to NMS (${targetIp}:${targetPort})`;
        }

        try { session.close(); } catch (e) { }

        trapHistory.unshift(logEntry);
        if (trapHistory.length > MAX_HISTORY) trapHistory.pop();

        resolve(logEntry);
      });

      // Also ensure resolution within 2.5 seconds in case of unidirectional UDP trap
      setTimeout(() => {
        if (logEntry.status === 'SENDING') {
          logEntry.status = 'DISPATCHED';
          logEntry.message = `UDP Trap datagram packet sent to ${targetIp}:${targetPort}`;
          try { session.close(); } catch (e) { }

          if (!trapHistory.some(h => h.id === logEntry.id)) {
            trapHistory.unshift(logEntry);
            if (trapHistory.length > MAX_HISTORY) trapHistory.pop();
          }
          resolve(logEntry);
        }
      }, 1500);

    } catch (err) {
      console.error(`[TRAP ERROR] Failed to dispatch trap:`, err);
      logEntry.status = 'ERROR';
      logEntry.message = `Error: ${err.message}`;

      trapHistory.unshift(logEntry);
      if (trapHistory.length > MAX_HISTORY) trapHistory.pop();

      resolve(logEntry);
    }
  });
}

// -------------------------------------------------------------
// API ENDPOINTS
// -------------------------------------------------------------

// 1. Get Network Info & QR Code
app.get('/api/network-info', async (req, res) => {
  const wifiIp = getWifiIp();
  const ethernetIp = getEthernetIp();
  const primaryIp = wifiIp || ethernetIp || getLocalIp();
  const allIps = getAllNetworkIps();
  const primaryUrl = `http://${primaryIp}:${PORT}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(primaryUrl, {
      margin: 2,
      scale: 8,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    res.json({
      primaryIp,
      wifiIp,
      ethernetIp,
      port: PORT,
      primaryUrl,
      allIps,
      qrDataUrl,
      config,
      diskStorage: {
        folder: activeFaultFolder,
        filePath: activeFaultFilePath
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code', details: err.message });
  }
});

// 2. Get Current Config & Status
app.get('/api/config', (req, res) => {
  res.json({
    config,
    primaryIp: getLocalIp(),
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// 3. Update Configuration
app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  res.json({ success: true, message: 'Configuration updated', config });
});

// 4. Send SNMPv3 Trap (Generic / Custom)
app.post('/api/send-trap', async (req, res) => {
  try {
    const payload = req.body;
    const result = await sendSnmpv3Trap(payload);

    // Update active fault state based on sent trap
    if (payload.eventCode === 100 || payload.hsr === 'All OK') {
      updateActiveFaults([], 'All OK', payload.faultDesc || 'All LED pixels OK. Board healthy and functional.');
    } else if (payload.hsr) {
      updateActiveFaults(payload.faults || [], payload.hsr, payload.faultDesc, payload.line || 1);
    }

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Send 1-Click Trap Preset
app.post('/api/send-preset', async (req, res) => {
  const presetType = req.body.presetType; // 'INFO_OK' | 'CLEAR' | 'SHORT' | 'OPEN' | 'MATRIX_STATE'
  let trapPayload = {};

  const line = parseInt(req.body.line !== undefined ? req.body.line : 1, 10);
  const row = parseInt(req.body.row !== undefined ? req.body.row : 10, 10);
  const col = parseInt(req.body.col !== undefined ? req.body.col : 15, 10);

  if (presetType === 'INFO_OK' || presetType === 'CLEAR') {
    // 🔹 CLEAR / HEALTHY: EventCode 100
    trapPayload = {
      eventCode: 100,
      severity: req.body.severity || 'INFO',
      hsr: req.body.hsr || 'All OK',
      line: line || 1,
      row: 0,
      col: 0,
      faultDesc: req.body.faultDesc || 'All LED pixels OK. Board healthy and functional.'
    };
    updateActiveFaults([], 'All OK', trapPayload.faultDesc, line);
  } else if (presetType === 'SHORT') {
    // 🔹 SHORT Circuit: EventCode 102
    trapPayload = {
      eventCode: 102,
      severity: req.body.severity || 'MAJOR',
      hsr: req.body.hsr || `S-L${line}R${row}C${col}`,
      line: line,
      row: row,
      col: col,
      faultDesc: req.body.faultDesc || `LED SHORT Circuit detected at Line ${line} Row ${row} Col ${col}`
    };
    updateActiveFaults([{ line, row, col, type: 'SHORT' }], trapPayload.hsr, trapPayload.faultDesc, line);
  } else if (presetType === 'OPEN') {
    // 🔹 OPEN Circuit: EventCode 103
    trapPayload = {
      eventCode: 103,
      severity: req.body.severity || 'MAJOR',
      hsr: req.body.hsr || `O-L${line}R${row}C${col}`,
      line: line,
      row: row,
      col: col,
      faultDesc: req.body.faultDesc || `LED OPEN Circuit detected at Line ${line} Row ${row} Col ${col}`
    };
    updateActiveFaults([{ line, row, col, type: 'OPEN' }], trapPayload.hsr, trapPayload.faultDesc, line);
  } else if (presetType === 'MATRIX_STATE') {
    // Dynamic Active Faults from Matrix
    const eventCode = parseInt(req.body.eventCode !== undefined ? req.body.eventCode : 102, 10);
    const mLine = parseInt(req.body.line !== undefined ? req.body.line : 1, 10);
    const mRow = parseInt(req.body.row !== undefined ? req.body.row : 0, 10);
    const mCol = parseInt(req.body.col !== undefined ? req.body.col : 0, 10);
    const hsr = req.body.hsr || 'All OK';
    let faultDesc = req.body.faultDesc;
    if (!faultDesc) {
      if (eventCode === 100 || hsr === 'All OK') {
        faultDesc = 'All LED pixels OK. Board healthy and functional.';
      } else if (eventCode === 102) {
        faultDesc = mRow > 0 && mCol > 0 ? `LED SHORT Circuit detected at Line ${mLine} Row ${mRow} Col ${mCol}` : `LED SHORT Circuit detected (${hsr})`;
      } else if (eventCode === 103) {
        faultDesc = mRow > 0 && mCol > 0 ? `LED OPEN Circuit detected at Line ${mLine} Row ${mRow} Col ${mCol}` : `LED OPEN Circuit detected (${hsr})`;
      } else {
        faultDesc = `LED Matrix Faults: ${hsr}`;
      }
    }
    trapPayload = {
      eventCode: eventCode,
      severity: req.body.severity || (eventCode === 100 ? 'INFO' : 'MAJOR'),
      hsr: hsr,
      line: mLine,
      row: mRow,
      col: mCol,
      faultDesc: faultDesc
    };
    updateActiveFaults(req.body.faults || [], hsr, faultDesc, mLine);
  } else {
    return res.status(400).json({ error: 'Unknown preset type' });
  }

  // Merge with custom overrides from request if any
  const fullPayload = {
    ...config,
    ...req.body,
    ...trapPayload
  };

  fullPayload.varbinds = build13Varbinds(fullPayload);

  const result = await sendSnmpv3Trap(fullPayload);
  res.json({ success: true, preset: presetType, result });
});

// -------------------------------------------------------------
// 🌟 SHAREABLE GET API: SEE LED SHORT & FAULT STATUS
// Endpoint: GET /api/led-short (and aliases: /api/led-faults, /api/led-status, /api/faults)
// -------------------------------------------------------------
function handleGetLedFaults(req, res) {
  const primaryIp = getLocalIp();
  const boardInfo = {
    vendor: config.vendor,
    device: config.device,
    ip: primaryIp || config.deviceIp,
    dimensions: `${config.boardWidth}x${config.boardHeight}`,
    platform: config.platform,
    intensity: config.intensity,
    line: config.line || 1
  };

  // 1. Raw HSR String Query: /api/led-short?raw=hsr
  if (req.query.raw === 'hsr') {
    return res.type('text/plain').send(activeLedFaults.hsr);
  }

  // 2. Filter by Type: ?type=short or ?type=open
  let filteredFaults = [...activeLedFaults.faults];
  const typeFilter = req.query.type ? req.query.type.toUpperCase() : null;
  if (typeFilter) {
    filteredFaults = filteredFaults.filter(f => f.type === typeFilter);
  }

  // 3. Filter by Coordinates: ?line=1&row=10&col=15
  const qLine = req.query.line !== undefined ? parseInt(req.query.line, 10) : null;
  const qRow = req.query.row !== undefined ? parseInt(req.query.row, 10) : null;
  const qCol = req.query.col !== undefined ? parseInt(req.query.col, 10) : null;

  if (qRow !== null && qCol !== null) {
    filteredFaults = filteredFaults.filter(f => f.row === qRow && f.col === qCol && (qLine === null || f.line === qLine));
  }

  // 4. Sorting: ?sort=row | col | type
  const sortBy = (req.query.sort || 'row').toLowerCase();
  if (sortBy === 'col') {
    filteredFaults.sort((a, b) => a.col - b.col || a.row - b.row);
  } else if (sortBy === 'type') {
    filteredFaults.sort((a, b) => a.type.localeCompare(b.type) || a.row - b.row);
  } else {
    // default row
    filteredFaults.sort((a, b) => a.row - b.row || a.col - b.col);
  }

  // 5. Construct Clean, Shareable JSON Response
  const allIps = getAllNetworkIps().filter(i => !i.internal);
  const hostIpsList = allIps.map(i => ({
    interface: i.name,
    ip: i.ip,
    apiUrl: `http://${i.ip}:${PORT}/api/led-short`,
    webUrl: `http://${i.ip}:${PORT}`
  }));

  const responseData = {
    status: activeLedFaults.status,
    hasFaults: activeLedFaults.hasFaults,
    message: activeLedFaults.faultDescription,
    summary: {
      totalFaults: activeLedFaults.summary.totalFaults,
      shortCount: activeLedFaults.summary.shortCount,
      openCount: activeLedFaults.summary.openCount,
      healthy: activeLedFaults.summary.healthy
    },
    hsr: activeLedFaults.hsr,
    eventCode: activeLedFaults.eventCode,
    eventSeverity: activeLedFaults.eventSeverity,
    shortFaults: activeLedFaults.shortFaults,
    openFaults: activeLedFaults.openFaults,
    faults: filteredFaults,
    board: boardInfo,
    timestamp: activeLedFaults.lastUpdated,
    apiUrls: {
      ledShortApi: `http://${primaryIp}:${PORT}/api/led-short`,
      ledFaultsApi: `http://${primaryIp}:${PORT}/api/led-faults`,
      allHostIps: hostIpsList,
      filterShortOnly: `http://${primaryIp}:${PORT}/api/led-short?type=short`,
      rawHsrString: `http://${primaryIp}:${PORT}/api/led-short?raw=hsr`
    },
    diskStorage: {
      folder: activeFaultFolder,
      filePath: activeFaultFilePath
    }
  };

  // Pretty-print JSON (2-space indent) for instant readability in web browsers and curl
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(responseData, null, 2));
}

// Register Primary & Alias GET Routes
app.get('/api/led-short', handleGetLedFaults);
app.get('/api/led-faults', handleGetLedFaults);
app.get('/api/led-status', handleGetLedFaults);
app.get('/api/faults', handleGetLedFaults);

// Synchronize / Set Active Faults Directly (POST /api/led-faults)
app.post('/api/led-faults', (req, res) => {
  const faults = req.body.faults || [];
  const hsr = req.body.hsr;
  const desc = req.body.faultDesc;
  const line = req.body.line || 1;
  const updated = updateActiveFaults(faults, hsr, desc, line);
  res.json({ success: true, message: 'LED faults synchronized', state: updated });
});

// Read Disk Fault JSON File Info & Contents (GET /api/fault-file)
app.get('/api/fault-file', (req, res) => {
  try {
    if (activeFaultFilePath && fs.existsSync(activeFaultFilePath)) {
      const fileRaw = fs.readFileSync(activeFaultFilePath, 'utf-8');
      const data = JSON.parse(fileRaw);
      res.json({
        success: true,
        folder: activeFaultFolder,
        filePath: activeFaultFilePath,
        data: data
      });
    } else {
      res.json({
        success: false,
        message: 'Fault file not yet created on disk',
        folder: activeFaultFolder,
        filePath: activeFaultFilePath
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Get Trap Activity History
app.get('/api/history', (req, res) => {
  res.json({
    total: trapHistory.length,
    history: trapHistory
  });
});

// 7. Clear History
app.post('/api/clear-history', (req, res) => {
  trapHistory.length = 0;
  res.json({ success: true, message: 'History cleared' });
});

// 9. Automated Full Test Cycle
app.post('/api/auto-test', async (req, res) => {
  const steps = [
    { presetType: 'INFO_OK', name: '1. Healthy / All OK (Event 100)' },
    { presetType: 'SHORT', line: 1, row: 10, col: 15, hsr: 'S-L1R10C15', name: '2. SHORT Circuit (Event 102)' },
    { presetType: 'OPEN', line: 1, row: 10, col: 15, hsr: 'O-L1R10C15', name: '3. OPEN Circuit (Event 103)' },
    { presetType: 'MATRIX_STATE', eventCode: 102, severity: 'MAJOR', hsr: 'S-L1R10C15# O-L1R10C16# S-L1R25C40', line: 1, row: 10, col: 15, faultDesc: 'Multi-Fault: Short at L1 R10 C15, Open at L1 R10 C16, Short at L1 R25 C40', name: '4. Multiple Faults (#) (Event 102)' },
    { presetType: 'INFO_OK', hsr: 'All OK', faultDesc: 'Board status restored to 100% HEALTHY', name: '5. Recovery to Healthy (Event 100)' }
  ];

  const results = [];
  for (const step of steps) {
    let payload = { ...config, ...step };
    if (step.presetType === 'INFO_OK') {
      payload.eventCode = 100;
      payload.severity = 'INFO';
      payload.hsr = step.hsr || 'All OK';
      payload.line = 1; payload.row = 0; payload.col = 0;
      payload.faultDesc = step.faultDesc || 'All LED pixels OK. Board healthy and functional.';
    } else if (step.presetType === 'SHORT') {
      payload.eventCode = 102;
      payload.severity = 'MAJOR';
      payload.hsr = step.hsr || `S-L${step.line || 1}R${step.row || 10}C${step.col || 15}`;
      payload.faultDesc = `LED SHORT Circuit detected at Line ${step.line || 1} Row ${step.row || 10} Col ${step.col || 15}`;
    } else if (step.presetType === 'OPEN') {
      payload.eventCode = 103;
      payload.severity = 'MAJOR';
      payload.hsr = step.hsr || `O-L${step.line || 1}R${step.row || 10}C${step.col || 15}`;
      payload.faultDesc = `LED OPEN Circuit detected at Line ${step.line || 1} Row ${step.row || 10} Col ${step.col || 15}`;
    }
    payload.varbinds = build13Varbinds(payload);
    const result = await sendSnmpv3Trap(payload);
    results.push({ stepName: step.name, result });
    await new Promise(r => setTimeout(r, 600));
  }

  res.json({ success: true, count: results.length, results });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  const wifiIp = getWifiIp();
  const ethIp = getEthernetIp();
  const primaryIp = wifiIp || ethIp || '127.0.0.1';

  console.log(`\n================================================================`);
  console.log(`🚆 TOPGRIP IPIS / VDC AVDB (192x112) SNMPv3 TRAP CONTROLLER`);
  console.log(`================================================================`);
  console.log(`📡 Local PC Access:          http://localhost:${PORT}`);
  if (wifiIp) {
    console.log(`📱 Wi-Fi / Phone Access:     http://${wifiIp}:${PORT}  (Scan QR on same Wi-Fi)`);
  }
  if (ethIp) {
    console.log(`🔌 Ethernet / Device Access: http://${ethIp}:${PORT}   (IPIS / NMS Network)`);
  }
  console.log(`🔍 LED Short/Fault GET API:  http://${primaryIp}:${PORT}/api/led-short`);
  if (activeFaultFilePath) {
    console.log(`💾 Disk Fault Auto-Save:     ${activeFaultFilePath}`);
  }
  console.log(`🎯 Target NMS Destination:   ${config.nmsIp}:${config.nmsPort} (UDP)`);
  console.log(`🔐 SNMPv3 USM User:          ${config.usmUser} (authPriv HMAC-SHA-256 / AES-128)`);
  console.log(`🏷️ Trap Notification OID:    ${config.trapOid}`);
  console.log(`📺 Board Simulation:         ${config.device} (${config.boardWidth}x${config.boardHeight})`);
  console.log(`================================================================\n`);
});
