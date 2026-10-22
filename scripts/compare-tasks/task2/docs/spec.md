# stock ledger

## restock(stock, sku, units)

Adds `units` to the stock of `sku` and returns the same map.

- `stock` is a `Map` of sku -> units. A sku that is not in the map counts as 0.
- `units` is a positive integer. Anything else throws `Error("units must be a positive integer")`.
- The map is updated in place and returned, so a caller can keep using it.
