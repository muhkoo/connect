# Security Policy

`@muhkoo/connect` implements cryptographic primitives (ECDH P-384, a Double
Ratchet, AES-256-GCM, PBKDF2, and Groth16 zero-knowledge proofs). We take
vulnerabilities seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **[Private Vulnerability Reporting](https://github.com/muhkoo/connect/security/advisories/new)**
(Security → Report a vulnerability). If that is unavailable, email
**security@muhkoo.com** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof-of-concept if possible),
- affected version(s) and environment (browser / Node / Cloudflare Workers).

We aim to acknowledge reports within **3 business days** and to provide a
remediation timeline after initial assessment. We will credit reporters in the
release notes unless you prefer to remain anonymous.

## Supported versions

This library is in **alpha** (`0.x`). Security fixes land on the latest
published version; there are no long-term support branches yet. Pin a version
and watch releases until a `1.0` line exists.

## Scope

In scope:

- Cryptographic correctness or weaknesses in the ratchet, key handling, ZK proof
  generation/verification, or passphrase wrapping.
- Issues allowing message decryption, key recovery, identity forgery, or
  authentication bypass.
- Dependency vulnerabilities that are reachable through this package's API.

Out of scope:

- Vulnerabilities in the Muhkoo Accelerator service itself (report those to the
  same contact, noting it is server-side).
- Misuse by an application that ignores the documented security model (e.g.
  persisting raw identity material, or shipping a private key to the client).
- Findings that require a already-compromised host or a malicious dependency
  the consumer themselves installed.

## Cryptography notes

This code has **not** undergone a formal third-party security audit. Until it
does, treat it as suitable for evaluation and development. If you are deploying
it to protect high-value data, please reach out — we want to hear about your
threat model.
