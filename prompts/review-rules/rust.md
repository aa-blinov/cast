## Rust

- `unwrap`, `expect`, and indexing on a value whose invariant the diff does not
  establish. Panics on a library or request path.
- `unsafe` whose invariant is not stated and not obviously upheld by the
  surrounding code.
- Lock guards held across an `.await`, across a call that can lock again, or for
  longer than the critical section needs.
- `clone()` added on a hot path to satisfy the borrow checker where a borrow
  would do — only when the cost is real and demonstrable.
- Error handling flattened to `Box<dyn Error>` or `String` at a boundary where
  callers must distinguish cases.
