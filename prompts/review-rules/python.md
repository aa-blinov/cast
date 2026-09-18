## Python

- Mutable default arguments (`def f(x=[])`) and module-level mutable state shared
  across calls or requests.
- `except:` or `except Exception:` that swallows the error, hides a `KeyboardInterrupt`,
  or continues with a value the caller will misread as success.
- Resources opened without a context manager on a path that can raise: files,
  sockets, locks, DB sessions, subprocesses.
- Late binding in closures and comprehensions inside loops; `is` used for value
  comparison; equality between `Decimal` and `float`.
- `asyncio`: blocking calls inside a coroutine, tasks created without a reference
  (garbage-collected mid-flight), `gather` without `return_exceptions` where one
  failure must not lose the rest.
- Typing that lies: `Optional` returned where the caller dereferences directly,
  `Any` hiding a shape change made in this diff.
