# 🚆 Topgrip IPIS / VDC AVDB (192×112) SNMPv3 Trap Controller & LED Matrix Simulator

A web-based controller and simulator for **Topgrip IPIS / VDC Video Display Boards (PEN 66731)**. Features a 192×112 addressable LED diode matrix simulator with pixel-level fault injection (Short/Open), real-time HSR string encoder, 13 Varbind inspector, and full SNMPv3 `authPriv` trap dispatching to the NMS (`10.0.0.252:162`).

---

## ⚡ Quick Start

### 1. Launch the Server
Double-click `start.bat` or run in your terminal:
```bash
node server.js
```
*(Or with Python: `python server.py`)*

### 2. Open in Browser
- **On this PC**: [http://localhost:8080](http://localhost:8080)
- **On any Phone / Tablet on the same Wi-Fi**: Click the **📱 Phone Wi-Fi QR** button at the top right and scan the QR code with your phone camera!

---

## 🔐 SNMPv3 & NMS Specifications (Compliant with RDSO / Topgrip IPIS)

| Parameter | Configured Value |
|---|---|
| **Target NMS IP** | `10.0.0.252` |
| **Target NMS Port** | `162` (UDP) |
| **Security Level** | `authPriv` (Authentication + Privacy) |
| **USM Username** | `ipisMgmt_Admin` |
| **Auth Protocol** | `HMAC-SHA-256` |
| **Auth Key** | `BallyStationAuthKey2026!` |
| **Priv Protocol** | `AES-128` |
| **Priv Key** | `BallyStationPrivKey2026!` |
| **Enterprise Engine ID** | `ENT--BALLY` |
| **Notification / Trap OID** | `1.3.6.1.4.1.66731.5.11` (`ipisVdcStatusTrap`) |
| **Event Code OID** | `1.3.6.1.4.1.66731.3.6` (`ipisEventCode`) |

---

## 🎯 1-Click Trap Actions

1. 🟢 **1. Healthy / All OK (INFO)**:
   - Event Code: `100`
   - Severity: `INFO`
   - HSR: `"All OK"`
2. 🔴 **2. SHORT Circuit (MAJOR)**:
   - Event Code: `102`
   - Severity: `MAJOR`
   - HSR: `"S-L1R10C15"` (Line 1, Row 10, Col 15)
3. 🟠 **3. OPEN Circuit (MAJOR)**:
   - Event Code: `103`
   - Severity: `MAJOR`
   - HSR: `"O-L1R10C15"` (Line 1, Row 10, Col 15)
4. ⚡ **4. Live Active Matrix Faults**:
   - Encodes all active canvas faults into the standard multi-fault `#`-delimited format (e.g. `S-L1R10C15# O-L1R10C15`) and transmits to NMS.

---

## 📋 Topgrip IPIS 13 Varbinds Table

| # | Field Name | OID | SNMP Type | Sample Value |
|---|---|---|---|---|
| 1 | `ipisVendorName` | `1.3.6.1.4.1.66731.3.1` | OCTET STRING | `"Topgrip"` |
| 2 | `ipisDeviceType` | `1.3.6.1.4.1.66731.3.2` | OCTET STRING | `"AVDB"` |
| 3 | `ipisDeviceIp` | `1.3.6.1.4.1.66731.3.3` | OCTET STRING | `"10.0.0.15"` |
| 4 | `ipisPlatformNo` | `1.3.6.1.4.1.66731.3.4` | OCTET STRING | `"1"` |
| 5 | `ipisIntensity` | `1.3.6.1.4.1.66731.3.5` | INTEGER | `50` |
| 6 | `ipisEventCode` | `1.3.6.1.4.1.66731.3.6` | INTEGER | `100` / `102` / `103` |
| 7 | `ipisEventSeverity` | `1.3.6.1.4.1.66731.3.7` | OCTET STRING | `"INFO"` / `"MAJOR"` |
| 8 | `ipisHealthStatusReport` | `1.3.6.1.4.1.66731.3.8` | OCTET STRING | `"All OK"` / `"S-L1R10C15# O-L1R10C15"` |
| 9 | `ipisFaultLine` | `1.3.6.1.4.1.66731.3.9` | INTEGER | `1` |
| 10 | `ipisFaultRow` | `1.3.6.1.4.1.66731.3.10` | INTEGER | `10` |
| 11 | `ipisFaultColumn` | `1.3.6.1.4.1.66731.3.11` | INTEGER | `15` |
| 12 | `ipisFaultDescription` | `1.3.6.1.4.1.66731.3.12` | OCTET STRING | `"LED SHORT Circuit detected..."` |
| 13 | `ipisBoardDimensions` | `1.3.6.1.4.1.66731.3.13` | OCTET STRING | `"192x112"` |

---

## 🔗 Shareable LED Faults & Short Circuit GET API

You can share these standard HTTP `GET` endpoints with any colleague, tester, script, or monitoring software to inspect which LEDs are currently faulty or shorted.

### 📡 Main Endpoint
- **URL**: `GET http://<IP>:8080/api/led-short` *(or `http://localhost:8080/api/led-short`)*
- **Aliases**: `GET /api/led-faults`, `GET /api/led-status`, `GET /api/faults`

### 💡 Example cURL
```bash
curl -s http://localhost:8080/api/led-short
```

### 📄 Sample JSON Response (When LED Short Circuit is Active)
```json
{
  "status": "FAULT",
  "hasFaults": true,
  "message": "LED SHORT Circuit detected at Line 1 Row 10 Col 15",
  "summary": {
    "totalFaults": 1,
    "shortCount": 1,
    "openCount": 0,
    "healthy": false
  },
  "hsr": "S-L1R10C15",
  "eventCode": 102,
  "eventSeverity": "MAJOR",
  "shortFaults": [
    {
      "line": 1,
      "row": 10,
      "col": 15,
      "type": "SHORT",
      "code": "S-L1R10C15",
      "description": "LED SHORT Circuit detected at Line 1 Row 10 Col 15"
    }
  ],
  "openFaults": [],
  "faults": [
    {
      "line": 1,
      "row": 10,
      "col": 15,
      "type": "SHORT",
      "code": "S-L1R10C15",
      "description": "LED SHORT Circuit detected at Line 1 Row 10 Col 15"
    }
  ],
  "board": {
    "vendor": "Topgrip",
    "device": "AVDB",
    "ip": "10.0.0.15",
    "dimensions": "192x112",
    "platform": "1",
    "intensity": 50,
    "line": 1
  },
  "timestamp": "2026-11-26T11:06:17.000Z"
}
```

### 📄 Sample JSON Response (When Board is Healthy / All OK)
```json
{
  "status": "HEALTHY",
  "hasFaults": false,
  "message": "All LED pixels OK. Board healthy and functional.",
  "summary": {
    "totalFaults": 0,
    "shortCount": 0,
    "openCount": 0,
    "healthy": true
  },
  "hsr": "All OK",
  "eventCode": 100,
  "eventSeverity": "INFO",
  "shortFaults": [],
  "openFaults": [],
  "faults": [],
  "board": {
    "vendor": "Topgrip",
    "device": "AVDB",
    "ip": "10.0.0.15",
    "dimensions": "192x112",
    "platform": "1",
    "intensity": 50,
    "line": 1
  },
  "timestamp": "2026-11-26T11:06:17.000Z"
}
```

### 🔍 Query Options & Filters
| Query Parameter | Description | Example URL |
|---|---|---|
| `?type=short` | Filter and return only SHORT circuit faults | `/api/led-short?type=short` |
| `?type=open` | Filter and return only OPEN circuit faults | `/api/led-short?type=open` |
| `?line=1&row=10&col=15` | Check if a specific LED coordinate is faulty | `/api/led-short?row=10&col=15` |
| `?raw=hsr` | Return just the raw HSR string (`S-L1R10C15` or `All OK`) | `/api/led-short?raw=hsr` |
| `?sort=col` | Sort faults by column instead of row | `/api/led-short?sort=col` |

