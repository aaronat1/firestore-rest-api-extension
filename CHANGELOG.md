# Changelog

## Version 0.1.1

- Fixed: upgraded runtime from nodejs18 to nodejs20 (nodejs18 is decommissioned)

## Version 0.1.0

**Initial release.**

- REST API endpoints: GetAll (with filters), GetById, Count, Insert, Batch Insert, Replace, Upsert, Update, Mass Update, Delete, Batch Delete, DeleteAll
- Schema inference endpoint
- Subcollection support
- API key management (create, list, activate/deactivate, delete)
- Built-in Swagger-like explorer UI served from the function itself
- Sliding-window rate limiting per API key
- Collection allowlist support
