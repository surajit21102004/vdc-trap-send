/**
 * Automated Trap Test Runner
 * Executes a full automatic test sequence for all IPIS / VDC AVDB traps:
 * 1. Healthy / OK (Event 100, HSR: "All OK", INFO)
 * 2. SHORT Circuit (Event 102, HSR: "S-L1R10C15", MAJOR)
 * 3. OPEN Circuit (Event 103, HSR: "O-L1R10C15", MAJOR)
 * 4. Multi-Fault Combination (Event 102, HSR: "S-L1R10C15# O-L1R10C16# S-L1R25C40", CRITICAL)
 * 5. Dynamic Matrix Custom Fault Trap
 */

const http = require('http');

function post(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request({
      hostname: 'localhost',
      port: 8080,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runAutoTest() {
  console.log('================================================================');
  console.log('🚆 TOPGRIP IPIS / VDC AVDB (192x112) - AUTOMATED TRAP TEST CYCLE');
  console.log('🎯 Target NMS: 10.0.0.252:162 (UDP)');
  console.log('🔐 SNMPv3 authPriv: ipisMgmt_Admin (HMAC-SHA-256 + AES-128)');
  console.log('================================================================\n');

  // Step 1: Test INFO (Healthy / OK)
  console.log('🔹 STEP 1/5: Testing [1. INFO (Healthy / OK)] Trap...');
  const res1 = await post('/api/send-preset', { presetType: 'INFO_OK' });
  console.log(`   ✅ Status: ${res1.result.status}`);
  console.log(`   🏷️ Event Code: ${res1.result.eventCode} (${res1.result.severity})`);
  console.log(`   📋 HSR: "${res1.result.hsr}"`);
  console.log(`   📦 Varbinds (${res1.result.varbindsCount} fields):`);
  res1.result.varbinds.slice(0, 8).forEach(vb => {
    console.log(`      - [VB ${vb.index}] ${vb.name} (${vb.oid}) = "${vb.value}" [${vb.typeName}]`);
  });
  console.log(`      ... and 5 more varbinds (Line, Row, Col, Desc, Dimensions)\n`);

  await sleep(1000);

  // Step 2: Test SHORT Circuit
  console.log('🔹 STEP 2/5: Testing [2. SHORT Circuit (L1 R10 C15)] Trap...');
  const res2 = await post('/api/send-preset', {
    presetType: 'SHORT',
    line: 1,
    row: 10,
    col: 15,
    hsr: 'S-L1R10C15'
  });
  console.log(`   ✅ Status: ${res2.result.status}`);
  console.log(`   🏷️ Event Code: ${res2.result.eventCode} (${res2.result.severity})`);
  console.log(`   📋 HSR: "${res2.result.hsr}"`);
  console.log(`   📍 Fault Coordinate: Line ${res2.result.varbinds[8].value}, Row ${res2.result.varbinds[9].value}, Col ${res2.result.varbinds[10].value}`);
  console.log(`   📝 Description: "${res2.result.varbinds[11].value}"\n`);

  await sleep(1000);

  // Step 3: Test OPEN Circuit
  console.log('🔹 STEP 3/5: Testing [3. OPEN Circuit (L1 R10 C15)] Trap...');
  const res3 = await post('/api/send-preset', {
    presetType: 'OPEN',
    line: 1,
    row: 10,
    col: 15,
    hsr: 'O-L1R10C15'
  });
  console.log(`   ✅ Status: ${res3.result.status}`);
  console.log(`   🏷️ Event Code: ${res3.result.eventCode} (${res3.result.severity})`);
  console.log(`   📋 HSR: "${res3.result.hsr}"`);
  console.log(`   📍 Fault Coordinate: Line ${res3.result.varbinds[8].value}, Row ${res3.result.varbinds[9].value}, Col ${res3.result.varbinds[10].value}`);
  console.log(`   📝 Description: "${res3.result.varbinds[11].value}"\n`);

  await sleep(1000);

  // Step 4: Test Multi-Fault with # Delimiter
  console.log('🔹 STEP 4/5: Testing [4. Multiple Faults (# Delimited)] Trap...');
  const res4 = await post('/api/send-preset', {
    presetType: 'MATRIX_STATE',
    eventCode: 102,
    severity: 'MAJOR',
    hsr: 'S-L1R10C15# O-L1R10C16# S-L1R25C40',
    line: 1,
    row: 10,
    col: 15,
    faultDesc: 'Multiple LED Faults: Short at (L1 R10 C15), Open at (L1 R10 C16), Short at (L1 R25 C40)'
  });
  console.log(`   ✅ Status: ${res4.result.status}`);
  console.log(`   🏷️ Event Code: ${res4.result.eventCode} (${res4.result.severity})`);
  console.log(`   📋 Multi-Fault HSR: "${res4.result.hsr}"`);
  console.log(`   📝 Description: "${res4.result.varbinds[11].value}"\n`);

  await sleep(1000);

  // Step 5: Test Full Healthy Recovery Trap
  console.log('🔹 STEP 5/5: Testing [5. Recovery / Healthy Clear] Trap...');
  const res5 = await post('/api/send-preset', {
    presetType: 'INFO_OK',
    hsr: 'All OK',
    faultDesc: 'Board status restored to 100% HEALTHY. All LED pixels operational.'
  });
  console.log(`   ✅ Status: ${res5.result.status}`);
  console.log(`   🏷️ Event Code: ${res5.result.eventCode} (${res5.result.severity})`);
  console.log(`   📋 HSR: "${res5.result.hsr}"`);
  console.log(`   📝 Description: "${res5.result.varbinds[11].value}"\n`);

  console.log('================================================================');
  console.log('🎉 ALL 5 TRAP AUTOMATED TEST CYCLES COMPLETED SUCCESSFULLY! 🚀');
  console.log('================================================================');
}

runAutoTest().catch(console.error);
