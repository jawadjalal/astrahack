# For coding agents
- Contract lives in `canvas/src/lib/ops.ts`. Don't change it without telling the lead; add ops, never rename.
- Canvas app: Next.js + tldraw. Server state is an in-memory op log (`canvas/src/server/store.ts`).
- MCP server: `canvas/mcp/server.ts`, tools map 1:1 to ops, POSTs to `http://localhost:3000/api/ops`.
- Stay inside your workstream's files. Commit small, rebase on main before pushing.
