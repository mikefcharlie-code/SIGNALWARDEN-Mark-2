"""Thread-safe in-process pub/sub for normalized telemetry events.

The management API receives telemetry on HTTP worker threads while the
WebSocket server runs an asyncio loop in a separate thread. Standard-library
queues make the boundary explicit and keep the hub independent of any broker.
"""
from __future__ import annotations

import copy
import queue
import threading
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_stream_event(result: dict[str, Any], sample: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build the UI-facing event without exposing transport internals."""
    event: dict[str, Any] = {
        "type": "telemetry",
        "event_id": f"stream-{uuid.uuid4().hex}",
        "published_at": utc_now(),
        "aircraft_id": result["aircraft_id"],
        "source": result["source"],
        "source_id": result["source_id"],
        "sequence": result["sequence"],
        "sampled_at": result["sampled_at"],
        "received_at": result["received_at"],
        "status": result["status"],
    }
    if sample is not None and result["status"] in {"accepted", "late"}:
        event["sample"] = copy.deepcopy(sample)
    return event


@dataclass(eq=False)
class _Subscriber:
    aircraft_id: str | None
    source: str | None
    max_queue: int
    events: queue.Queue[dict[str, Any]] = field(init=False)
    dropped: int = 0

    def __post_init__(self) -> None:
        self.events = queue.Queue(maxsize=self.max_queue)

    def matches(self, event: dict[str, Any]) -> bool:
        return (
            (self.aircraft_id is None or event.get("aircraft_id") == self.aircraft_id)
            and (self.source is None or event.get("source") == self.source)
        )

    def put(self, event: dict[str, Any]) -> None:
        try:
            self.events.put_nowait(copy.deepcopy(event))
            return
        except queue.Full:
            pass

        # Drop the oldest item to preserve a bounded memory footprint and
        # explicitly tell the client that it must resync via the HTTP API.
        try:
            self.events.get_nowait()
        except queue.Empty:
            pass
        self.dropped += 1
        gap = {
            "type": "stream_gap",
            "published_at": utc_now(),
            "reason": "subscriber_queue_full",
            "dropped_count": self.dropped,
            "aircraft_id": self.aircraft_id,
            "source": self.source,
            "recovery": "refetch_latest_and_history",
        }
        try:
            self.events.put_nowait(gap)
            self.events.put_nowait(copy.deepcopy(event))
        except queue.Full:
            # A queue of size one can only carry the gap; the next publish will
            # retry the replacement. The client still receives a resync signal.
            pass


class Subscription:
    def __init__(self, hub: "TelemetryHub", subscriber: _Subscriber):
        self._hub = hub
        self._subscriber = subscriber
        self.events = subscriber.events

    @property
    def aircraft_id(self) -> str | None:
        return self._subscriber.aircraft_id

    @property
    def source(self) -> str | None:
        return self._subscriber.source

    @property
    def dropped(self) -> int:
        return self._subscriber.dropped

    def close(self) -> None:
        self._hub.unsubscribe(self)

    def __enter__(self) -> "Subscription":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class TelemetryHub:
    """Bounded, filterable live-event fanout for one API process."""

    def __init__(self, default_queue_size: int = 100):
        if default_queue_size < 1:
            raise ValueError("default_queue_size must be positive")
        self.default_queue_size = default_queue_size
        self._lock = threading.RLock()
        self._subscribers: set[_Subscriber] = set()
        self._published = 0
        self._delivered = 0
        self._dropped = 0

    def subscribe(self, aircraft_id: str | None = None, source: str | None = None, max_queue: int | None = None) -> Subscription:
        subscriber = _Subscriber(aircraft_id, source, max_queue or self.default_queue_size)
        with self._lock:
            self._subscribers.add(subscriber)
        return Subscription(self, subscriber)

    def unsubscribe(self, subscription: Subscription) -> None:
        with self._lock:
            self._subscribers.discard(subscription._subscriber)

    def publish(self, event: dict[str, Any]) -> int:
        """Publish an event and return the number of matching subscribers."""
        with self._lock:
            subscribers = list(self._subscribers)
            self._published += 1
        delivered = 0
        for subscriber in subscribers:
            if subscriber.matches(event):
                before = subscriber.dropped
                subscriber.put(event)
                with self._lock:
                    self._delivered += 1
                    self._dropped += subscriber.dropped - before
                delivered += 1
        return delivered

    def metrics(self) -> dict[str, int]:
        with self._lock:
            return {
                "published": self._published,
                "delivered": self._delivered,
                "dropped": self._dropped,
                "subscribers": len(self._subscribers),
            }
