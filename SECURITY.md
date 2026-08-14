# Security

## Reporting a vulnerability

Prefer GitHub Private Vulnerability Reporting: on the repository page, open
**Security → Report a vulnerability**. Do not open a public issue — a public
report of a live vulnerability harms users before a fix exists.

Alternative channels:

- The Chrome Web Store listing's report link (category: Security issue).
- The AMO (Firefox Add-ons) listing's contact form.

Include in the report:

- Extension version (options page or `package.json`).
- The affected URL and the steps to reproduce.
- The data flow you believe is involved, if known (capture, caption parsing,
  settings sync).

## Supported versions

| version | support |
|---|---|
| 0.0.x | ✅ supported |
| < 0.0.1 | ❌ unsupported |

Only the latest release line is supported. Backports of fixes to older
releases happen only for critical severities.

## Scope and disclosure

In scope: the shipped bundles (Chrome, Firefox, userscript), the offscreen
audio-capture path, and the caption-parsing data flow. The STT/transformers
dependencies are dev-only and tree-shaken from the shipped bundles — reports
against them are out of scope unless the issue affects the shipped code.

You will get a confirmation within 7 days. Fixes ship before public
disclosure; we coordinate the announcement with you. The report stays private
until a GitHub security advisory or the coordinated disclosure date.
