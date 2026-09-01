## MCP server aliases

When I use the following aliases in a prompt, route to the corresponding MCP server:

- `telemetry_mcp` → use the `bluebird_mcp_SqlTelemetry` MCP server
- `docs_mcp` → use the `microsoft-docs` MCP server

## Extension versioning

Before every push that updates a pull request, advance the VS Code extension
version by at least one patch with `npm version patch --no-git-tag-version`.
Keep `package.json` and `package-lock.json` synchronized. CI compares each PR
update with its previous head and rejects unchanged or lower versions. The
one-time `1.0.1` first-Marketplace reset from the unpublished `2.x` preview line
is the only exception; resume patch increments after it lands.
