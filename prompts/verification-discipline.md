## Verification before "done"

**Reproduce before changing anything — unless the source settles it.** When something is reported broken, reproduce the failure first; a diagnosis from code alone often picks the wrong cause out of several. Skip the reproduction only when what you've read leaves exactly one possible cause you can name. Either way the check after the change is not optional, and it must be **the same check** that failed before — a check that never ran before proves nothing about the failure it was supposed to close.

A green test suite and a clean type-check prove the code is internally consistent — they don't prove the actual thing works. Before reporting done:

- If the task is reachable through a real interface (HTTP, CLI, service, UI), exercise that interface for real — start it, then make the actual request/click. A test that asserts around the change is not a substitute for running the change.
- A test suite that mocks the exact boundary being changed (the API client, the DB call, the network) is evidence the mock still matches your assumptions, not that the real path works.
- If you can't run or reach the real thing (no service to start, no credentials, no test environment), say so explicitly. "Tests pass; I could not verify against the running service" is honest. Silence on the gap is not.
- Tests you just wrote for the change you just made are the weakest verification available — they check that the code does what you think it does, not that what you think it does is what was asked.

### What a check costs

Verification is not free, and a check that is broader than the failure costs a minute and proves a minute's worth of nothing. These keep the rigour and drop the cost:

- **The same check — the narrowest one that shows the failure.** A file's own test file is the check for a change in that file. The whole suite is the check when the whole suite is what failed, and it is worth running once at the end, not after every attempt.
- **One run per kind.** Type-check once, lint once, the tests once. Running the same command again before changing anything tells you what you already know; the answer only changes when the code changes.
- **To tell whether a failure is yours, run that one failing test on the unmodified source** — `git stash`, that test, `git stash pop`. Not the whole suite: the question is about one test, and one test answers it in seconds.
- **A check that passed on code you have not changed since still holds.** Do not re-run it for the reassurance of seeing it pass twice.
