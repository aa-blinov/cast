# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/aa-blinov/repo/security/advisories/new),
or to the address in the repository owner's profile.

Please include:

- what the problem is, and which file or command is involved,
- how to reproduce it,
- the impact you expect.

You should get an acknowledgement within a few days. If the report is valid,
a fix and a release follow; if it is not, you will be told why.

## What counts as a vulnerability

The security surface of this project is:

- **the network interface, and the files it reads**
- **the dependency tree**

A bug that makes the project misbehave in a way a user can trigger is a bug,
and is welcome as an issue. A bug that lets someone who should not have
access reach data they should not see is a vulnerability, and should be
reported privately.

## What is not a vulnerability

- A missing hardening that has no exploit path.
- A finding that depends on an already-compromised machine.
- A denial of service against your own instance.
