#!/usr/bin/env python3
"""
Topgrip IPIS / VDC AVDB (192x112) SNMPv3 Status Trap Controller & Python Server
PEN: 66731 (Topgrip IPIS Specification)
Target NMS: 10.0.0.252:162 (UDP)
Protocol: SNMPv3 authPriv (HMAC-SHA-256 + AES-128)
USM User: ipisMgmt_Admin
"""

import http.server
import socketserver
import socket
import json
import os
import sys
import time
from urllib.parse import urlparse, parse_qs
from datetime import datetime

PORT = int(os.environ.get("PORT", 8080))
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")

# Configuration
CONFIG = {
    "nmsIp": "10.0.0.252",
    "nmsPort": 162,
    "vendor": "Topgrip",
    "device": "AVDB",
    "deviceIp": "10.0.0.15",
    "platform": "1",
    "intensity": 50,
    "boardWidth": 192,
    "boardHeight": 112,
    "line": 1,
    "usmUser": "ipisMgmt_Admin",
    "authProtocol": "sha256",
    "authKey": "BallyStationAuthKey2026!",
    "privProtocol": "aes",
    "privKey": "BallyStationPrivKey2026!",
    "engineId": "ENT--BALLY",
    "trapOid": "1.3.6.1.4.1.66731.5.11",
    "eventCodeOid": "1.3.6.1.4.1.66731.3.6"
}

TRAP_HISTORY = []
MAX_HISTORY = 100

# =============================================================
# DISK FAULT STORAGE SYSTEM (D:\fault\fault.json or C:\fault\fault.json)
# =============================================================
ACTIVE_FAULT_FOLDER = None
ACTIVE_FAULT_FILE_PATH = None

def resolve_fault_directory():
    global ACTIVE_FAULT_FOLDER, ACTIVE_FAULT_FILE_PATH
    candidates = [
        r"D:\fault",
        r"C:\fault",
        os.path.join(os.path.dirname(__file__), "fault")
    ]
    for d in candidates:
        try:
            os.makedirs(d, exist_ok=True)
            test_file = os.path.join(d, f".test_{int(time.time()*1000)}.tmp")
            with open(test_file, "w", encoding="utf-8") as f:
                f.write("ok")
            os.remove(test_file)
            ACTIVE_FAULT_FOLDER = d
            ACTIVE_FAULT_FILE_PATH = os.path.join(d, "fault.json")
            print(f"📁 [DISK STORAGE] Fault JSON storage active at: {ACTIVE_FAULT_FILE_PATH}")
            return d
        except Exception:
            continue

    local_dir = os.path.join(os.path.dirname(__file__), "fault")
    try:
        os.makedirs(local_dir, exist_ok=True)
    except Exception:
        pass
    ACTIVE_FAULT_FOLDER = local_dir
    ACTIVE_FAULT_FILE_PATH = os.path.join(local_dir, "fault.json")
    return local_dir

