# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this repository, please report it responsibly. **Do not open a public issue.**

Email security@openbrain.dev with:

- A description of the vulnerability
- Steps to reproduce it
- Any relevant files or links

We will acknowledge your report within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Scope

This policy covers the contents of this repository: contribution templates, metadata schemas, CI workflows, community documentation, and the MCP server code (`server/index.ts`). It also covers security-relevant configuration patterns documented in the setup guide (access key handling, CORS, rate limiting, RLS policies).

It does not cover:

- The upstream Supabase platform itself (report to [Supabase Security](https://supabase.com/security))
- OpenRouter's API infrastructure (report to [OpenRouter](https://openrouter.ai))
- Third-party MCP clients (Claude Desktop, ChatGPT, Cursor, etc.)

## What Counts as a Vulnerability

- CI workflows that could be exploited (e.g., script injection via PR titles or branch names)
- Credentials, API keys, or secrets accidentally committed to the repo
- Contribution templates or examples that encourage insecure practices
- Flaws in the MCP server's authentication, rate limiting, or CORS enforcement
- SQL injection vectors in database functions or edge function code
- Access key exposure paths not documented in the security model

## What Does NOT Count

- Bugs in individual community contributions (report those as regular issues)
- Feature requests or general feedback (use Discussions or Issues)
- The inherent limitation of query-parameter key transport (this is documented and mitigated)

## Security Architecture Notes

The Open Brain MCP server uses a single shared access key for authentication. The following mitigations are in place:

- **Rate limiting** — Per-IP request throttling to prevent brute-force key guessing
- **Configurable CORS** — Origin restriction via `CORS_ALLOWED_ORIGINS` environment variable
- **Key transport warning** — Server logs a warning when the access key is received via URL query parameter instead of the preferred `x-brain-key` header
- **Health endpoint isolation** — The `/health` endpoint does not require authentication and returns no user data

For multi-user deployments, consider adding per-user authentication via Supabase Auth and aligning the core `thoughts` table with the RLS patterns used in extensions.

## Credit

We are happy to credit reporters in release notes or CONTRIBUTORS.md unless you prefer to remain anonymous.
