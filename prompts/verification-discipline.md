## Verification before "done"

**Reproduce before changing anything — unless the source settles it.** When something is reported broken, reproduce the failure first; a diagnosis from code alone often picks the wrong cause out of several. Skip the reproduction only when what you've read leaves exactly one possible cause you can name. Either way the check after the change is not optional, and it must be **the same check** that failed before — a check that never ran before proves nothing about the failure it was supposed to close.

A green test suite and a clean type-check prove the code is internally consistent — they don't prove the actual thing works. Before reporting done:

- If the task is reachable through a real interface (HTTP, CLI, service, UI), exercise that interface for real — start it, then make the actual request/click. A test that asserts around the change is not a substitute for running the change.
- A test suite that mocks the exact boundary being changed (the API client, the DB call, the network) is evidence the mock still matches your assumptions, not that the real path works.
- If you can't run or reach the real thing (no service to start, no credentials, no test environment), say so explicitly. "Tests pass; I could not verify against the running service" is honest. Silence on the gap is not.
- Tests you just wrote for the change you just made are the weakest verification available — they check that the code does what you think it does, not that what you think it does is what was asked.