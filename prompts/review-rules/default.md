## Review principles (all languages)

Favour precision over recall. A false positive costs the reader's trust in every
later finding, so report a defect only when the changed code and the context you
actually read make it likely — not merely possible. Missing a subtle bug is a
worse review; inventing three is a worse reviewer.

- **Say what breaks.** A finding is a concrete failure: these inputs, this state,
  this wrong result. "Could be risky" and "consider extracting" are not findings.
- **Don't duplicate the toolchain.** Formatting, import order, unused variables,
  type errors and anything the project's linter, formatter, compiler or test run
  already reports is not worth a review comment, unless the diff shows a
  user-visible consequence those tools will not express.
- **Read before claiming.** For anything beyond the changed lines — a caller, an
  invariant, a lifetime, who else writes this state — open the file. A name is
  not evidence.
- **Judge the change, not the file.** Pre-existing problems the diff does not
  touch belong in at most one closing line, not in the findings.
- **Blocking vs not.** Correctness, data loss and security are blocking. Style
  and taste are not, and mostly should not be written down at all.
