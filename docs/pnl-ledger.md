# Durable Historical P&L Ledger

## Design rules
- D1 is the accounting store; KV remains for broker tokens only.
- The supplied historical baseline is frozen and stored separately from incremental executions.
- Each broker execution is unique by `(broker, execution_id)`; replaying an ingestion range cannot double-post it.
- A missing broker-provided realised P&L is unknown, not zero. Positions/MTM are never used as realised P&L.
- Ingestion runs record coverage and failures so a missing broker feed is visible.
- Do not mark a report COMPLETE until all required brokers have adequate execution coverage and the P&L source semantics have been verified.

## Provisioning
1. In Cloudflare Dashboard, Workers & Pages → D1 SQL Database → Create database named `trading-pnl`.
2. Apply `migrations/0001_pnl_ledger.sql` using the Cloudflare D1 console or `npx wrangler d1 migrations apply trading-pnl --remote`.
3. Add a Worker binding named `PNL_DB` pointing to that database. Record the actual database ID in `wrangler.jsonc`; do not use a placeholder ID.
4. Deploy only after the binding is confirmed.

The current integration cannot create a Cloudflare database or bind it remotely through the available GitHub connection. Do not deploy a config with a fabricated database ID.

## Execution-source acceptance criteria
For every broker, document the endpoint, its date-range limits, pagination behaviour, stable execution identifier, timestamps/time zone, whether it returns realised P&L or only fills, and whether charges/taxes are itemised. If the API only returns fills, calculate realised P&L only after implementing and testing a deterministic matching model; never treat current positions as a tradebook.
