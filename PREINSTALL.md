# Firestore REST API Gateway — Pre-Installation

## What does this extension do?

This extension exposes any Firestore collection as a full REST API with the following endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/{collection}` | List documents (limit, orderBy, orderDir, startAfter) |
| `GET` | `/{collection}/count` | Count documents in a collection |
| `GET` | `/{collection}/{id}` | Get a document by ID |
| `POST` | `/{collection}` | Insert a new document |
| `PUT` | `/{collection}/{id}` | Replace a document entirely |
| `PATCH` | `/{collection}/{id}` | Partially update a document |
| `DELETE` | `/{collection}/{id}` | Delete a document by ID |
| `DELETE` | `/{collection}?confirm=true` | Delete all documents in a collection |

All endpoints require an **API key** passed via the `x-api-key` header, `?api_key=` query parameter, or `Authorization: Bearer` header.

A **Swagger-like web UI** is deployed to your Firebase Hosting site for exploring and testing the API interactively.

## Before you begin

- Make sure you have a Firebase project with **Firestore** enabled in Native mode.
- This extension requires **Blaze (pay-as-you-go)** plan because it deploys Cloud Functions.
- If you want to restrict access to specific collections, prepare a comma-separated list of collection names (e.g., `users,products,orders`). Leave empty to allow all collections.

## Billing

This extension uses the following Firebase services which may have associated charges:

- **Cloud Functions** — invoked on each API request
- **Cloud Firestore** — reads/writes for your data and for API key/rate limit management

See [Firebase pricing](https://firebase.google.com/pricing) for details.

## Security considerations

- Internal collections prefixed with `_ext_` are blocked from external access.
- API keys are stored hashed in Firestore. The plain-text key is only shown once at creation time.
- Rate limiting is enforced per API key using a sliding window stored in Firestore.
- Firestore Security Rules should deny direct client access to all collections — the Cloud Functions use the Admin SDK and bypass rules. See the recommended rules in `POSTINSTALL.md`.
