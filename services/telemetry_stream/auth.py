"""Authentication and authorization for the telemetry WebSocket stream."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Mapping

import jwt
from jwt import InvalidTokenError


class AuthenticationError(Exception):
    """Safe-to-report authentication failure; never includes token contents."""

    def __init__(self, code: str = "invalid_token"):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TokenPrincipal:
    subject: str
    scopes: frozenset[str]
    aircraft_ids: frozenset[str] | None = None
    sources: frozenset[str] | None = None

    def can_read(self, aircraft_id: str | None, source: str | None) -> bool:
        if "telemetry:read" not in self.scopes:
            return False
        if self.aircraft_ids is not None:
            if aircraft_id is None or aircraft_id not in self.aircraft_ids:
                return False
        if self.sources is not None:
            if source is None or source not in self.sources:
                return False
        return True


class TokenVerifier:
    """Verify HS256 JWTs with mandatory standard claims and stream scope."""

    def __init__(self, secret: str, issuer: str, audience: str, leeway_seconds: int = 5):
        if len(secret) < 32:
            raise ValueError("JWT secret must be at least 32 characters")
        if not issuer or not audience:
            raise ValueError("JWT issuer and audience are required")
        self.secret = secret.encode("utf-8")
        self.issuer = issuer
        self.audience = audience
        self.leeway_seconds = leeway_seconds

    @classmethod
    def from_env(cls) -> "TokenVerifier":
        return cls(
            secret=os.environ["UCAS_STREAM_JWT_SECRET"],
            issuer=os.environ.get("UCAS_STREAM_JWT_ISSUER", "ucas-management"),
            audience=os.environ.get("UCAS_STREAM_JWT_AUDIENCE", "ucas-telemetry"),
            leeway_seconds=int(os.environ.get("UCAS_STREAM_JWT_LEEWAY_SECONDS", "5")),
        )

    @staticmethod
    def _string_set(value: Any, claim: str) -> frozenset[str] | None:
        if value is None:
            return None
        if isinstance(value, str):
            values = value.split()
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            values = value
        else:
            raise AuthenticationError(f"invalid_{claim}")
        if not values:
            raise AuthenticationError(f"invalid_{claim}")
        return frozenset(values)

    def verify(self, token: str) -> TokenPrincipal:
        if not token or len(token) > 8192:
            raise AuthenticationError()
        try:
            claims = jwt.decode(
                token,
                self.secret,
                algorithms=["HS256"],
                audience=self.audience,
                issuer=self.issuer,
                leeway=self.leeway_seconds,
                options={"require": ["exp", "iat", "nbf", "iss", "aud", "sub"]},
            )
        except (InvalidTokenError, ValueError):
            raise AuthenticationError() from None
        if not isinstance(claims, Mapping) or not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise AuthenticationError()
        scopes = self._string_set(claims.get("scope"), "scope") or frozenset()
        if "telemetry:read" not in scopes:
            raise AuthenticationError("insufficient_scope")
        return TokenPrincipal(
            subject=claims["sub"],
            scopes=scopes,
            aircraft_ids=self._string_set(claims.get("aircraft_ids"), "aircraft_ids"),
            sources=self._string_set(claims.get("sources"), "sources"),
        )


def extract_token(websocket: Any) -> str | None:
    """Read Authorization or a browser-compatible bearer subprotocol.

    Query-string tokens are deliberately unsupported because URLs are commonly
    logged by proxies and browsers.
    """
    request = getattr(websocket, "request", None)
    headers = getattr(request, "headers", None) if request is not None else None
    if headers is None:
        headers = getattr(websocket, "request_headers", None)
    authorization = headers.get("Authorization") if headers is not None else None
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value.strip()
    protocols = headers.get("Sec-WebSocket-Protocol", "") if headers is not None else ""
    for protocol in protocols.split(","):
        protocol = protocol.strip()
        if protocol.startswith("bearer.") and len(protocol) > len("bearer."):
            return protocol[len("bearer."):]
    return None


def authorize(principal: TokenPrincipal, aircraft_id: str | None, source: str | None) -> None:
    if not principal.can_read(aircraft_id, source):
        raise AuthenticationError("forbidden_stream")