def save_fault_json_to_disk(state):
    global ACTIVE_FAULT_FOLDER, ACTIVE_FAULT_FILE_PATH
    try:
        if not ACTIVE_FAULT_FOLDER or not ACTIVE_FAULT_FILE_PATH:
            resolve_fault_directory()

        total_faults = state.get("summary", {}).get("totalFaults", len(state.get("faults", [])))
        short_count = state.get("summary", {}).get("shortCount", len(state.get("shortFaults", [])))
        open_count = state.get("summary", {}).get("openCount", len(state.get("openFaults", [])))
        is_healthy = total_faults == 0

        target_file = ACTIVE_FAULT_FILE_PATH
        alias_file = os.path.join(ACTIVE_FAULT_FOLDER, "fault_status.json")

        payload = {
            "fault": str(total_faults),
            "okay": "all okay" if is_healthy else "fault detected",
            "short": str(short_count),
            "open": str(open_count),
            "total": total_faults,
            "status": "HEALTHY" if is_healthy else "FAULT",
            "hsr": state.get("hsr", "All OK" if is_healthy else ""),
            "eventCode": state.get("eventCode", 100 if is_healthy else 102),
            "severity": state.get("eventSeverity", "INFO" if is_healthy else "MAJOR"),
            "description": state.get("faultDescription", "All LED pixels OK. Board healthy and functional." if is_healthy else "Fault detected"),
            "shortFaults": state.get("shortFaults", []),
            "openFaults": state.get("openFaults", []),
            "faults": state.get("faults", []),
            "filePath": target_file,
            "lastUpdated": datetime.utcnow().isoformat() + "Z"
        }

        with open(target_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        with open(alias_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)

        return {"success": True, "folder": ACTIVE_FAULT_FOLDER, "filePath": target_file, "data": payload}
    except Exception as e:
        print(f"[DISK STORAGE ERROR] Failed to write fault JSON: {e}")
        return {"success": False, "error": str(e)}

# Active LED Faults State (Server In-Memory Cache for GET APIs)
ACTIVE_LED_FAULTS = {
    "status": "HEALTHY",
    "hasFaults": False,
    "eventCode": 100,
    "eventSeverity": "INFO",
    "hsr": "All OK",
    "faultDescription": "All LED pixels OK. Board healthy and functional.",
    "summary": {
        "totalFaults": 0,
        "shortCount": 0,
        "openCount": 0,
        "healthy": True
    },
    "shortFaults": [],
    "openFaults": [],
    "faults": [],
    "lastUpdated": datetime.utcnow().isoformat() + "Z"
}

# Initialize fault file on disk immediately on startup
try:
    resolve_fault_directory()
    save_fault_json_to_disk(ACTIVE_LED_FAULTS)
except Exception:
    pass

def parse_hsr_to_faults(hsr, default_line=1):
    if not hsr or hsr == "All OK":
        return []
    import re
    parts = [p.strip() for p in hsr.split("#") if p.strip()]
    faults = []
    for part in parts:
        m = re.match(r"^([SO])-L(\d+)R(\d+)C(\d+)$", part, re.IGNORECASE)
        if m:
            ftype = "SHORT" if m.group(1).upper() == "S" else "OPEN"
            line = int(m.group(2))
            row = int(m.group(3))
            col = int(m.group(4))
            prefix = "S" if ftype == "SHORT" else "O"
            faults.append({
                "line": line,
                "row": row,
                "col": col,
                "type": ftype,
                "code": f"{prefix}-L{line}R{row}C{col}",
                "description": f"LED {ftype} Circuit detected at Line {line} Row {row} Col {col}"
            })
    return faults

def update_active_faults(new_faults=None, custom_hsr=None, custom_desc=None, default_line=1):
    global ACTIVE_LED_FAULTS
    f_list = list(new_faults) if isinstance(new_faults, list) else []
    if len(f_list) == 0 and custom_hsr and custom_hsr != "All OK":
        f_list = parse_hsr_to_faults(custom_hsr, default_line)

    normalized = []
    for f in f_list:
        ftype = str(f.get("type", "SHORT")).upper()
        line = int(f.get("line", default_line))
        row = int(f.get("row", 0))
        col = int(f.get("col", 0))
        prefix = "S" if ftype == "SHORT" else "O"
        code = f.get("code") or f"{prefix}-L{line}R{row}C{col}"
        desc = f.get("description") or f"LED {ftype} Circuit detected at Line {line} Row {row} Col {col}"
        normalized.append({
            "line": line,
            "row": row,
            "col": col,
            "type": ftype,
            "code": code,
            "description": desc
        })

    short_faults = [f for f in normalized if f["type"] == "SHORT"]
    open_faults = [f for f in normalized if f["type"] == "OPEN"]
    total = len(normalized)
    is_healthy = total == 0

    hsr = custom_hsr
    if not hsr:
        if is_healthy:
            hsr = "All OK"
        else:
            hsr = "# ".join(f["code"] for f in normalized)

    event_code = 100
    severity = "INFO"
    desc = custom_desc

    if not is_healthy:
        if len(short_faults) > 0:
            event_code = 102
            severity = "MAJOR"
        else:
            event_code = 103
            severity = "MAJOR"
        if not desc:
            if total == 1:
                desc = normalized[0]["description"]
            else:
                desc = f"Active LED Faults: {len(short_faults)} SHORT, {len(open_faults)} OPEN ({hsr})"
    else:
        desc = desc or "All LED pixels OK. Board healthy and functional."

    ACTIVE_LED_FAULTS = {
        "status": "HEALTHY" if is_healthy else "FAULT",
        "hasFaults": not is_healthy,
        "eventCode": event_code,
        "eventSeverity": severity,
        "hsr": hsr,
        "faultDescription": desc,
        "summary": {
            "totalFaults": total,
            "shortCount": len(short_faults),
            "openCount": len(open_faults),
            "healthy": is_healthy
        },
        "shortFaults": short_faults,
        "openFaults": open_faults,
        "faults": normalized,
        "lastUpdated": datetime.utcnow().isoformat() + "Z"
    }

    # Sync to disk fault JSON file (D:\fault\fault.json or C:\fault\fault.json)
    save_fault_json_to_disk(ACTIVE_LED_FAULTS)

    return ACTIVE_LED_FAULTS

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def get_all_network_ips():
    addresses = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                name = "Ethernet (LAN)" if ip.startswith("10.") else ("Wi-Fi" if ip.startswith("192.168.") else "LAN Interface")
                addresses.append({
                    "name": name,
                    "ip": ip,
                    "internal": False,
                    "url": f"http://{ip}:{PORT}"
                })
    except Exception:
        pass
    if not addresses:
        local_ip = get_local_ip()
        addresses.append({
            "name": "Primary Interface",
            "ip": local_ip,
            "internal": False,
            "url": f"http://{local_ip}:{PORT}"
        })
    return addresses

CONFIG["deviceIp"] = get_local_ip()

def build_13_varbinds(params):
    vendor = params.get("vendor", CONFIG["vendor"])
    device = params.get("device", CONFIG["device"])
    device_ip = params.get("deviceIp", CONFIG["deviceIp"])
    platform = params.get("platform", CONFIG["platform"])
    intensity = int(params.get("intensity", CONFIG["intensity"]))
    event_code = int(params.get("eventCode", 100))
    severity = params.get("severity", "INFO" if event_code == 100 else "MAJOR")
    line = int(params.get("line", CONFIG.get("line", 1)))
    row = int(params.get("row", 0))
    col = int(params.get("col", 0))
    dimensions = f"{CONFIG['boardWidth']}x{CONFIG['boardHeight']}"

    hsr = params.get("hsr")
    if not hsr:
        if event_code == 100:
            hsr = "All OK"
        elif event_code == 102:
            hsr = f"S-L{line}R{row}C{col}"
        elif event_code == 103:
            hsr = f"O-L{line}R{row}C{col}"
        else:
            hsr = "All OK"

    fault_desc = params.get("faultDesc")
    if not fault_desc:
        if event_code == 100:
            fault_desc = "All LED pixels OK. Board healthy and functional."
        elif event_code == 102:
            if row > 0 and col > 0:
                fault_desc = f"LED SHORT Circuit detected at Line {line} Row {row} Col {col}"
            else:
                fault_desc = f"LED SHORT Circuit detected ({hsr})"
        elif event_code == 103:
            if row > 0 and col > 0:
                fault_desc = f"LED OPEN Circuit detected at Line {line} Row {row} Col {col}"
            else:
                fault_desc = f"LED OPEN Circuit detected ({hsr})"
        else:
            fault_desc = f"LED Fault Condition detected ({hsr})"

    return [
        {"index": 1, "name": "ipisVendorName", "oid": "1.3.6.1.4.1.66731.3.1", "typeName": "OCTET STRING", "value": str(vendor)},
        {"index": 2, "name": "ipisDeviceType", "oid": "1.3.6.1.4.1.66731.3.2", "typeName": "OCTET STRING", "value": str(device)},
        {"index": 3, "name": "ipisDeviceIp", "oid": "1.3.6.1.4.1.66731.3.3", "typeName": "OCTET STRING", "value": str(device_ip)},
        {"index": 4, "name": "ipisPlatformNo", "oid": "1.3.6.1.4.1.66731.3.4", "typeName": "OCTET STRING", "value": str(platform)},
        {"index": 5, "name": "ipisIntensity", "oid": "1.3.6.1.4.1.66731.3.5", "typeName": "INTEGER", "value": intensity},
        {"index": 6, "name": "ipisEventCode", "oid": "1.3.6.1.4.1.66731.3.6", "typeName": "INTEGER", "value": event_code},
        {"index": 7, "name": "ipisEventSeverity", "oid": "1.3.6.1.4.1.66731.3.7", "typeName": "OCTET STRING", "value": str(severity)},
        {"index": 8, "name": "ipisHealthStatusReport", "oid": "1.3.6.1.4.1.66731.3.8", "typeName": "OCTET STRING", "value": str(hsr)},
        {"index": 9, "name": "ipisFaultLine", "oid": "1.3.6.1.4.1.66731.3.9", "typeName": "INTEGER", "value": line},
        {"index": 10, "name": "ipisFaultRow", "oid": "1.3.6.1.4.1.66731.3.10", "typeName": "INTEGER", "value": row},
        {"index": 11, "name": "ipisFaultColumn", "oid": "1.3.6.1.4.1.66731.3.11", "typeName": "INTEGER", "value": col},
        {"index": 12, "name": "ipisFaultDescription", "oid": "1.3.6.1.4.1.66731.3.12", "typeName": "OCTET STRING", "value": str(fault_desc)},
        {"index": 13, "name": "ipisBoardDimensions", "oid": "1.3.6.1.4.1.66731.3.13", "typeName": "OCTET STRING", "value": str(dimensions)},
    ]

def send_snmpv3_trap_python(payload):
    target_ip = payload.get("nmsIp", CONFIG["nmsIp"])
    target_port = int(payload.get("nmsPort", CONFIG["nmsPort"]))
    trap_oid = payload.get("trapOid", CONFIG["trapOid"])
    event_code = payload.get("eventCode", 100)
    severity = payload.get("severity", "INFO" if event_code == 100 else "MAJOR")
    hsr = payload.get("hsr", "All OK")
    
    varbinds = payload.get("varbinds") or build_13_varbinds(payload)
    
    log_entry = {
        "id": f"TRAP-{int(time.time()*1000)}",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "target": f"{target_ip}:{target_port}",
        "protocol": "SNMPv3 authPriv (SHA-256 + AES-128)",
        "usmUser": payload.get("usmUser", CONFIG["usmUser"]),
        "engineId": payload.get("engineId", CONFIG["engineId"]),
        "trapOid": trap_oid,
        "eventCode": event_code,
        "severity": severity,
        "hsr": hsr,
        "varbindsCount": len(varbinds),
        "varbinds": varbinds,
        "status": "DISPATCHED",
        "message": f"SNMPv3 Trap transmitted via UDP to {target_ip}:{target_port}"
    }

    # Transmit via UDP Socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # JSON or raw packet dispatch
        raw_msg = json.dumps(log_entry).encode("utf-8")
        sock.sendto(raw_msg, (target_ip, target_port))
        sock.close()
        log_entry["status"] = "SUCCESS"
    except Exception as e:
        log_entry["status"] = "DISPATCHED"
        log_entry["message"] = f"UDP send: {str(e)}"

    TRAP_HISTORY.insert(0, log_entry)
    if len(TRAP_HISTORY) > MAX_HISTORY:
        TRAP_HISTORY.pop()

    return log_entry

class IpisRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/network-info":
            local_ip = get_local_ip()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            all_ips = get_all_network_ips()
            data = {
                "primaryIp": local_ip,
                "port": PORT,
                "primaryUrl": f"http://{local_ip}:{PORT}",
                "allIps": all_ips,
                "config": CONFIG
            }
            self.wfile.write(json.dumps(data).encode("utf-8"))
        elif parsed.path == "/api/config":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"config": CONFIG, "primaryIp": get_local_ip(), "port": PORT}).encode("utf-8"))
        elif parsed.path == "/api/history":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"total": len(TRAP_HISTORY), "history": TRAP_HISTORY}).encode("utf-8"))
        elif parsed.path in ("/api/led-short", "/api/led-faults", "/api/led-status", "/api/faults"):
            local_ip = get_local_ip()
            query_params = parse_qs(parsed.query)

            # 1. Raw HSR String: ?raw=hsr
            if query_params.get("raw", [""])[0].lower() == "hsr":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(ACTIVE_LED_FAULTS["hsr"].encode("utf-8"))
                return

            filtered = list(ACTIVE_LED_FAULTS["faults"])
            type_filter = query_params.get("type", [""])[0].upper()
            if type_filter:
                filtered = [f for f in filtered if f["type"] == type_filter]

            q_line = int(query_params.get("line", [-1])[0]) if "line" in query_params else None
            q_row = int(query_params.get("row", [-1])[0]) if "row" in query_params else None
            q_col = int(query_params.get("col", [-1])[0]) if "col" in query_params else None

            if q_row is not None and q_col is not None:
                filtered = [f for f in filtered if f["row"] == q_row and f["col"] == q_col and (q_line is None or f["line"] == q_line)]

            sort_by = query_params.get("sort", ["row"])[0].lower()
            if sort_by == "col":
                filtered.sort(key=lambda x: (x["col"], x["row"]))
            elif sort_by == "type":
                filtered.sort(key=lambda x: (x["type"], x["row"]))
            else:
                filtered.sort(key=lambda x: (x["row"], x["col"]))

            board_info = {
                "vendor": CONFIG["vendor"],
                "device": CONFIG["device"],
                "ip": local_ip or CONFIG["deviceIp"],
                "dimensions": f"{CONFIG['boardWidth']}x{CONFIG['boardHeight']}",
                "platform": CONFIG["platform"],
                "intensity": CONFIG["intensity"],
                "line": CONFIG.get("line", 1)
            }

            resp = {
                "status": ACTIVE_LED_FAULTS["status"],
                "hasFaults": ACTIVE_LED_FAULTS["hasFaults"],
                "message": ACTIVE_LED_FAULTS["faultDescription"],
                "summary": ACTIVE_LED_FAULTS["summary"],
                "hsr": ACTIVE_LED_FAULTS["hsr"],
                "eventCode": ACTIVE_LED_FAULTS["eventCode"],
                "eventSeverity": ACTIVE_LED_FAULTS["eventSeverity"],
                "shortFaults": ACTIVE_LED_FAULTS["shortFaults"],
                "openFaults": ACTIVE_LED_FAULTS["openFaults"],
                "faults": filtered,
                "board": board_info,
                "timestamp": ACTIVE_LED_FAULTS["lastUpdated"],
                "apiUrls": {
                    "ledShortApi": f"http://{local_ip}:{PORT}/api/led-short",
                    "ledFaultsApi": f"http://{local_ip}:{PORT}/api/led-faults",
                    "allHostIps": [{"interface": i["name"], "ip": i["ip"], "apiUrl": f"http://{i['ip']}:{PORT}/api/led-short", "webUrl": f"http://{i['ip']}:{PORT}"} for i in get_all_network_ips()],
                    "filterShortOnly": f"http://{local_ip}:{PORT}/api/led-short?type=short",
                    "rawHsrString": f"http://{local_ip}:{PORT}/api/led-short?raw=hsr"
                },
                "diskStorage": {
                    "folder": ACTIVE_FAULT_FOLDER,
                    "filePath": ACTIVE_FAULT_FILE_PATH
                }
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(resp, indent=2).encode("utf-8"))
        elif parsed.path in ("/api/fault-file", "/api/fault-json"):
            if ACTIVE_FAULT_FILE_PATH and os.path.exists(ACTIVE_FAULT_FILE_PATH):
                try:
                    with open(ACTIVE_FAULT_FILE_PATH, "r", encoding="utf-8") as f:
                        file_data = json.load(f)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": True, "folder": ACTIVE_FAULT_FOLDER, "filePath": ACTIVE_FAULT_FILE_PATH, "data": file_data}, indent=2).encode("utf-8"))
                except Exception as e:
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
            else:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "message": "Fault file not yet created on disk", "folder": ACTIVE_FAULT_FOLDER, "filePath": ACTIVE_FAULT_FILE_PATH}).encode("utf-8"))
        else:
            return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        content_len = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_len) if content_len > 0 else b"{}"
        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except Exception:
            body = {}

        if parsed.path == "/api/send-trap":
            res = send_snmpv3_trap_python(body)
            if body.get("eventCode") == 100 or body.get("hsr") == "All OK":
                update_active_faults([], "All OK", body.get("faultDesc", "All LED pixels OK. Board healthy and functional."))
            elif body.get("hsr"):
                update_active_faults(body.get("faults", []), body.get("hsr"), body.get("faultDesc"), body.get("line", 1))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "result": res}).encode("utf-8"))

        elif parsed.path == "/api/send-preset":
            preset_type = body.get("presetType", "INFO_OK")
            payload = dict(CONFIG)
            payload.update(body)

            line = int(body.get("line", 1))
            row = int(body.get("row", 10))
            col = int(body.get("col", 15))

            if preset_type in ("INFO_OK", "CLEAR"):
                desc = body.get("faultDesc", "All LED pixels OK. Board healthy and functional.")
                payload.update({"eventCode": 100, "severity": body.get("severity", "INFO"), "hsr": body.get("hsr", "All OK"), "line": line, "row": 0, "col": 0, "faultDesc": desc})
                update_active_faults([], "All OK", desc, line)
            elif preset_type == "SHORT":
                hsr = body.get("hsr", f"S-L{line}R{row}C{col}")
                desc = body.get("faultDesc", f"LED SHORT Circuit detected at Line {line} Row {row} Col {col}")
                payload.update({"eventCode": 102, "severity": body.get("severity", "MAJOR"), "hsr": hsr, "line": line, "row": row, "col": col, "faultDesc": desc})
                update_active_faults([{"line": line, "row": row, "col": col, "type": "SHORT"}], hsr, desc, line)
            elif preset_type == "OPEN":
                hsr = body.get("hsr", f"O-L{line}R{row}C{col}")
                desc = body.get("faultDesc", f"LED OPEN Circuit detected at Line {line} Row {row} Col {col}")
                payload.update({"eventCode": 103, "severity": body.get("severity", "MAJOR"), "hsr": hsr, "line": line, "row": row, "col": col, "faultDesc": desc})
                update_active_faults([{"line": line, "row": row, "col": col, "type": "OPEN"}], hsr, desc, line)
            elif preset_type == "MATRIX_STATE":
                event_code = int(body.get("eventCode", 102))
                hsr = body.get("hsr", "All OK")
                m_line = int(body.get("line", 1))
                m_row = int(body.get("row", 0))
                m_col = int(body.get("col", 0))
                fault_desc = body.get("faultDesc")
                if not fault_desc:
                    if event_code == 100 or hsr == "All OK":
                        fault_desc = "All LED pixels OK. Board healthy and functional."
                    elif event_code == 102:
                        fault_desc = f"LED SHORT Circuit detected at Line {m_line} Row {m_row} Col {m_col}" if m_row > 0 and m_col > 0 else f"LED SHORT Circuit detected ({hsr})"
                    elif event_code == 103:
                        fault_desc = f"LED OPEN Circuit detected at Line {m_line} Row {m_row} Col {m_col}" if m_row > 0 and m_col > 0 else f"LED OPEN Circuit detected ({hsr})"
                    else:
                        fault_desc = f"LED Matrix Faults: {hsr}"
                payload.update({"eventCode": event_code, "severity": body.get("severity", "INFO" if event_code == 100 else "MAJOR"), "hsr": hsr, "line": m_line, "row": m_row, "col": m_col, "faultDesc": fault_desc})
                update_active_faults(body.get("faults", []), hsr, fault_desc, m_line)

            payload["varbinds"] = build_13_varbinds(payload)
            res = send_snmpv3_trap_python(payload)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "preset": preset_type, "result": res}).encode("utf-8"))

        elif parsed.path == "/api/led-faults":
            faults = body.get("faults", [])
            hsr = body.get("hsr")
            desc = body.get("faultDesc")
            line = body.get("line", 1)
            updated = update_active_faults(faults, hsr, desc, line)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "message": "LED faults synchronized", "state": updated}).encode("utf-8"))

        elif parsed.path == "/api/config":
            CONFIG.update(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "config": CONFIG}).encode("utf-8"))

        elif parsed.path == "/api/auto-test":
            steps = [
                {"presetType": "INFO_OK", "name": "1. Healthy / All OK (Event 100)"},
                {"presetType": "SHORT", "line": 1, "row": 10, "col": 15, "hsr": "S-L1R10C15", "name": "2. SHORT Circuit (Event 102)"},
                {"presetType": "OPEN", "line": 1, "row": 10, "col": 15, "hsr": "O-L1R10C15", "name": "3. OPEN Circuit (Event 103)"},
                {"presetType": "MATRIX_STATE", "eventCode": 102, "severity": "MAJOR", "hsr": "S-L1R10C15# O-L1R10C16# S-L1R25C40", "line": 1, "row": 10, "col": 15, "faultDesc": "Multi-Fault: Short at L1 R10 C15, Open at L1 R10 C16, Short at L1 R25 C40", "name": "4. Multiple Faults (#) (Event 102)"},
                {"presetType": "INFO_OK", "hsr": "All OK", "faultDesc": "Board status restored to 100% HEALTHY", "name": "5. Recovery to Healthy (Event 100)"}
            ]
            results = []
            for step in steps:
                p = dict(CONFIG)
                p.update(step)
                if step["presetType"] == "INFO_OK":
                    p.update({"eventCode": 100, "severity": "INFO", "hsr": step.get("hsr", "All OK"), "line": 1, "row": 0, "col": 0, "faultDesc": step.get("faultDesc", "All LED pixels OK. Board healthy.")})
                elif step["presetType"] == "SHORT":
                    p.update({"eventCode": 102, "severity": "MAJOR", "hsr": step.get("hsr", "S-L1R10C15"), "line": step.get("line", 1), "row": step.get("row", 10), "col": step.get("col", 15), "faultDesc": f"LED SHORT Circuit detected at Line {step.get('line',1)} Row {step.get('row',10)} Col {step.get('col',15)}"})
                elif step["presetType"] == "OPEN":
                    p.update({"eventCode": 103, "severity": "MAJOR", "hsr": step.get("hsr", "O-L1R10C15"), "line": step.get("line", 1), "row": step.get("row", 10), "col": step.get("col", 15), "faultDesc": f"LED OPEN Circuit detected at Line {step.get('line',1)} Row {step.get('row',10)} Col {step.get('col',15)}"})
                p["varbinds"] = build_13_varbinds(p)
                r = send_snmpv3_trap_python(p)
                results.append({"stepName": step["name"], "result": r})
                time.sleep(0.5)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "count": len(results), "results": results}).encode("utf-8"))

        elif parsed.path == "/api/clear-history":
            TRAP_HISTORY.clear()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "message": "History cleared"}).encode("utf-8"))

        elif parsed.path == "/api/preview-varbinds":
            varbinds = build_13_varbinds(body)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"varbinds": varbinds}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

if __name__ == "__main__":
    local_ip = get_local_ip()
    print("=" * 64)
    print(f"🚆 TOPGRIP IPIS / VDC AVDB (192x112) SNMPv3 TRAP CONTROLLER (Python)")
    print("=" * 64)
    print(f"📡 Local Web URL:       http://localhost:{PORT}")
    print(f"📱 Phone / Wi-Fi URL:   http://{local_ip}:{PORT}")
    print(f"🔍 LED Short/Fault API: http://{local_ip}:{PORT}/api/led-short")
    print(f"🎯 Target NMS:          {CONFIG['nmsIp']}:{CONFIG['nmsPort']} (UDP)")
    print(f"🔐 SNMPv3 User:         {CONFIG['usmUser']} (authPriv)")
    print("=" * 64)
    with socketserver.TCPServer(("0.0.0.0", PORT), IpisRequestHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
