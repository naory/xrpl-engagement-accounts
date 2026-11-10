# Security Policy

This project moves real value on the XRP Ledger, so we take security reports
seriously and practice coordinated disclosure.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately through **GitHub's private vulnerability reporting** on this
repository (Security → Report a vulnerability), or by email to the maintainer
at `<security-contact>` (set this to your preferred address before publishing).

Include, where you can: affected component and version/commit, a description of
the issue and its impact, and steps or a proof of concept to reproduce it.

## What's in scope

The trust primitives in this repository:

- the template validator (`packages/core`),
- the `cel-eng/1` policy engine and attestation pipeline (`packages/policy`),
- the baseline and template policies (`policies/`) and the co-signer service
  (`packages/cosigner`),
- the statement/decision envelopes and the conformance vectors.

Out of scope: the test-only keys and seeds in fixtures and vectors (they are
derived from public strings and must never be funded), the demo scripts' use of
the public Testnet faucet, and issues in third-party dependencies (report those
upstream, though we still want to hear about them).

## Our commitment (coordinated disclosure)

- We aim to acknowledge a report within **3 business days** and to give an
  initial assessment within **10 business days**.
- We work on a **90-day coordinated-disclosure** window: we aim to ship a fix
  and credit the reporter within 90 days of the report, and we expect the issue
  to stay private until a fix is available or the 90 days elapse, whichever is
  first. We will agree an earlier or later date with the reporter when that
  serves users better.
- We extend the same courtesy when we report issues in **other projects'**
  facilitators or tooling: a private report first, a reasonable window to fix,
  and public disclosure only after the window or a fix.

## Supported versions

The project is pre-1.0 and under active development; security fixes land on
`main`. Pin a commit if you need stability.
