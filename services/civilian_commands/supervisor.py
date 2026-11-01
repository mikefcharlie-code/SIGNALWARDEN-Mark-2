"""Bounded execution of operator-signed commands, never AI-generated decisions.

No network work occurs at import or construction. Aborting stops future sends;
it cannot recall a command already received by the independently deployed bridge.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import threading
import time

from .core import ACTIONS, CommandError, _b64, _identifier, _unb64, canonical

PLAN_KEYS = frozenset({"version", "deployment", "actor", "aircraft", "run_id",
                       "issued_at", "expires_at", "commands"})
DOMAIN = b"civilian-bounded-run-v1\0"
MAX_COMMANDS = 3
MAX_SECONDS = 30


def sign_plan(plan, key):
    """Explicit operator authorization of every command and the entire run."""
    body = dict(plan)
    body.pop("signature", None)
    if set(body) != PLAN_KEYS:
        raise ValueError("run plan keys are not exact")
    return {**body, "signature": _b64(hmac.new(key, DOMAIN + canonical(body), hashlib.sha256).digest())}


class BoundedRunSupervisor:
    def __init__(self, service, observer, *, clock=None, monotonic=None, wait=None):
        if not callable(observer):
            raise CommandError("a run status observer is required")
        self.service = service
        self.observer = observer
        self.clock = clock or service.clock
        self.monotonic = monotonic or time.monotonic
        self.cancelled = threading.Event()
        self.wait = wait or self.cancelled.wait
        self._running = False
        self._run_id = None
        self._actor = None
        self._aircraft = None
        self._deadline = 0
        self._expires = 0

    def abort(self):
        """Interrupt the local run; never synthesizes an aircraft command."""
        self.cancelled.set()

    def _event(self, state, index=None):
        event = {"run_id": self._run_id, "actor": self._actor, "aircraft": self._aircraft,
                 "state": state, "command_index": index,
                 "at": int(self.clock()), "recalls_dispatched_commands": False}
        # Audit first. An unavailable observer or audit sink prevents new sends.
        self.service.ledger.audit("run_" + state, actor=self._actor, aircraft=self._aircraft, cid=self._run_id)
        self.observer(dict(event))
        return event

    def _gate(self, *_):
        if self.cancelled.is_set():
            raise CommandError("run aborted")
        now = self.clock()
        if not math.isfinite(now) or now >= self._expires or self.monotonic() >= self._deadline:
            raise CommandError("run deadline exceeded")

    def _authorize(self, signed):
        if not isinstance(signed, dict) or set(signed) != PLAN_KEYS | {"signature"}:
            raise CommandError("invalid bounded run authorization")
        if len(canonical(signed)) > 16384:
            raise CommandError("run authorization too large")
        plan = dict(signed)
        signature = plan.pop("signature")
        cfg = self.service.config
        actor_id = plan.get("actor")
        if type(actor_id) is not str or type(plan.get("aircraft")) is not str:
            raise CommandError("invalid run identity")
        actor = cfg["actors"].get(actor_id)
        if (not self.service.enabled or cfg.get("bounded_runs_enabled") is not True
                or not isinstance(actor, dict) or actor.get("allow_bounded_runs") is not True
                or actor.get("kind") != "human-operator"
                or plan["aircraft"] not in actor.get("aircraft", [])
                or plan["aircraft"] not in cfg["aircraft"]):
            raise CommandError("bounded runs not authorized")
        if (type(plan["version"]) is not int or plan["version"] != 1
                or plan["deployment"] != cfg["deployment"]
                or not _identifier(plan["run_id"])
                or type(plan["commands"]) is not list or not 1 <= len(plan["commands"]) <= MAX_COMMANDS):
            raise CommandError("invalid bounded run limits")
        key = self.service.actor_keys[plan["actor"]]
        expected = hmac.new(key, DOMAIN + canonical(plan), hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64(signature), expected):
            raise CommandError("run authentication failed")
        now = self.clock()
        for name in ("issued_at", "expires_at"):
            if type(plan[name]) not in (int, float) or not math.isfinite(plan[name]):
                raise CommandError("invalid run time")
        if not (math.isfinite(now) and plan["issued_at"] <= now
                < plan["expires_at"] <= plan["issued_at"] + MAX_SECONDS):
            raise CommandError("run authorization stale or too long")
        ids, sequences = set(), []
        for request in plan["commands"]:
            self.service.validate_request(request)
            if (request["actor"] != plan["actor"] or request["aircraft"] != plan["aircraft"]
                    or request["deployment"] != plan["deployment"] or request["action"] not in ACTIONS
                    or request["issued_at"] < plan["issued_at"]
                    or request["expires_at"] > plan["expires_at"]
                    or request["command_id"] in ids):
                raise CommandError("command outside authorized run")
            ids.add(request["command_id"])
            sequences.append(request["sequence"])
        if sequences != sorted(set(sequences)):
            raise CommandError("run sequences must increase")
        return plan

    def _reserve(self, plan):
        # Separate run replay namespace; no restart/resume or implicit recovery.
        self.service.ledger._check_inode()
        db = self.service.ledger.db
        try:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO bounded_runs VALUES(?,?,?,?)",
                       (plan["deployment"], plan["run_id"], plan["actor"], hashlib.sha256(canonical(plan)).hexdigest()))
            db.commit()
        except Exception as exc:
            db.rollback()
            raise CommandError("run replay or storage rejected") from exc

    def _await_completion(self, request):
        ac = self.service.config["aircraft"][request["aircraft"]]
        key = self.service.bridge_keys[request["aircraft"]]
        keys = {"kind", "deployment", "actor", "aircraft", "command_id", "action",
                "completed", "issued_at", "expires_at", "signature"}
        while True:
            self._gate()
            message = {"kind": "completion_request", **{k: request[k] for k in
                        ("deployment", "actor", "aircraft", "command_id", "action")}}
            reply = self.service.transport.send(ac["endpoint"], message)
            if not isinstance(reply, dict) or set(reply) != keys:
                raise CommandError("invalid signed completion")
            body = dict(reply)
            signature = body.pop("signature")
            if not hmac.compare_digest(_unb64(signature), hmac.new(key, canonical(body), hashlib.sha256).digest()):
                raise CommandError("completion authentication rejected")
            if (body["kind"] != "completion" or type(body["completed"]) is not bool
                    or any(body[k] != request[k] for k in ("deployment", "actor", "aircraft", "command_id", "action"))):
                raise CommandError("completion identity rejected")
            now = self.clock()
            if (any(type(body[k]) not in (int, float) or not math.isfinite(body[k]) for k in ("issued_at", "expires_at"))
                    or not body["issued_at"] <= now < body["expires_at"] <= body["issued_at"] + MAX_SECONDS
                    or body["issued_at"] < request["issued_at"]):
                raise CommandError("completion freshness rejected")
            self._gate()
            if body["completed"]:
                return
            self.wait(0.2)

    def run(self, authorization):
        if self._running:
            raise CommandError("run already active")
        self._running = True
        sent = False
        self._run_id = self._actor = self._aircraft = None
        try:
            plan = self._authorize(authorization)
            self._run_id = plan["run_id"]
            self._actor = plan["actor"]
            self._aircraft = plan["aircraft"]
            self._expires = plan["expires_at"]
            self._deadline = self.monotonic() + min(MAX_SECONDS, self._expires - self.clock())
            self._reserve(plan)
            self._event("authorized")
            for index, request in enumerate(plan["commands"]):
                self._gate()
                self._event("dispatching", index)
                self._gate()
                # Base service repeats auth, freshness, readiness and audit gates.
                sent = True  # conservatively unknown if dispatch does not return
                self.service.dispatch(request, before_send=self._gate)
                self._event("awaiting_completion", index)
                self._await_completion(request)
                self._event("bridge_reported_complete", index)
            self._event("completed")
            return {"run_id": self._run_id, "state": "completed", "physical_success": False}
        except Exception as exc:
            state = "aborted" if self.cancelled.is_set() else ("unknown" if sent else "rejected")
            # A failure to write the final event remains an error, never success.
            try:
                self._event(state)
            except Exception as reporting_error:
                raise CommandError("run stopped; audit or observer unavailable; reconcile any sent command") from reporting_error
            raise CommandError("bounded run " + state + "; reconcile any dispatched command") from exc
        finally:
            self._running = False
