# Changelog

## 0.1.0

First version.

- Runs Tripo's official tripo-cli as a local stdio MCP server (`npx -y tripo-cli@0.9.0 mcp --toolset full`)
  with the hosted Tripo MCP tool set plus local file paths and `tripo_download`; international
  accounts only (`TRIPO_REGION=ov`), analytics off, the API key from the plugin's secret setting.
- The server is untrusted: every call that is not read-only asks for approval. No per-tool costs or
  spend limit are declared yet.
- Skills `tripo-3d` (with tool, workflow and chat-app references) and `tripo-game-asset`, carrying
  the server's rules: plan and confirm before spending, poll until done, report the credits used,
  and deliver files per surface (Desktop cards, `MEDIA:` attachments, plain paths).
- Hermes Desktop half: `::tripo-model` 3D cards with task progress, recent generations and a credit
  chip that shows a running task's progress, backed by `dashboard/plugin_api.py`.
