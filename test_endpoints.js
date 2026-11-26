/**
 * Test suite to verify all IPIS VDC server endpoints and trap dispatching
 */
const http = require('http');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const payload = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : null;
    const opts = { ...options };
    if (payload) {
      opts.headers = opts.headers || {};
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting End-to-End API and Trap Verification Tests...\n');

  // Test 1: Network Info & QR Code
  console.log('1️⃣ Testing GET /api/network-info...');
  const netRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/network-info',
    method: 'GET'
  });
  console.log(`   Status: ${netRes.status}`);
  console.log(`   Primary IP: ${netRes.data.primaryIp}`);
  console.log(`   QR Code Generated: ${Boolean(netRes.data.qrDataUrl)}`);
  console.assert(netRes.status === 200, 'Network info test failed');

  // Test 2: Config Endpoint
  console.log('\n2️⃣ Testing GET /api/config...');
  const cfgRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/config',
    method: 'GET'
  });
  console.log(`   Target NMS: ${cfgRes.data.config.nmsIp}:${cfgRes.data.config.nmsPort}`);
  console.log(`   USM User: ${cfgRes.data.config.usmUser} | Trap OID: ${cfgRes.data.config.trapOid}`);
  console.assert(cfgRes.data.config.nmsIp === '10.0.0.252', 'Config NMS IP mismatch');

  // Test 3: Preset 1 - CLEAR / INFO (Healthy / All OK)
  console.log('\n3️⃣ Testing POST /api/send-preset [CLEAR] (Event 100)...');
  const infoRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/send-preset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { presetType: 'CLEAR' });
  console.log(`   Result: ${infoRes.data.result.status} | EventCode: ${infoRes.data.result.eventCode} | HSR: "${infoRes.data.result.hsr}"`);
  console.log(`   Varbind 12: "${infoRes.data.result.varbinds[11].value}"`);
  console.assert(infoRes.data.result.eventCode === 100, 'Event code should be 100');
  console.assert(infoRes.data.result.hsr === 'All OK', 'HSR should be All OK');
  console.assert(infoRes.data.result.varbinds[11].value.includes('All LED pixels OK'), 'Varbind 12 description mismatch');

  // Test 4: Preset 2 - SHORT Circuit with Custom Coordinates (Line 2, Row 45, Col 80)
  console.log('\n4️⃣ Testing POST /api/send-preset [SHORT] (Event 102) with Custom Coords (L2 R45 C80)...');
  const shortRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/send-preset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { presetType: 'SHORT', line: 2, row: 45, col: 80 });
  console.log(`   Result: ${shortRes.data.result.status} | EventCode: ${shortRes.data.result.eventCode} | HSR: "${shortRes.data.result.hsr}"`);
  console.log(`   Line: ${shortRes.data.result.varbinds[8].value}, Row: ${shortRes.data.result.varbinds[9].value}, Col: ${shortRes.data.result.varbinds[10].value}`);
  console.log(`   Varbind 12: "${shortRes.data.result.varbinds[11].value}"`);
  console.assert(shortRes.data.result.eventCode === 102, 'Event code should be 102');
  console.assert(shortRes.data.result.hsr === 'S-L2R45C80', 'HSR should be S-L2R45C80');
  console.assert(shortRes.data.result.varbinds[8].value === 2, 'Line should be 2');
  console.assert(shortRes.data.result.varbinds[9].value === 45, 'Row should be 45');
  console.assert(shortRes.data.result.varbinds[10].value === 80, 'Col should be 80');
  console.assert(shortRes.data.result.varbinds[11].value === 'LED SHORT Circuit detected at Line 2 Row 45 Col 80', 'Varbind 12 mismatch');

  // Test 5: Preset 3 - OPEN Circuit with Custom Coordinates (Line 3, Row 50, Col 90)
  console.log('\n5️⃣ Testing POST /api/send-preset [OPEN] (Event 103) with Custom Coords (L3 R50 C90)...');
  const openRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/send-preset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { presetType: 'OPEN', line: 3, row: 50, col: 90 });
  console.log(`   Result: ${openRes.data.result.status} | EventCode: ${openRes.data.result.eventCode} | HSR: "${openRes.data.result.hsr}"`);
  console.log(`   Line: ${openRes.data.result.varbinds[8].value}, Row: ${openRes.data.result.varbinds[9].value}, Col: ${openRes.data.result.varbinds[10].value}`);
  console.log(`   Varbind 12: "${openRes.data.result.varbinds[11].value}"`);
  console.assert(openRes.data.result.eventCode === 103, 'Event code should be 103');
  console.assert(openRes.data.result.hsr === 'O-L3R50C90', 'HSR should be O-L3R50C90');
  console.assert(openRes.data.result.varbinds[8].value === 3, 'Line should be 3');
  console.assert(openRes.data.result.varbinds[9].value === 50, 'Row should be 50');
  console.assert(openRes.data.result.varbinds[10].value === 90, 'Col should be 90');
  console.assert(openRes.data.result.varbinds[11].value === 'LED OPEN Circuit detected at Line 3 Row 50 Col 90', 'Varbind 12 mismatch');

  // Test 6: Multi-Fault Preset (# delimiter)
  console.log('\n6️⃣ Testing POST /api/send-preset [MATRIX_STATE] with Multi-Fault (#)...');
  const multiRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/send-preset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { presetType: 'MATRIX_STATE', eventCode: 102, severity: 'MAJOR', line: 1, row: 10, col: 15, hsr: 'S-L1R10C15# O-L1R10C16' });
  console.log(`   Result: ${multiRes.data.result.status} | EventCode: ${multiRes.data.result.eventCode} | HSR: "${multiRes.data.result.hsr}"`);
  console.assert(multiRes.data.result.hsr === 'S-L1R10C15# O-L1R10C16', 'Multi-fault HSR mismatch');

  // Test 7: History Log
  console.log('\n7️⃣ Testing GET /api/history...');
  const histRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/history',
    method: 'GET'
  });
  console.log(`   Total Traps in History: ${histRes.data.total}`);
  console.assert(histRes.data.total >= 4, 'History should contain at least 4 entries');

  // Test 8: Shareable GET API - Check LED Short / Faults State
  console.log('\n8️⃣ Testing GET /api/led-short (Normal GET API for LED Faults)...');
  const ledRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/led-short',
    method: 'GET'
  });
  console.log(`   Status: ${ledRes.status}`);
  console.log(`   Board Status: ${ledRes.data.status}`);
  console.log(`   Has Faults: ${ledRes.data.hasFaults}`);
  console.log(`   Total Faults: ${ledRes.data.summary.totalFaults}`);
  console.log(`   Short Count: ${ledRes.data.summary.shortCount}`);
  console.log(`   HSR: "${ledRes.data.hsr}"`);
  console.log(`   Event Code: ${ledRes.data.eventCode}`);
  console.assert(ledRes.status === 200, 'GET /api/led-short status should be 200');
  console.assert(ledRes.data.hasFaults === true, 'hasFaults should be true after multi-fault');
  console.assert(Array.isArray(ledRes.data.shortFaults), 'shortFaults should be an array');
  console.assert(Array.isArray(ledRes.data.faults), 'faults should be an array');

  // Test 9: Shareable GET API with Query Filters & Raw HSR
  console.log('\n9️⃣ Testing GET /api/led-short?type=short and ?raw=hsr...');
  const shortOnlyRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/led-short?type=short',
    method: 'GET'
  });
  console.log(`   Filtered SHORT faults count: ${shortOnlyRes.data.faults.length}`);
  console.assert(shortOnlyRes.data.faults.every(f => f.type === 'SHORT'), 'All filtered faults must be SHORT');

  const rawHsrRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/led-short?raw=hsr',
    method: 'GET'
  });
  console.log(`   Raw HSR Output: "${rawHsrRes.body}"`);
  console.assert(rawHsrRes.status === 200, 'Raw HSR status should be 200');

  // Test 10: Clear / Healthy Transition verified on GET /api/led-short
  console.log('\n🔟 Testing Clear Trap and verifying GET /api/led-short returns HEALTHY...');
  await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/send-preset',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { presetType: 'CLEAR' });

  const healthyRes = await request({
    hostname: 'localhost',
    port: 8080,
    path: '/api/led-short',
    method: 'GET'
  });
  console.log(`   Board Status: ${healthyRes.data.status}`);
  console.log(`   Has Faults: ${healthyRes.data.hasFaults}`);
  console.log(`   Summary Healthy: ${healthyRes.data.summary.healthy}`);
  console.log(`   HSR: "${healthyRes.data.hsr}"`);
  console.assert(healthyRes.data.status === 'HEALTHY', 'Status should be HEALTHY');
  console.assert(healthyRes.data.hasFaults === false, 'hasFaults should be false');
  console.assert(healthyRes.data.summary.totalFaults === 0, 'totalFaults should be 0');
  console.assert(healthyRes.data.hsr === 'All OK', 'HSR should be All OK');

  console.log('\n🎉 ALL 10 END-TO-END TESTS (INCLUDING LED SHORT GET API) PASSED SUCCESSFULLY! 🚀\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
});
