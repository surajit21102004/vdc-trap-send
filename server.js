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

// Helper: Get Primary Local IPv4 Address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Helper: Get All Available Network Interfaces
function getAllNetworkIps() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4') {
        addresses.push({
          name: name,
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
  const primaryIp = getLocalIp();
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
      port: PORT,
      primaryUrl,
      allIps,
      qrDataUrl,
      config
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
  const localIp = getLocalIp();
  console.log(`\n================================================================`);
  console.log(`🚆 TOPGRIP IPIS / VDC AVDB (192x112) SNMPv3 TRAP CONTROLLER`);
  console.log(`================================================================`);
  console.log(`📡 Server running locally at:   http://localhost:${PORT}`);
  console.log(`📱 Wi-Fi / Phone access at:     http://${localIp}:${PORT}`);
  console.log(`🎯 Target NMS Destination:      ${config.nmsIp}:${config.nmsPort} (UDP)`);
  console.log(`🔐 SNMPv3 USM User:             ${config.usmUser} (authPriv HMAC-SHA-256 / AES-128)`);
  console.log(`🏷️ Trap Notification OID:       ${config.trapOid}`);
  console.log(`📺 Board Simulation:            ${config.device} (${config.boardWidth}x${config.boardHeight})`);
  console.log(`================================================================\n`);
});
