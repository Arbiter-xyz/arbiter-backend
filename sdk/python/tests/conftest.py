from __future__ import annotations

import json
from typing import Any, Callable, List, Optional, Union

import httpx
import pytest

from arbiter_sdk import ArbiterClient

BASE_URL = "http://arbiter.test"

Reply = Union[httpx.Response, Exception]


def reply(status: int, body: Any = None, headers: Optional[dict] = None) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers or {}) if body is not None else httpx.Response(status, headers=headers or {})


class Recorder:
    """Records requests and answers from a handler, or from a queue of replies consumed in order."""

    def __init__(self, handler: Union[Callable[[httpx.Request], Reply], List[Reply]]):
        self.requests: List[httpx.Request] = []
        self._queue = list(handler) if isinstance(handler, list) else None
        self._handler = None if isinstance(handler, list) else handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        result = self._queue.pop(0) if self._queue is not None else self._handler(request)
        if isinstance(result, Exception):
            raise result
        return result

    def body(self, i: int = 0) -> Any:
        content = self.requests[i].content
        return json.loads(content) if content else None


@pytest.fixture
def make_client():
    clients: List[ArbiterClient] = []

    def factory(handler, **kwargs):
        recorder = Recorder(handler)
        client = ArbiterClient(
            kwargs.pop("base_url", BASE_URL),
            http_client=httpx.Client(transport=httpx.MockTransport(recorder)),
            retry_backoff=0.001,
            **kwargs,
        )
        clients.append(client)
        return client, recorder

    yield factory
    for c in clients:
        c.close()


JOB_BASE = {
    "createdAt": 1,
    "updatedAt": 1,
    "question": "Is the bridge open?",
    "tier": "standard",
    "quorumSize": 3,
    "timeoutMs": 45000,
}
