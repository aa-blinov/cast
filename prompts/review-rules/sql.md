## SQL

- String-built queries carrying user input, or an ORM escape hatch that does the
  same. Parameterisation is the only acceptable answer.
- A migration that is not reversible, locks a large table without a stated plan,
  or adds a `NOT NULL` column with no default to a populated table.
- A query added on a request path with no index behind its filter or join keys.
- `DELETE`/`UPDATE` without a `WHERE`, or with one whose selectivity the diff
  does not establish.
