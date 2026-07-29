# Secret Filter Test Fixtures

This directory contains fixtures for the `redact()` function. Fixtures are synthesized to match the shape of real secrets but are provably inert (they do not authenticate or authorize anything).

## Fixtures Overview

### Hits (must be redacted)

- `aws-keys.txt` — AWS AKIA access key + secret key format
- `github-tokens.txt` — GitHub personal (ghp_), OAuth (ghs_), and user (ghu_) tokens
- `bearer-tokens.txt` — Generic bearer token format
- `private-keys.txt` — RSA private key block (fake but valid PEM structure)
- `env-secrets.txt` — .env-style `KEY=value` lines with secrets
- `url-credentials.txt` — URL-embedded user:pass@host credentials

### Non-hits (must NOT be redacted)

- `false-positives.txt` — Common patterns that look secret-ish but are not:
  - `PATH=/usr/bin` (environment variable)
  - Public key blocks (BEGIN PUBLIC KEY)
  - Example tokens in prose ("the token looks like ghp_example123")
  - URLs without credentials (`https://github.com/owner/repo`)
  - Base64 blobs that are not secrets
  - API documentation examples

## Fixture Format

Each `.txt` file contains one test case per line (no newlines in values).
Test code reads these and asserts hits are redacted, non-hits are unchanged.
