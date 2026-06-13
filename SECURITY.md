# Security Policy

## Supported Versions

Only the latest release of `@wdl-dev/cli` receives security fixes.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting instead: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/wdl-dev/cli/security/advisories/new>).

Include reproduction steps and the CLI version (`wdl --version`). Please allow
the maintainers a reasonable window to ship a fix before any public disclosure.

If the reporting form is unavailable, email <security@wdl.dev> instead.

## Scope

The CLI handles a tenant deploy token and renders control-plane and
worker-supplied data in the terminal. Reports about credential handling (`.env`
parsing and endpoint trust, token transmission) and output escaping (terminal
control sequences in `tail`, listings, and error messages) are particularly
welcome.
