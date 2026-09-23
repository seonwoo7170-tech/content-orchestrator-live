#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import time
import uuid
from email import policy
from email.parser import BytesParser
from pathlib import Path

BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "live_hardening",
    BASE / "live-repair-hardening-20260923.py",
)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("LIVE_HARDENING_IMPORT_FAILED")
mod = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mod
SPEC.loader.exec_module(mod)

MAIN_MODULE = {
    "api-hub-v2": "index.js",
    "content-orchestrator": "mcp-entry.js",
}


def extract_modules(content, body: bytes):
    synthetic = (
        f"Content-Type: {content.content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
        + body
    )
    message = BytesParser(policy=policy.default).parsebytes(synthetic)
    parts = []
    if not message.is_multipart():
        raise RuntimeError(f"LIVE_CONTENT_NOT_MULTIPART:{content.name}:{content.content_type}")
    for index, part in enumerate(message.iter_parts(), 1):
        filename = part.get_filename()
        name = part.get_param("name", header="content-disposition")
        candidate = str(filename or name or f"part-{index}")
        ctype = part.get_content_type() or "application/octet-stream"
        if candidate.lower() in {"metadata", "metadata.json"} or ctype == "application/json":
            continue
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        parts.append((candidate, ctype, payload))
    main = MAIN_MODULE[content.name]
    if not any(name == main for name, _, _ in parts):
        raise RuntimeError(f"LIVE_MAIN_MODULE_NOT_FOUND:{content.name}:{main}:{[p[0] for p in parts]}")
    return parts


def build_upload(content, body: bytes):
    parts = extract_modules(content, body)
    boundary = f"----smileseon-live-hardening-{uuid.uuid4().hex}"
    chunks = []

    def add(value: bytes):
        chunks.append(value)

    metadata = json.dumps({"main_module": MAIN_MODULE[content.name]}, separators=(",", ":")).encode("utf-8")
    add(f"--{boundary}\r\n".encode())
    add(b'Content-Disposition: form-data; name="metadata"\r\n')
    add(b"Content-Type: application/json\r\n\r\n")
    add(metadata)
    add(b"\r\n")

    for name, ctype, payload in parts:
        safe_name = name.replace('"', "")
        add(f"--{boundary}\r\n".encode())
        add(f'Content-Disposition: form-data; name="{safe_name}"; filename="{safe_name}"\r\n'.encode())
        add(f"Content-Type: {ctype}\r\n\r\n".encode())
        add(payload)
        add(b"\r\n")

    add(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def put_content(content, body: bytes):
    upload_body, upload_type = build_upload(content, body)
    url = f"{mod.API}/accounts/{mod.ACCOUNT}/workers/scripts/{content.name}/content"
    status, _, result = mod.request(
        "PUT",
        url,
        body=upload_body,
        content_type=upload_type,
        timeout=90,
    )
    if not 200 <= status < 300:
        raise RuntimeError(f"PUT_CONTENT_{content.name}_{status}")
    text = result.decode("utf-8", errors="replace")
    if '"success":false' in text.replace(" ", "").lower():
        raise RuntimeError(f"PUT_CONTENT_FAILED:{content.name}:{text[:2000]}")
    print(f"PUT_CONTENT_OK:{content.name}")


def main():
    before_hub = mod.get_content("api-hub-v2")
    before_orch = mod.get_content("content-orchestrator")

    after_hub = mod.patch_hub(before_hub.body)
    after_orch = mod.patch_orchestrator(before_orch.body)
    print("PATCH_STATIC_CHECKS_OK")

    hub_done = False
    orch_done = False
    try:
        put_content(before_hub, after_hub)
        hub_done = True
        put_content(before_orch, after_orch)
        orch_done = True
        time.sleep(2)
        mod.verify_live()
        mod.health_check()
    except Exception:
        print("LIVE_PATCH_FAILED_ROLLING_BACK")
        if orch_done:
            try:
                put_content(before_orch, before_orch.body)
                print("ORCHESTRATOR_ROLLBACK_OK")
            except Exception as exc:
                print(f"ORCHESTRATOR_ROLLBACK_FAILED:{exc}")
        if hub_done:
            try:
                put_content(before_hub, before_hub.body)
                print("API_HUB_ROLLBACK_OK")
            except Exception as exc:
                print(f"API_HUB_ROLLBACK_FAILED:{exc}")
        raise

    print("LIVE_PATCH_DEPLOYED_OK")


if __name__ == "__main__":
    main()
