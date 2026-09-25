"""Ask a question against the sandbox endpoint and poll for the result.

No wallet, payment, or chain needed. Start a backend locally (``npm start``
in the repo root), then run::

    ARBITER_URL=http://localhost:4000 python examples/sandbox.py
"""

import os

from arbiter_sdk import ArbiterClient

with ArbiterClient(os.environ.get("ARBITER_URL", "http://localhost:4000")) as arbiter:
    accepted = arbiter.ask_sandbox("Is the Third Mainland Bridge open right now?", tier="standard")
    print(f"accepted job {accepted.job_id} (sandbox={accepted.sandbox})")

    job = arbiter.wait_for_result(accepted.job_id, interval=0.25, on_update=lambda j: print(f"  status: {j.status}"))

    print(f"outcome: {job.outcome}")
    print(f"answer: {job.answer or '(none)'} (confidence {job.confidence})")
