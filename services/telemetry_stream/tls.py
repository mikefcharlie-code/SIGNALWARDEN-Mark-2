"""TLS configuration for the telemetry WebSocket listener."""
from __future__ import annotations

import ssl
from pathlib import Path


def build_tls_context(certfile: str, keyfile: str, cafile: str | None = None, require_client_certificate: bool = False) -> ssl.SSLContext:
    if not certfile or not keyfile:
        raise ValueError("TLS certificate and private key files are required")
    if not Path(certfile).is_file() or not Path(keyfile).is_file():
        raise FileNotFoundError("TLS certificate or private key file was not found")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.options |= ssl.OP_NO_COMPRESSION
    context.load_cert_chain(certfile=certfile, keyfile=keyfile)
    if require_client_certificate:
        if not cafile or not Path(cafile).is_file():
            raise FileNotFoundError("CA file is required for client certificate verification")
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_verify_locations(cafile=cafile)
    return context
