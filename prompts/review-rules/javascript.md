## JavaScript

- A `Promise` created and neither awaited nor returned; `async` callbacks passed
  to APIs that ignore the returned promise (`forEach`, most event emitters).
- `catch` blocks that swallow the error, and `.catch(console.error)` on a path
  where the caller needed to know.
- `var` or an outer `let` captured by a closure inside a loop where the closure
  can observe a later value.
- Implicit coercion that changes behaviour: `==`, `+` on mixed types, truthiness
  checks on `0` or `""` where those are valid values.
- Prototype and identity hazards: object literals used as maps without
  `Object.create(null)`, `hasOwnProperty` called through the instance.
- Mutation of a shared module-level object, or of an argument the caller reuses.
