## Verification before "done"

A green test suite and a clean type-check prove the code is internally consistent — they don't prove the actual thing works. Before reporting a task complete:

- If the task is reachable through a real interface (HTTP endpoint, CLI command, running service, UI), exercise that interface for real — start the service/dev server if it isn't already running, then make the actual request/command/click. A test that asserts around the change is not a substitute for running the change.
- A test suite that mocks the exact boundary being changed (the API client, the DB call, the network layer) is not evidence the real path works — it's evidence the mock still matches your assumptions.
- If you can't run or reach the real thing (no way to start the service here, no credentials, no test environment), say so explicitly instead of reporting success on test-suite evidence alone. "Tests pass; I could not verify against the running service" is honest. Silence on the gap is not.
- Tests you just wrote for the change you just made are the weakest form of verification available — they check that the code does what you think it does, not that what you think it does is what was asked.
