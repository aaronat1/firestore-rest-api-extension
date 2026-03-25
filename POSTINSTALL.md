# Firestore REST API Gateway — Post-Installation

## Your endpoints

After installation, your functions are available at:

- **API**: `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/ext-firestore-rest-api-api`
- **Key Manager**: `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/ext-firestore-rest-api-keys`
- **Web UI**: `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/ext-firestore-rest-api-api/ui`

## Step 1: Generate your first API key

The first key you create becomes the **Master Key** — it is required to create and manage all subsequent keys.

**Via the Web UI:**
1. Open your Firebase Hosting URL
2. Click the **API Keys** tab
3. Enter a key name and click **Generate Key**
4. Copy and store the key safely — it will not be shown again

**Via curl:**
```bash
curl -X POST \
  https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/ext-firestore-rest-api-keys \
  -H "Content-Type: application/json" \
  -d '{"name": "Master Key"}'
```

## Step 2: Make your first API call

```bash
# List documents from the "users" collection
curl \
  https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/ext-firestore-rest-api-api/users \
  -H "x-api-key: frapi_YOUR_KEY_HERE"

# Insert a document
curl -X POST \
  https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/ext-firestore-rest-api-api/users \
  -H "x-api-key: frapi_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com"}'
```

## Recommended Firestore Security Rules

Since the Cloud Functions use the Firebase Admin SDK (which bypasses rules), set your rules to deny all direct client access:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Block direct client access to internal extension collections
    match /_ext_{collection}/{document=**} {
      allow read, write: if false;
    }
    // Block all direct client access — API handles everything
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## Configuration

| Parameter | Value |
|-----------|-------|
| Location | `${LOCATION}` |
| Allowed Collections | `${ALLOWED_COLLECTIONS}` |
| Rate Limit (req/min) | `${RATE_LIMIT_PER_MINUTE}` |

To change `ALLOWED_COLLECTIONS` or `RATE_LIMIT_PER_MINUTE`, reconfigure the extension from the Firebase console.

## API Reference

### Query parameters for GET /{collection}

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 20 | Max documents to return (up to 500) |
| `orderBy` | string | — | Field name to sort by |
| `orderDir` | string | `asc` | Sort direction: `asc` or `desc` |
| `startAfter` | string | — | Cursor value for pagination |

### API Key Management endpoints

All key management endpoints except `POST /keys` (for the first key) require a master key.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/keys` | Create a new API key |
| `GET` | `/keys` | List all keys (master only) |
| `PATCH` | `/keys/{id}` | Activate/deactivate a key (master only) |
| `DELETE` | `/keys/{id}` | Delete a key — not allowed for master (master only) |

## Monitoring

API key usage is tracked automatically:
- `lastUsed` — timestamp of the most recent request
- `totalRequests` — lifetime request count per key

View this data in the Firebase console under Firestore → `_ext_api_keys`.
