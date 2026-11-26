/**
 * Topgrip IPIS / VDC AVDB (192x112) SNMPv3 Controller - Frontend Logic
 * Supports real-time Canvas rendering, fault injection, HSR string calculation,
 * 13 Varbind table updates, and SNMPv3 trap dispatching to NMS (10.0.0.252:162).
 */

(function () {
  'use strict';

  // Application State
  const state = {
    boardWidth: 192,
    boardHeight: 112,
    line: 1,
    activeTool: 'short', // 'short' | 'open' | 'clear'
    zoomLevel: 'fit',    // 'fit' | 1 | 2 | 4
    scale: 1,

    // Matrix Faults Map: key = `${row}_${col}`, value = { line, row, col, type: 'SHORT' | 'OPEN' }
    faults: new Map(),

    // Current Config
    config: {
      nmsIp: '10.0.0.252',
      nmsPort: 162,
      vendor: 'Topgrip',
      device: 'AVDB',
      deviceIp: '10.0.0.15',
      platform: '1',
      intensity: 50,
      usmUser: 'ipisMgmt_Admin',
      authKey: 'BallyStationAuthKey2026!',
      privKey: 'BallyStationPrivKey2026!',
      engineId: 'ENT--BALLY',
      trapOid: '1.3.6.1.4.1.66731.5.11'
    },

    activeAlarm: null, // null (Healthy) | { type: 'SHORT'|'OPEN'|'MULTI', line, row, col, hsr, time }
    isMouseDown: false,
    history: []
  };

  // DOM Elements
  const canvas = document.getElementById('matrixCanvas');
  const ctx = canvas.getContext('2d');
  const canvasContainer = document.getElementById('canvasScrollContainer');
  const canvasWrapper = document.getElementById('canvasWrapper');

  const cursorPosReadout = document.getElementById('cursorPosReadout');
  const liveHsrString = document.getElementById('liveHsrString');
  const liveJsonPayload = document.getElementById('liveJsonPayload');
  const varbindTableBody = document.getElementById('varbindTableBody');
  const trapHistoryList = document.getElementById('trapHistoryList');
  const emptyHistoryMsg = document.getElementById('emptyHistoryMsg');

  // Alarm Monitor Elements
  const alarmStatusCard = document.getElementById('alarmStatusCard');
  const alarmStateBadge = document.getElementById('alarmStateBadge');
  const alarmStatusDesc = document.getElementById('alarmStatusDesc');
  const btnMainClearTrap = document.getElementById('btnMainClearTrap');

  const hudFaultCount = document.getElementById('hudFaultCount');
  const hudShortCount = document.getElementById('hudShortCount');
  const hudOpenCount = document.getElementById('hudOpenCount');
  const matrixSeverityBadge = document.getElementById('matrixSeverityBadge');
  const matrixHsrSummary = document.getElementById('matrixHsrSummary');

  const inputLine = document.getElementById('inputLine');
  const inputRow = document.getElementById('inputRow');
  const inputCol = document.getElementById('inputCol');

  const btnSendShortCoord = document.getElementById('btnSendShortCoord');
  const btnSendOpenCoord = document.getElementById('btnSendOpenCoord');
  const btnSendClearCoord = document.getElementById('btnSendClearCoord');
  const btnInjectMulti = document.getElementById('btnInjectMulti');
  const btnRandomFaults = document.getElementById('btnRandomFaults');
  const btnClearAllFaults = document.getElementById('btnClearAllFaults');

  const btnPresetInfo = document.getElementById('btnPresetInfo');
  const btnPresetShort = document.getElementById('btnPresetShort');
  const btnPresetOpen = document.getElementById('btnPresetOpen');
  const btnSendMatrixTrap = document.getElementById('btnSendMatrixTrap');
  const btnRunAutoTest = document.getElementById('btnRunAutoTest');

  const btnCopyJson = document.getElementById('btnCopyJson');
  const btnClearHistory = document.getElementById('btnClearHistory');

  // Modals
  const qrModalBackdrop = document.getElementById('qrModalBackdrop');
  const btnPhoneConnect = document.getElementById('btnPhoneConnect');
  const btnCloseQrModal = document.getElementById('btnCloseQrModal');
  const qrCodeImage = document.getElementById('qrCodeImage');
  const qrUrlLink = document.getElementById('qrUrlLink');
  const networkInterfacesList = document.getElementById('networkInterfacesList');

  const settingsModalBackdrop = document.getElementById('settingsModalBackdrop');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseSettingsModal = document.getElementById('btnCloseSettingsModal');
  const btnCancelSettings = document.getElementById('btnCancelSettings');
  const settingsForm = document.getElementById('settingsForm');

  // Shareable GET API Modal Elements
  const apiModalBackdrop = document.getElementById('apiModalBackdrop');
  const btnOpenApiModal = document.getElementById('btnOpenApiModal');
  const btnCloseApiModal = document.getElementById('btnCloseApiModal');
  const apiShortUrlText = document.getElementById('apiShortUrlText');
  const apiFaultsUrlText = document.getElementById('apiFaultsUrlText');
  const apiShortOnlyUrlText = document.getElementById('apiShortOnlyUrlText');
  const apiRawHsrUrlText = document.getElementById('apiRawHsrUrlText');
  const apiCoordCheckUrlText = document.getElementById('apiCoordCheckUrlText');
  const curlCommandText = document.getElementById('curlCommandText');
  const apiLivePreviewCode = document.getElementById('apiLivePreviewCode');
  const btnCopyApiUrl = document.getElementById('btnCopyApiUrl');
  const btnOpenApiInTab = document.getElementById('btnOpenApiInTab');
  const btnCopyCurlCmd = document.getElementById('btnCopyCurlCmd');
  const btnRefreshApiPreview = document.getElementById('btnRefreshApiPreview');
  const selectApiInterface = document.getElementById('selectApiInterface');
  let networkInterfaces = [];

  const headerNmsTarget = document.getElementById('headerNmsTarget');
  const headerBoardType = document.getElementById('headerBoardType');

  // Initialize
  async function init() {
    setupCanvas();
    setupEventListeners();
    await fetchNetworkInfo();
    await fetchConfig();
    await fetchHistory();
    await fetchActiveFaults();
    updateHsrAndJson();
    renderMatrix();
    updateVarbindTable();
    updateCoordButtonLabels();
    updateAlarmStatusDisplay();

    // Periodic History Sync
    setInterval(fetchHistory, 3000);
  }

  async function fetchActiveFaults() {
    try {
      const res = await fetch('/api/led-faults');
      const data = await res.json();
      if (data && Array.isArray(data.faults) && data.faults.length > 0) {
        state.faults.clear();
        for (const f of data.faults) {
          state.faults.set(`${f.row}_${f.col}`, {
            line: f.line || 1,
            row: f.row,
            col: f.col,
            type: f.type || 'SHORT'
          });
        }
      }
    } catch (e) { }
  }

  // Canvas Setup
  function setupCanvas() {
    // Each LED dot: 8px pitch (6px diameter diode + 2px spacing)
    const pitch = 8;
    canvas.width = state.boardWidth * pitch;
    canvas.height = state.boardHeight * pitch;

    applyZoom('fit');
  }

  // Zoom Controls
  function applyZoom(level) {
    state.zoomLevel = level;
    document.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));

    const pitch = 8;
    const baseW = state.boardWidth * pitch;
    const baseH = state.boardHeight * pitch;

    if (level === 'fit') {
      document.getElementById('btnZoomFit').classList.add('active');
      const wrapperW = canvasWrapper.clientWidth - 20;
      const wrapperH = canvasWrapper.clientHeight - 20;
      const scaleX = wrapperW / baseW;
      const scaleY = wrapperH / baseH;
      state.scale = Math.min(scaleX, scaleY, 1.2);
    } else {
      state.scale = level;
      const btn = document.getElementById(`btnZoom${level}x`);
      if (btn) btn.classList.add('active');
    }

    canvas.style.width = `${Math.round(baseW * state.scale)}px`;
    canvas.style.height = `${Math.round(baseH * state.scale)}px`;
    renderMatrix();
  }

  // Matrix Renderer (High Performance Canvas)
  function renderMatrix() {
    const W = state.boardWidth;
    const H = state.boardHeight;
    const pitch = 8;
    const diodeRadius = 2.8;

    // Clear background
    ctx.fillStyle = '#060a12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid subtle lines / modules (every 16x16 pixels module boundary)
    ctx.strokeStyle = '#101a2d';
    ctx.lineWidth = 1;
    for (let c = 0; c <= W; c += 16) {
      ctx.beginPath();
      ctx.moveTo(c * pitch, 0);
      ctx.lineTo(c * pitch, H * pitch);
      ctx.stroke();
    }
    for (let r = 0; r <= H; r += 16) {
      ctx.beginPath();
      ctx.moveTo(0, r * pitch);
      ctx.lineTo(W * pitch, r * pitch);
      ctx.stroke();
    }

    // Render LEDs
    let shortCount = 0;
    let openCount = 0;

    for (let r = 1; r <= H; r++) {
      for (let c = 1; c <= W; c++) {
        const x = (c - 1) * pitch + pitch / 2;
        const y = (r - 1) * pitch + pitch / 2;
        const key = `${r}_${c}`;
        const fault = state.faults.get(key);

        if (!fault) {
          // Normal Lit LED (Amber / Green glow)
          ctx.beginPath();
          ctx.arc(x, y, diodeRadius, 0, Math.PI * 2);
          ctx.fillStyle = '#143828'; // Unlit base / dimmed active
          ctx.fill();

          // Core point
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fillStyle = '#10b981';
          ctx.fill();
        } else if (fault.type === 'SHORT') {
          shortCount++;
          // RED Short Circuit (Pulsing / Glowing)
          ctx.beginPath();
          ctx.arc(x, y, diodeRadius + 1.2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(239, 68, 68, 0.4)';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(x, y, diodeRadius, 0, Math.PI * 2);
          ctx.fillStyle = '#ef4444';
          ctx.fill();

          // Center bright core
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        } else if (fault.type === 'OPEN') {
          openCount++;
          // AMBER / YELLOW Open Circuit (Hollow ring / broken filament)
          ctx.beginPath();
          ctx.arc(x, y, diodeRadius + 0.8, 0, Math.PI * 2);
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.6;
          ctx.stroke();

          // Unlit dark center
          ctx.beginPath();
          ctx.arc(x, y, 1.2, 0, Math.PI * 2);
          ctx.fillStyle = '#451a03';
          ctx.fill();
        }
      }
    }

    // Update HUD counters
    const totalFaults = shortCount + openCount;
    hudFaultCount.textContent = totalFaults;
    hudShortCount.textContent = shortCount;
    hudOpenCount.textContent = openCount;

    if (totalFaults === 0) {
      matrixSeverityBadge.className = 'severity-badge sev-info';
      matrixSeverityBadge.textContent = 'INFO (100)';
    } else if (shortCount > 0) {
      matrixSeverityBadge.className = 'severity-badge sev-major';
      matrixSeverityBadge.textContent = 'MAJOR (102)';
    } else {
      matrixSeverityBadge.className = 'severity-badge sev-major';
      matrixSeverityBadge.textContent = 'MAJOR (103)';
    }
  }

  // Handle Pixel Coordinates from Mouse / Touch
  function getMatrixCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const pitchX = rect.width / state.boardWidth;
    const pitchY = rect.height / state.boardHeight;

    const col = Math.floor(x / pitchX) + 1;
    const row = Math.floor(y / pitchY) + 1;

    if (col >= 1 && col <= state.boardWidth && row >= 1 && row <= state.boardHeight) {
      return { col, row };
    }
    return null;
  }

  function applyToolAtCoord(col, row) {
    const key = `${row}_${col}`;
    if (state.activeTool === 'clear') {
      state.faults.delete(key);
    } else if (state.activeTool === 'short') {
      state.faults.set(key, { line: state.line, row, col, type: 'SHORT' });
    } else if (state.activeTool === 'open') {
      state.faults.set(key, { line: state.line, row, col, type: 'OPEN' });
    }

    // Update coordinate input fields to reflect last clicked LED
    inputRow.value = row;
    inputCol.value = col;
    updateCoordButtonLabels();

    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    syncFaultsToServer();
  }

  // Synchronize Live Matrix Faults to Server (Debounced)
  let syncTimer = null;
  function syncFaultsToServer() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const faultList = Array.from(state.faults.values());
        const hsr = calculateHsrString();
        await fetch('/api/led-faults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            faults: faultList,
            hsr: hsr,
            line: state.line
          })
        });
        if (apiModalBackdrop && apiModalBackdrop.classList.contains('active')) {
          fetchApiLivePreview();
        }
      } catch (e) { }
    }, 250);
  }

  // Calculate HSR String (Topgrip / RDSO Specification)
  // Format: "All OK" or "S-L1R10C15" or "S-L1R10C15# O-L1R10C15"
  function calculateHsrString() {
    if (state.faults.size === 0) {
      return 'All OK';
    }

    const faultCodes = [];
    // Sort faults by row, col for deterministic output
    const sortedEntries = Array.from(state.faults.entries()).sort((a, b) => {
      if (a[1].row !== b[1].row) return a[1].row - b[1].row;
      return a[1].col - b[1].col;
    });

    for (const [_, f] of sortedEntries) {
      const prefix = f.type === 'SHORT' ? 'S' : 'O';
      faultCodes.push(`${prefix}-L${f.line}R${f.row}C${f.col}`);
    }

    return faultCodes.join('# ');
  }

  // Update HSR Display & JSON Payload View
  function updateHsrAndJson() {
    const hsr = calculateHsrString();
    liveHsrString.textContent = `"${hsr}"`;

    if (hsr === 'All OK') {
      liveHsrString.classList.remove('has-fault');
      matrixHsrSummary.textContent = 'HSR: "All OK"';
    } else {
      liveHsrString.classList.add('has-fault');
      matrixHsrSummary.textContent = `HSR: "${hsr.length > 25 ? hsr.slice(0, 22) + '...' : hsr}"`;
    }

    const payload = {
      vendor: state.config.vendor,
      device: state.config.device,
      IP: state.config.deviceIp,
      PF: state.config.platform,
      INT: parseInt(state.config.intensity, 10),
      HSR: hsr
    };

    liveJsonPayload.textContent = JSON.stringify(payload, null, 2);
  }

  // Update Alarm Status Banner Display
  function updateAlarmStatusDisplay() {
    if (!alarmStatusCard || !alarmStateBadge || !alarmStatusDesc) return;

    if (!state.activeAlarm) {
      alarmStatusCard.classList.remove('alarm-active');
      alarmStateBadge.className = 'alarm-state-badge status-healthy';
      alarmStateBadge.textContent = '🟢 SYSTEM HEALTHY (NO ACTIVE ALARM)';
      alarmStatusDesc.textContent = 'All LED pixels are operational. Traps stay active in NMS until the Clear Trap button is clicked.';
    } else {
      alarmStatusCard.classList.add('alarm-active');
      alarmStateBadge.className = 'alarm-state-badge status-alarm';
      alarmStateBadge.textContent = `🔴 ALARM ACTIVE: ${state.activeAlarm.type} CIRCUIT (L${state.activeAlarm.line} R${state.activeAlarm.row} C${state.activeAlarm.col})`;
      alarmStatusDesc.textContent = `Active Alarm dispatched to NMS at ${state.activeAlarm.time}. HSR: "${state.activeAlarm.hsr}". Click 'Clear Trap' to restore healthy status.`;
    }
  }

  // Update 13 Varbinds Table
  function updateVarbindTable() {
    const hsr = calculateHsrString();
    let eventCode = 100;
    let severity = 'INFO';
    let line = parseInt(inputLine.value, 10) || 1;
    let row = parseInt(inputRow.value, 10) || 10;
    let col = parseInt(inputCol.value, 10) || 15;
    let faultDesc = 'All LED pixels OK. Board healthy and functional.';

    if (state.faults.size > 0) {
      const firstFault = state.faults.values().next().value;
      line = firstFault.line;
      row = firstFault.row;
      col = firstFault.col;

      if (firstFault.type === 'SHORT') {
        eventCode = 102;
        severity = 'MAJOR';
        faultDesc = `LED SHORT Circuit detected at Line ${line} Row ${row} Col ${col}`;
      } else {
        eventCode = 103;
        severity = 'MAJOR';
        faultDesc = `LED OPEN Circuit detected at Line ${line} Row ${row} Col ${col}`;
      }
    } else {
      row = 0;
      col = 0;
    }

    const varbinds = [
      { num: 1, name: 'ipisVendorName', oid: '1.3.6.1.4.1.66731.3.1', type: 'OCTET STRING', val: state.config.vendor },
      { num: 2, name: 'ipisDeviceType', oid: '1.3.6.1.4.1.66731.3.2', type: 'OCTET STRING', val: state.config.device },
      { num: 3, name: 'ipisDeviceIp', oid: '1.3.6.1.4.1.66731.3.3', type: 'OCTET STRING', val: state.config.deviceIp },
      { num: 4, name: 'ipisPlatformNo', oid: '1.3.6.1.4.1.66731.3.4', type: 'OCTET STRING', val: state.config.platform },
      { num: 5, name: 'ipisIntensity', oid: '1.3.6.1.4.1.66731.3.5', type: 'INTEGER', val: state.config.intensity },
      { num: 6, name: 'ipisEventCode', oid: '1.3.6.1.4.1.66731.3.6', type: 'INTEGER', val: eventCode },
      { num: 7, name: 'ipisEventSeverity', oid: '1.3.6.1.4.1.66731.3.7', type: 'OCTET STRING', val: severity },
      { num: 8, name: 'ipisHealthStatusReport', oid: '1.3.6.1.4.1.66731.3.8', type: 'OCTET STRING', val: hsr },
      { num: 9, name: 'ipisFaultLine', oid: '1.3.6.1.4.1.66731.3.9', type: 'INTEGER', val: line },
      { num: 10, name: 'ipisFaultRow', oid: '1.3.6.1.4.1.66731.3.10', type: 'INTEGER', val: row },
      { num: 11, name: 'ipisFaultColumn', oid: '1.3.6.1.4.1.66731.3.11', type: 'INTEGER', val: col },
      { num: 12, name: 'ipisFaultDescription', oid: '1.3.6.1.4.1.66731.3.12', type: 'OCTET STRING', val: faultDesc },
      { num: 13, name: 'ipisBoardDimensions', oid: '1.3.6.1.4.1.66731.3.13', type: 'OCTET STRING', val: `${state.boardWidth}x${state.boardHeight}` }
    ];

    varbindTableBody.innerHTML = varbinds.map(vb => `
      <tr>
        <td style="color: var(--text-muted);">${vb.num}</td>
        <td style="color: #ffffff; font-weight: 600;">${vb.name}</td>
        <td class="oid-col">${vb.oid}</td>
        <td class="type-col">${vb.type}</td>
        <td class="val-col">${escapeHtml(String(vb.val))}</td>
      </tr>
    `).join('');
  }

  // Update button coordinate indicators and preset card labels
  function updateCoordButtonLabels() {
    const l = parseInt(inputLine.value, 10) || 1;
    const r = parseInt(inputRow.value, 10) || 10;
    const c = parseInt(inputCol.value, 10) || 15;

    document.querySelectorAll('.c-l').forEach(el => el.textContent = l);
    document.querySelectorAll('.c-r').forEach(el => el.textContent = r);
    document.querySelectorAll('.c-c').forEach(el => el.textContent = c);

    const presetShortSub = document.getElementById('presetShortSub');
    if (presetShortSub) {
      presetShortSub.textContent = `HSR: "S-L${l}R${r}C${c}" (Row ${r}, Col ${c})`;
    }
    const presetOpenSub = document.getElementById('presetOpenSub');
    if (presetOpenSub) {
      presetOpenSub.textContent = `HSR: "O-L${l}R${r}C${c}" (Row ${r}, Col ${c})`;
    }
  }

  // -------------------------------------------------------------
  // TRAP SENDING ACTIONS (REST API CALLS)
  // -------------------------------------------------------------

  async function sendTrapPreset(presetType, customData = {}) {
    showToast(`Transmitting ${presetType} Trap to NMS (${state.config.nmsIp}:162)...`, 'info');

    try {
      const response = await fetch('/api/send-preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          presetType: presetType,
          ...customData
        })
      });

      const data = await response.json();
      if (data.success) {
        showToast(`✅ Trap Sent Successfully! (Event Code: ${data.result.eventCode})`, 'success');
        fetchHistory();
      } else {
        showToast(`⚠️ Trap Dispatch Notice: ${data.error || 'Check network'}`, 'error');
      }
    } catch (err) {
      showToast(`Network Error: ${err.message}`, 'error');
    }
  }

  // 1. Clear Trap / Restore Healthy (EventCode: 100, HSR: "All OK")
  async function triggerClearTrap() {
    state.faults.clear();
    state.activeAlarm = null;
    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    updateAlarmStatusDisplay();
    await sendTrapPreset('CLEAR', {
      line: parseInt(inputLine.value, 10) || 1,
      hsr: 'All OK',
      faultDesc: 'All LED pixels OK. Board healthy and functional.'
    });
    showToast('🟢 Clear Trap dispatched to NMS (Alarm Cleared)', 'success');
  }

  // 2. SHORT Circuit Trap (EventCode: 102)
  async function triggerShortTrap() {
    const l = parseInt(inputLine.value, 10) || 1;
    const r = parseInt(inputRow.value, 10) || 10;
    const c = parseInt(inputCol.value, 10) || 15;
    const hsr = `S-L${l}R${r}C${c}`;
    const desc = `LED SHORT Circuit detected at Line ${l} Row ${r} Col ${c}`;

    state.faults.clear();
    state.faults.set(`${r}_${c}`, { line: l, row: r, col: c, type: 'SHORT' });
    state.activeAlarm = {
      type: 'SHORT',
      line: l,
      row: r,
      col: c,
      hsr: hsr,
      time: new Date().toLocaleTimeString()
    };

    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    updateAlarmStatusDisplay();

    await sendTrapPreset('SHORT', {
      line: l,
      row: r,
      col: c,
      hsr: hsr,
      faultDesc: desc
    });
  }

  // 3. OPEN Circuit Trap (EventCode: 103)
  async function triggerOpenTrap() {
    const l = parseInt(inputLine.value, 10) || 1;
    const r = parseInt(inputRow.value, 10) || 10;
    const c = parseInt(inputCol.value, 10) || 15;
    const hsr = `O-L${l}R${r}C${c}`;
    const desc = `LED OPEN Circuit detected at Line ${l} Row ${r} Col ${c}`;

    state.faults.clear();
    state.faults.set(`${r}_${c}`, { line: l, row: r, col: c, type: 'OPEN' });
    state.activeAlarm = {
      type: 'OPEN',
      line: l,
      row: r,
      col: c,
      hsr: hsr,
      time: new Date().toLocaleTimeString()
    };

    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    updateAlarmStatusDisplay();

    await sendTrapPreset('OPEN', {
      line: l,
      row: r,
      col: c,
      hsr: hsr,
      faultDesc: desc
    });
  }

  // 4. Send Active Matrix Trap
  async function triggerMatrixTrap() {
    const hsr = calculateHsrString();
    if (state.faults.size === 0) {
      await triggerClearTrap();
      return;
    }

    const firstFault = state.faults.values().next().value;
    const hasShort = Array.from(state.faults.values()).some(f => f.type === 'SHORT');
    const eventCode = hasShort ? 102 : 103;
    const primaryType = hasShort ? 'SHORT' : 'OPEN';

    let desc = '';
    if (state.faults.size === 1) {
      desc = `LED ${firstFault.type} Circuit detected at Line ${firstFault.line} Row ${firstFault.row} Col ${firstFault.col}`;
    } else {
      desc = `LED Matrix Faults: ${hsr}`;
    }

    state.activeAlarm = {
      type: state.faults.size === 1 ? primaryType : `MULTI-FAULT (${state.faults.size})`,
      line: firstFault.line,
      row: firstFault.row,
      col: firstFault.col,
      hsr: hsr,
      time: new Date().toLocaleTimeString()
    };
    updateAlarmStatusDisplay();

    await sendTrapPreset('MATRIX_STATE', {
      eventCode: eventCode,
      severity: 'MAJOR',
      line: firstFault.line,
      row: firstFault.row,
      col: firstFault.col,
      hsr: hsr,
      faultDesc: desc
    });
  }

  // Button Listeners for Presets
  btnPresetInfo.addEventListener('click', triggerClearTrap);
  if (btnMainClearTrap) btnMainClearTrap.addEventListener('click', triggerClearTrap);
  btnPresetShort.addEventListener('click', triggerShortTrap);
  btnPresetOpen.addEventListener('click', triggerOpenTrap);
  btnSendMatrixTrap.addEventListener('click', triggerMatrixTrap);

  // Button Listeners for Coordinate Bar Actions
  if (btnSendShortCoord) btnSendShortCoord.addEventListener('click', triggerShortTrap);
  if (btnSendOpenCoord) btnSendOpenCoord.addEventListener('click', triggerOpenTrap);
  if (btnSendClearCoord) btnSendClearCoord.addEventListener('click', triggerClearTrap);

  // 5. Run Full Automated Trap Test Cycle
  if (btnRunAutoTest) {
    btnRunAutoTest.addEventListener('click', async () => {
      const confirmRun = confirm('Run Automated 5-Step Trap Test Sequence?\n\nNote: Step 5 will transmit a Healthy / Clear trap to restore normal state.');
      if (!confirmRun) return;

      btnRunAutoTest.disabled = true;
      btnRunAutoTest.innerHTML = '<span class="icon">⏳</span><span class="btn-text">Running Auto Test...</span>';
      showToast('🚀 Starting Automated Trap Test Sequence (5 Cycles)...', 'info');

      try {
        const res = await fetch('/api/auto-test', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast(`🎉 Auto Test Completed! ${data.count} Traps Transmitted to NMS`, 'success');
          fetchHistory();
          // Reset matrix and alarm to healthy
          state.faults.clear();
          state.activeAlarm = null;
          renderMatrix();
          updateHsrAndJson();
          updateVarbindTable();
          updateAlarmStatusDisplay();
        } else {
          showToast('Auto test encountered an issue', 'error');
        }
      } catch (err) {
        showToast(`Auto test failed: ${err.message}`, 'error');
      } finally {
        btnRunAutoTest.disabled = false;
        btnRunAutoTest.innerHTML = '<span class="icon">🚀</span><span class="btn-text">Run Auto Test (All Traps)</span>';
      }
    });
  }

  // -------------------------------------------------------------
  // COORDINATE INJECTORS & BATCH CONTROLS
  // -------------------------------------------------------------

  btnInjectMulti.addEventListener('click', () => {
    state.faults.clear();
    // Inject exact sample from RDSO document image: S-L1R10C15# O-L1R10C15 (or nearby col)
    state.faults.set('10_15', { line: 1, row: 10, col: 15, type: 'SHORT' });
    state.faults.set('10_16', { line: 1, row: 10, col: 16, type: 'OPEN' });
    state.faults.set('25_40', { line: 1, row: 25, col: 40, type: 'SHORT' });
    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    syncFaultsToServer();
    showToast(`Injected Sample Multi-Fault (#)`, 'info');
  });

  btnRandomFaults.addEventListener('click', () => {
    state.faults.clear();
    for (let i = 0; i < 5; i++) {
      const r = Math.floor(Math.random() * state.boardHeight) + 1;
      const c = Math.floor(Math.random() * state.boardWidth) + 1;
      const type = Math.random() > 0.5 ? 'SHORT' : 'OPEN';
      state.faults.set(`${r}_${c}`, { line: 1, row: r, col: c, type });
    }
    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    syncFaultsToServer();
    showToast(`Injected 5 Random Pixel Faults`, 'info');
  });

  btnClearAllFaults.addEventListener('click', () => {
    state.faults.clear();
    renderMatrix();
    updateHsrAndJson();
    updateVarbindTable();
    syncFaultsToServer();
    showToast(`Matrix Cleared -> All OK`, 'info');
  });

  // Copy JSON Payload
  btnCopyJson.addEventListener('click', () => {
    const text = liveJsonPayload.textContent;
    navigator.clipboard.writeText(text).then(() => {
      showToast('JSON payload copied to clipboard!', 'success');
    });
  });

  // -------------------------------------------------------------
  // HISTORY LOG FETCHING & RENDERING
  // -------------------------------------------------------------

  async function fetchHistory() {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      state.history = data.history || [];
      renderHistory();
    } catch (e) { }
  }

  function renderHistory() {
    if (state.history.length === 0) {
      emptyHistoryMsg.style.display = 'block';
      trapHistoryList.innerHTML = '';
      trapHistoryList.appendChild(emptyHistoryMsg);
      return;
    }

    emptyHistoryMsg.style.display = 'none';
    trapHistoryList.innerHTML = state.history.map(item => {
      const isInfo = item.eventCode === 100;
      const timeStr = new Date(item.timestamp).toLocaleTimeString();
      return `
        <div class="history-item ${isInfo ? 'status-info' : 'status-major'}">
          <div class="history-item-top">
            <span class="history-event">
              ${isInfo ? '🟢' : '🔴'} Event ${item.eventCode} (${item.severity})
            </span>
            <span class="history-time">${timeStr}</span>
          </div>
          <div class="history-item-mid">
            HSR: "${escapeHtml(item.hsr)}"
          </div>
          <div class="history-item-bot">
            <span>Target: ${item.target} (UDP 162)</span>
            <span>${item.status} (${item.varbindsCount} Varbinds)</span>
          </div>
        </div>
      `;
    }).join('');
  }

  btnClearHistory.addEventListener('click', async () => {
    await fetch('/api/clear-history', { method: 'POST' });
    fetchHistory();
    showToast('Trap history cleared', 'info');
  });

  // -------------------------------------------------------------
  // NETWORK & SETTINGS
  // -------------------------------------------------------------

  async function fetchNetworkInfo() {
    try {
      const res = await fetch('/api/network-info');
      const data = await res.json();
      if (data.qrDataUrl) {
        qrCodeImage.src = data.qrDataUrl;
      }
      qrUrlLink.textContent = data.primaryUrl;
      qrUrlLink.href = data.primaryUrl;

      if (Array.isArray(data.allIps)) {
        networkInterfaces = data.allIps.filter(i => !i.internal);
        populateInterfaceSelector();
      }

      networkInterfacesList.innerHTML = data.allIps.map(iface => `
        <div class="iface-item" style="cursor: pointer;" title="Click to use this IP" onclick="window.switchActiveNetworkIp('${iface.ip}', '${iface.url}')">
          <span>${iface.name}</span>
          <strong>${iface.url}</strong>
        </div>
      `).join('');
    } catch (e) { }
  }

  window.switchActiveNetworkIp = function(ip, url) {
    if (qrUrlLink) {
      qrUrlLink.textContent = url;
      qrUrlLink.href = url;
    }
    if (selectApiInterface) {
      selectApiInterface.value = ip;
      updateApiModalUrls();
    }
    showToast(`Switched active host IP to: ${ip}`, 'info');
  };

  function populateInterfaceSelector() {
    if (!selectApiInterface) return;
    const currentVal = selectApiInterface.value;
    selectApiInterface.innerHTML = '';

    networkInterfaces.forEach(iface => {
      const opt = document.createElement('option');
      opt.value = iface.ip;
      opt.textContent = `${iface.name}: ${iface.ip} (Port ${state.config.port || 8080})`;
      selectApiInterface.appendChild(opt);
    });

    const localOpt = document.createElement('option');
    localOpt.value = 'localhost';
    localOpt.textContent = `Localhost (127.0.0.1:8080)`;
    selectApiInterface.appendChild(localOpt);

    if (currentVal && Array.from(selectApiInterface.options).some(o => o.value === currentVal)) {
      selectApiInterface.value = currentVal;
    } else if (networkInterfaces.length > 0) {
      selectApiInterface.value = networkInterfaces[0].ip;
    }
  }

  function getSelectedHostUrl() {
    if (selectApiInterface && selectApiInterface.value && selectApiInterface.value !== 'auto') {
      const port = state.config.port || 8080;
      const host = selectApiInterface.value === 'localhost' ? 'localhost' : selectApiInterface.value;
      return `http://${host}:${port}`;
    }
    return window.location.origin;
  }

  async function fetchConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.config) {
        state.config = data.config;
        headerNmsTarget.textContent = `${state.config.nmsIp}:${state.config.nmsPort} (UDP)`;
        headerBoardType.textContent = `${state.config.device} (${state.boardWidth}×${state.boardHeight})`;

        // Fill settings form
        if (document.getElementById('cfgDeviceIp')) {
          document.getElementById('cfgDeviceIp').value = state.config.deviceIp || '10.0.0.81';
        }
        document.getElementById('cfgNmsIp').value = state.config.nmsIp;
        document.getElementById('cfgNmsPort').value = state.config.nmsPort;
        document.getElementById('cfgUsmUser').value = state.config.usmUser;
        document.getElementById('cfgEngineId').value = state.config.engineId;
        document.getElementById('cfgAuthKey').value = state.config.authKey;
        document.getElementById('cfgPrivKey').value = state.config.privKey;
        document.getElementById('cfgVendor').value = state.config.vendor;
        document.getElementById('cfgDevice').value = state.config.device;
        document.getElementById('cfgPlatform').value = state.config.platform;
        document.getElementById('cfgIntensity').value = state.config.intensity;
      }
    } catch (e) { }
  }

  // Save Settings
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const updated = {
      nmsIp: document.getElementById('cfgNmsIp').value,
      nmsPort: parseInt(document.getElementById('cfgNmsPort').value, 10),
      deviceIp: document.getElementById('cfgDeviceIp') ? document.getElementById('cfgDeviceIp').value : state.config.deviceIp,
      usmUser: document.getElementById('cfgUsmUser').value,
      engineId: document.getElementById('cfgEngineId').value,
      authKey: document.getElementById('cfgAuthKey').value,
      privKey: document.getElementById('cfgPrivKey').value,
      vendor: document.getElementById('cfgVendor').value,
      device: document.getElementById('cfgDevice').value,
      platform: document.getElementById('cfgPlatform').value,
      intensity: parseInt(document.getElementById('cfgIntensity').value, 10)
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      const data = await res.json();
      if (data.success) {
        state.config = data.config;
        headerNmsTarget.textContent = `${state.config.nmsIp}:${state.config.nmsPort} (UDP)`;
        headerBoardType.textContent = `${state.config.device} (${state.boardWidth}×${state.boardHeight})`;
        settingsModalBackdrop.classList.remove('active');
        updateHsrAndJson();
        updateVarbindTable();
        showToast('Settings saved successfully', 'success');
      }
    } catch (err) {
      showToast(`Failed to save settings: ${err.message}`, 'error');
    }
  });

  // Modal Triggers
  btnPhoneConnect.addEventListener('click', () => {
    fetchNetworkInfo();
    qrModalBackdrop.classList.add('active');
  });
  btnCloseQrModal.addEventListener('click', () => qrModalBackdrop.classList.remove('active'));

  btnOpenSettings.addEventListener('click', () => settingsModalBackdrop.classList.add('active'));
  btnCloseSettingsModal.addEventListener('click', () => settingsModalBackdrop.classList.remove('active'));
  btnCancelSettings.addEventListener('click', () => settingsModalBackdrop.classList.remove('active'));

  // -------------------------------------------------------------
  // SHAREABLE LED FAULTS GET API MODAL LOGIC
  // -------------------------------------------------------------
  async function fetchApiLivePreview() {
    try {
      if (apiLivePreviewCode) {
        apiLivePreviewCode.textContent = 'Loading live GET /api/led-short response...';
      }
      const res = await fetch('/api/led-short');
      const data = await res.json();
      if (apiLivePreviewCode) {
        apiLivePreviewCode.textContent = JSON.stringify(data, null, 2);
      }
    } catch (err) {
      if (apiLivePreviewCode) {
        apiLivePreviewCode.textContent = `Error fetching API: ${err.message}`;
      }
    }
  }

  function updateApiModalUrls() {
    const baseUrl = getSelectedHostUrl();
    const shortUrl = `${baseUrl}/api/led-short`;
    const faultsUrl = `${baseUrl}/api/led-faults`;
    const shortOnlyUrl = `${baseUrl}/api/led-short?type=short`;
    const rawHsrUrl = `${baseUrl}/api/led-short?raw=hsr`;
    const l = parseInt(inputLine.value, 10) || 1;
    const r = parseInt(inputRow.value, 10) || 10;
    const c = parseInt(inputCol.value, 10) || 15;
    const coordUrl = `${baseUrl}/api/led-short?line=${l}&row=${r}&col=${c}`;
    const curlCmd = `curl -s ${shortUrl}`;

    if (apiShortUrlText) apiShortUrlText.textContent = shortUrl;
    if (apiFaultsUrlText) apiFaultsUrlText.textContent = faultsUrl;
    if (apiShortOnlyUrlText) apiShortOnlyUrlText.textContent = shortOnlyUrl;
    if (apiRawHsrUrlText) apiRawHsrUrlText.textContent = rawHsrUrl;
    if (apiCoordCheckUrlText) apiCoordCheckUrlText.textContent = coordUrl;
    if (curlCommandText) curlCommandText.textContent = curlCmd;
    if (btnOpenApiInTab) btnOpenApiInTab.href = shortUrl;
  }

  if (selectApiInterface) {
    selectApiInterface.addEventListener('change', () => {
      updateApiModalUrls();
      showToast(`Switched API link to: ${selectApiInterface.value}`, 'info');
    });
  }

  if (btnOpenApiModal) {
    btnOpenApiModal.addEventListener('click', () => {
      updateApiModalUrls();
      fetchApiLivePreview();
      if (apiModalBackdrop) apiModalBackdrop.classList.add('active');
    });
  }

  if (btnCloseApiModal) {
    btnCloseApiModal.addEventListener('click', () => {
      if (apiModalBackdrop) apiModalBackdrop.classList.remove('active');
    });
  }

  if (btnCopyApiUrl) {
    btnCopyApiUrl.addEventListener('click', () => {
      const url = apiShortUrlText ? apiShortUrlText.textContent : `${window.location.origin}/api/led-short`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('🔗 GET API Link copied to clipboard! Ready to share.', 'success');
      });
    });
  }

  if (btnCopyCurlCmd) {
    btnCopyCurlCmd.addEventListener('click', () => {
      const cmd = curlCommandText ? curlCommandText.textContent : `curl -s ${window.location.origin}/api/led-short`;
      navigator.clipboard.writeText(cmd).then(() => {
        showToast('💻 cURL command copied to clipboard!', 'success');
      });
    });
  }

  if (btnRefreshApiPreview) {
    btnRefreshApiPreview.addEventListener('click', () => {
      fetchApiLivePreview();
      showToast('Live API response refreshed', 'info');
    });
  }

  // -------------------------------------------------------------
  // CANVAS MOUSE & TOUCH EVENT LISTENERS
  // -------------------------------------------------------------

  function setupEventListeners() {
    // Tool buttons
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeTool = btn.dataset.tool;
      });
    });

    // Zoom buttons
    document.getElementById('btnZoomFit').addEventListener('click', () => applyZoom('fit'));
    document.getElementById('btnZoom1x').addEventListener('click', () => applyZoom(1));
    document.getElementById('btnZoom2x').addEventListener('click', () => applyZoom(2));
    document.getElementById('btnZoom4x').addEventListener('click', () => applyZoom(4));

    // Canvas Interaction
    canvas.addEventListener('mousedown', (e) => {
      state.isMouseDown = true;
      const coords = getMatrixCoords(e);
      if (coords) applyToolAtCoord(coords.col, coords.row);
    });

    canvas.addEventListener('mousemove', (e) => {
      const coords = getMatrixCoords(e);
      if (coords) {
        cursorPosReadout.textContent = `L${state.line} R${coords.row} C${coords.col}`;
        if (state.isMouseDown) {
          applyToolAtCoord(coords.col, coords.row);
        }
      } else {
        cursorPosReadout.textContent = `L${state.line} R-- C--`;
      }
    });

    window.addEventListener('mouseup', () => {
      state.isMouseDown = false;
    });

    // Touch Support for Phones / Tablets
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const coords = getMatrixCoords(e);
      if (coords) applyToolAtCoord(coords.col, coords.row);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const coords = getMatrixCoords(e);
      if (coords) {
        cursorPosReadout.textContent = `L${state.line} R${coords.row} C${coords.col}`;
        applyToolAtCoord(coords.col, coords.row);
      }
    }, { passive: false });

    // Coordinate input change handlers
    [inputLine, inputRow, inputCol].forEach(inp => {
      inp.addEventListener('input', () => {
        state.line = parseInt(inputLine.value, 10) || 1;
        updateCoordButtonLabels();
        updateVarbindTable();
      });
    });

    // Window Resize -> Re-fit zoom if on fit mode
    window.addEventListener('resize', () => {
      if (state.zoomLevel === 'fit') applyZoom('fit');
    });
  }

  // Toast Notification System
  function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
    toast.innerHTML = `<span class="icon">${icon}</span><span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Run on page load
  document.addEventListener('DOMContentLoaded', init);

})();
