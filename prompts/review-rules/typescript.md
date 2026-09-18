## TypeScript / TSX

- `any`, `as unknown as`, and non-null `!` that hide a real shape mismatch: check
  what the value actually is at that point before accepting the assertion.
- A `Promise` that is created and not awaited or returned — floating work whose
  failure becomes an unhandled rejection, and whose ordering nobody controls.
- `await` inside a loop where the iterations are independent, when the loop is on
  a latency path. Say what the cost is, not just that it exists.
- Errors swallowed by `catch {}` or `catch (e) { return null }` on a path where
  the caller cannot tell success from failure.
- Mutation of a parameter, a module-level object, or a value the caller still
  holds, where the caller has no way to know.
- `useEffect`/subscription/interval/listener without the matching teardown, and
  dependency arrays that omit a value the effect reads.
- Narrowing that silently fails: `typeof x === "object"` for `null`, `in` checks
  on a union that already has a discriminant, `Array.isArray` on a tuple type.
- Equality and key bugs: `==` on mixed types, object identity used as a map key,
  `NaN` compared, `Object.keys` order relied upon.
