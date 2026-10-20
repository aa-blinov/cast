# Contributing

Thanks for looking at repo.

## Before you open a pull request

- **Open an issue first** for anything larger than a fix. A design that is
  discussed in an issue costs less than a design that is discovered to be
  wrong after it is built.
- **One concern per pull request.** A fix and a refactor are two pull
  requests.
- **Match the existing code.** Read a file in full before changing it, and
  follow the conventions you find there rather than the ones you would
  choose.

## House rules for the pull request

- `README.md` still describes what the project actually does. If your change
  alters the behaviour, the README changes in the same pull request.
- `CHANGELOG.md` has an entry, if the change is visible to a user.
- New behaviour comes with a test.
- No new dependency without a reason written down next to it.
- No emojis, in any file. The house style bans them and the checker fails
  the build.

## Running the checks

```bash
echo 'replace with the test command'
```

The house-style check runs in CI on every pull request. To run it locally:

```bash
python3 scripts/housecheck.py --strict .
```

## Commit messages

```
<area>: <what changed, in the imperative>

<why it changed, and what it rules out>
```

The subject says what the change does. The body says why, and it is the part
that matters: a commit message is the only place the reasoning survives
after everyone has forgotten it.

## Code of conduct

By participating you agree to abide by the
[Code of Conduct](../CODE_OF_CONDUCT.md).
