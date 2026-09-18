## Go

- Errors ignored, overwritten, or turned into a zero value that reads as success.
  `defer` that drops a meaningful `Close`/`Commit`/`Rollback` error.
- Error wrapping that loses the cause when a caller needs `errors.Is`/`errors.As`
  (`%v` where `%w` was required), or exposes internals at a public boundary.
- A typed nil stored in an interface and later tested for nil; nil maps written
  to; nil channels selected on.
- Copying a value that contains a `sync.Mutex`, `sync.Once`, `atomic` state or
  any other non-copyable primitive, after first use.
- Goroutines that can outlive their owner, have no shutdown path, or whose panic
  crosses no recovery boundary. Fire-and-forget writes after a handler returns.
- `context.Background()` on a request path that should inherit cancellation; a
  `cancel` from `WithCancel`/`WithTimeout` never called.
- Don't restate what `go vet`, `staticcheck`, `go test -race` or the compiler
  already reports, unless the diff makes the consequence concrete.
