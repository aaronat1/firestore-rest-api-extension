const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

admin.initializeApp();
const db = getFirestore();

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const API_KEYS_COLLECTION = "_ext_api_keys";
const RATE_LIMIT_COLLECTION = "_ext_rate_limits";
const ALLOWED_COLLECTIONS = process.env.ALLOWED_COLLECTIONS
  ? process.env.ALLOWED_COLLECTIONS.split(",").map((c) => c.trim()).filter(Boolean)
  : [];
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "60", 10);

// Firestore supported filter operators
const VALID_OPS = new Set([
  "==", "!=", "<", "<=", ">", ">=",
  "array-contains", "array-contains-any", "in", "not-in",
]);

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function generateKey() {
  return "frapi_" + crypto.randomBytes(20).toString("hex");
}

async function validateApiKey(key) {
  if (!key) return null;
  const snap = await db
    .collection(API_KEYS_COLLECTION)
    .where("key", "==", key)
    .where("active", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function checkRateLimit(keyId) {
  if (RATE_LIMIT === 0) return true;
  const now = Date.now();
  const windowStart = now - 60_000;
  const ref = db.collection(RATE_LIMIT_COLLECTION).doc(keyId);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const data = doc.exists ? doc.data() : { requests: [] };
    const recent = (data.requests || []).filter((ts) => ts > windowStart);
    if (recent.length >= RATE_LIMIT) return false;
    recent.push(now);
    tx.set(ref, { requests: recent });
    return true;
  });
}

async function apiKeyMiddleware(req, res, next) {
  const key =
    req.headers["x-api-key"] ||
    req.query.api_key ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  const keyData = await validateApiKey(key);
  if (!keyData) {
    return res.status(401).json({ error: "Invalid or missing API key." });
  }

  const allowed = await checkRateLimit(keyData.id);
  if (!allowed) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
  }

  db.collection(API_KEYS_COLLECTION).doc(keyData.id).update({
    lastUsed: FieldValue.serverTimestamp(),
    totalRequests: FieldValue.increment(1),
  });

  req.apiKey = keyData;
  next();
}

function collectionGuard(req, res, next) {
  const col = req.params.collection;
  if (col.startsWith("_ext_")) {
    return res.status(403).json({ error: "Access to internal collections is forbidden." });
  }
  if (ALLOWED_COLLECTIONS.length > 0 && !ALLOWED_COLLECTIONS.includes(col)) {
    return res.status(403).json({ error: `Collection '${col}' is not in the allowed list.` });
  }
  next();
}

/**
 * Parse where filters from query string.
 * Format: ?where=field:op:value  (repeat for multiple)
 * Array ops (in, not-in, array-contains-any): value is comma-separated
 * Example: ?where=status:==:active&where=age:>:18
 */
function parseWhereFilters(whereParam) {
  if (!whereParam) return [];
  const filters = Array.isArray(whereParam) ? whereParam : [whereParam];
  const parsed = [];
  for (const f of filters) {
    const colonIdx = f.indexOf(":");
    const secondColon = f.indexOf(":", colonIdx + 1);
    if (colonIdx === -1 || secondColon === -1) continue;
    const field = f.slice(0, colonIdx);
    const op = f.slice(colonIdx + 1, secondColon);
    const rawValue = f.slice(secondColon + 1);
    if (!VALID_OPS.has(op)) continue;

    let value;
    if (["in", "not-in", "array-contains-any"].includes(op)) {
      value = rawValue.split(",").map(coerceValue);
    } else {
      value = coerceValue(rawValue);
    }
    parsed.push({ field, op, value });
  }
  return parsed;
}

/** Auto-cast strings to number/boolean when possible */
function coerceValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v !== "" && !isNaN(v)) return Number(v);
  return v;
}

function applyWhereFilters(query, filters) {
  for (const { field, op, value } of filters) {
    query = query.where(field, op, value);
  }
  return query;
}

// ─────────────────────────────────────────────
// REST API EXPRESS APP
// ─────────────────────────────────────────────
const apiApp = express();
apiApp.use(cors({ origin: true }));
apiApp.use(express.json());

// ── GET / ── Serve UI (no auth required)
apiApp.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "ui.html"));
});

// All routes below require a valid API key
apiApp.use(apiKeyMiddleware);

// ─── Special sub-routes — registered BEFORE /:id to avoid shadowing ───

// GET /{collection}/count
apiApp.get("/:collection/count", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const filters = parseWhereFilters(req.query.where);
    let query = db.collection(collection);
    query = applyWhereFilters(query, filters);
    const snap = await query.count().get();
    res.json({ collection, count: snap.data().count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /{collection}/_schema — infer fields and types from first 20 docs
apiApp.get("/:collection/_schema", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const snap = await db.collection(collection).limit(20).get();
    if (snap.empty) {
      return res.json({ collection, fields: {} });
    }
    const fieldMap = {};
    snap.docs.forEach((d) => {
      const data = d.data();
      for (const [key, val] of Object.entries(data)) {
        if (!fieldMap[key]) {
          fieldMap[key] = { type: inferType(val), nullable: false };
        }
        if (val === null || val === undefined) fieldMap[key].nullable = true;
      }
    });
    res.json({ collection, sampleSize: snap.size, fields: fieldMap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function inferType(val) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "number") return "number";
  if (typeof val === "string") return "string";
  if (Array.isArray(val)) return "array";
  if (val && typeof val.toDate === "function") return "timestamp";
  if (typeof val === "object") return "map";
  return "unknown";
}

// POST /{collection}/_batch — insert multiple documents
apiApp.post("/:collection/_batch", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const body = req.body;
    if (!Array.isArray(body) || body.length === 0) {
      return res.status(400).json({ error: "Body must be a non-empty JSON array of objects." });
    }
    if (body.length > 500) {
      return res.status(400).json({ error: "Batch size cannot exceed 500 documents." });
    }

    const batch = db.batch();
    const refs = body.map(() => db.collection(collection).doc());
    body.forEach((doc, i) => {
      if (typeof doc !== "object" || Array.isArray(doc)) return;
      batch.set(refs[i], {
        ...doc,
        _createdAt: FieldValue.serverTimestamp(),
        _updatedAt: FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();

    res.status(201).json({
      inserted: refs.length,
      ids: refs.map((r) => r.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /{collection}/_batch — delete multiple documents by ID
apiApp.delete("/:collection/_batch", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Body must include { ids: [\"id1\", \"id2\", ...] }." });
    }
    if (ids.length > 500) {
      return res.status(400).json({ error: "Batch size cannot exceed 500 IDs." });
    }

    const batch = db.batch();
    ids.forEach((id) => batch.delete(db.collection(collection).doc(id)));
    await batch.commit();

    res.json({ success: true, deleted: ids.length, ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Routes with two dynamic segments ───

// GET /{collection}/{id}/{subcollection} — list subcollection
apiApp.get("/:collection/:id/:subcollection", collectionGuard, async (req, res) => {
  try {
    const { collection, id, subcollection } = req.params;
    const { limit = "20", orderBy, orderDir = "asc", startAfter } = req.query;
    const filters = parseWhereFilters(req.query.where);

    let query = db.collection(collection).doc(id).collection(subcollection);
    query = applyWhereFilters(query, filters);
    if (orderBy) query = query.orderBy(orderBy, orderDir === "desc" ? "desc" : "asc");
    if (startAfter) query = query.startAfter(startAfter);
    query = query.limit(Math.min(parseInt(limit, 10) || 20, 500));

    const snap = await query.get();
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ collection: `${collection}/${id}/${subcollection}`, count: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Standard single-segment routes ───

// GET /{collection} — GetAll with optional where filters
apiApp.get("/:collection", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const { limit = "20", orderBy, orderDir = "asc", startAfter } = req.query;
    const filters = parseWhereFilters(req.query.where);

    let query = db.collection(collection);
    query = applyWhereFilters(query, filters);
    if (orderBy) query = query.orderBy(orderBy, orderDir === "desc" ? "desc" : "asc");
    if (startAfter) query = query.startAfter(startAfter);
    query = query.limit(Math.min(parseInt(limit, 10) || 20, 500));

    const snap = await query.get();
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ collection, count: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HEAD /{collection}/{id} — check document existence
apiApp.head("/:collection/:id", collectionGuard, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const doc = await db.collection(collection).doc(id).get();
    res.status(doc.exists ? 200 : 404).end();
  } catch (err) {
    res.status(500).end();
  }
});

// GET /{collection}/{id} — GetById
apiApp.get("/:collection/:id", collectionGuard, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const doc = await db.collection(collection).doc(id).get();
    if (!doc.exists) return res.status(404).json({ error: "Document not found." });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /{collection} — Insert
apiApp.post("/:collection", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be a JSON object." });
    }
    const docRef = await db.collection(collection).add({
      ...body,
      _createdAt: FieldValue.serverTimestamp(),
      _updatedAt: FieldValue.serverTimestamp(),
    });
    const created = await docRef.get();
    res.status(201).json({ id: created.id, ...created.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /{collection}/{id}?upsert=true — Full replace (or create if upsert=true)
apiApp.put("/:collection/:id", collectionGuard, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const upsert = req.query.upsert === "true";
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be a JSON object." });
    }
    const ref = db.collection(collection).doc(id);
    const existing = await ref.get();
    if (!existing.exists && !upsert) {
      return res.status(404).json({ error: "Document not found. Use ?upsert=true to create it." });
    }
    await ref.set({
      ...body,
      _createdAt: existing.exists
        ? existing.data()._createdAt || FieldValue.serverTimestamp()
        : FieldValue.serverTimestamp(),
      _updatedAt: FieldValue.serverTimestamp(),
    });
    const updated = await ref.get();
    res.status(existing.exists ? 200 : 201).json({ id: updated.id, ...updated.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /{collection}/{id} — Partial update
apiApp.patch("/:collection/:id", collectionGuard, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be a JSON object." });
    }
    const ref = db.collection(collection).doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "Document not found." });
    await ref.update({ ...body, _updatedAt: FieldValue.serverTimestamp() });
    const updated = await ref.get();
    res.json({ id: updated.id, ...updated.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /{collection}?where=field:op:value — Mass update (requires at least one filter)
apiApp.patch("/:collection", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    const filters = parseWhereFilters(req.query.where);
    if (filters.length === 0) {
      return res.status(400).json({
        error: "At least one ?where=field:op:value filter is required for mass update.",
      });
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be a JSON object." });
    }

    let query = db.collection(collection);
    query = applyWhereFilters(query, filters);
    const snap = await query.limit(500).get();

    if (snap.empty) return res.json({ updated: 0, message: "No documents matched the filters." });

    const batch = db.batch();
    snap.docs.forEach((d) =>
      batch.update(d.ref, { ...body, _updatedAt: FieldValue.serverTimestamp() })
    );
    await batch.commit();

    res.json({
      updated: snap.size,
      note: snap.size === 500 ? "Matched 500+ docs; call again to update the rest." : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /{collection}/{id} — Delete one
apiApp.delete("/:collection/:id", collectionGuard, async (req, res) => {
  try {
    const { collection, id } = req.params;
    const ref = db.collection(collection).doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: "Document not found." });
    await ref.delete();
    res.json({ success: true, id, message: `Document '${id}' deleted from '${collection}'.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /{collection}?confirm=true — DeleteAll (batched, up to 500 per call)
apiApp.delete("/:collection", collectionGuard, async (req, res) => {
  try {
    const { collection } = req.params;
    if (req.query.confirm !== "true") {
      return res.status(400).json({
        error: "Add ?confirm=true to confirm deleting ALL documents in this collection.",
      });
    }
    const snap = await db.collection(collection).limit(500).get();
    if (snap.empty) return res.json({ success: true, deleted: 0, message: "Collection is already empty." });
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    res.json({
      success: true,
      deleted: snap.size,
      message: `Deleted ${snap.size} documents from '${collection}'.`,
      note: snap.size === 500 ? "Collection had 500+ docs; call again to delete the rest." : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// API KEY MANAGEMENT EXPRESS APP
// ─────────────────────────────────────────────
const keysApp = express();
keysApp.use(cors({ origin: true }));
keysApp.use(express.json());

async function requireMasterKey(req, res) {
  const masterKey =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();

  const master = await db
    .collection(API_KEYS_COLLECTION)
    .where("isMaster", "==", true)
    .where("key", "==", masterKey)
    .limit(1)
    .get();

  if (master.empty) {
    res.status(401).json({ error: "Master API key required." });
    return null;
  }
  return master.docs[0];
}

// POST /keys — Create new API key
keysApp.post("/", async (req, res) => {
  try {
    const { name, description, masterKey } = req.body || {};
    const existing = await db.collection(API_KEYS_COLLECTION).limit(1).get();
    if (!existing.empty) {
      const master = await db
        .collection(API_KEYS_COLLECTION)
        .where("isMaster", "==", true)
        .where("key", "==", masterKey)
        .limit(1)
        .get();
      if (master.empty) {
        return res.status(401).json({ error: "Master API key required to create new keys." });
      }
    }
    const key = generateKey();
    const isMaster = existing.empty;
    const docRef = await db.collection(API_KEYS_COLLECTION).add({
      key,
      name: name || "Unnamed Key",
      description: description || "",
      active: true,
      isMaster,
      createdAt: FieldValue.serverTimestamp(),
      lastUsed: null,
      totalRequests: 0,
    });
    res.status(201).json({
      id: docRef.id,
      key,
      name: name || "Unnamed Key",
      isMaster,
      warning: "Store this key safely. It will not be shown again.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /keys — List all keys
keysApp.get("/", async (req, res) => {
  try {
    const masterDoc = await requireMasterKey(req, res);
    if (!masterDoc) return;
    const snap = await db.collection(API_KEYS_COLLECTION).orderBy("createdAt", "asc").get();
    const keys = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        name: data.name,
        description: data.description,
        active: data.active,
        isMaster: data.isMaster,
        keyPreview: data.key.substring(0, 12) + "••••••••",
        createdAt: data.createdAt,
        lastUsed: data.lastUsed,
        totalRequests: data.totalRequests,
      };
    });
    res.json({ count: keys.length, keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /keys/:id — Activate/deactivate
keysApp.patch("/:id", async (req, res) => {
  try {
    const masterDoc = await requireMasterKey(req, res);
    if (!masterDoc) return;
    const { active } = req.body;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Body must include { active: true } or { active: false }." });
    }
    const ref = db.collection(API_KEYS_COLLECTION).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Key not found." });
    if (doc.data().isMaster && active === false) {
      return res.status(400).json({ error: "Cannot deactivate the master key." });
    }
    await ref.update({ active });
    res.json({ success: true, id: req.params.id, active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /keys/:id — Delete a key
keysApp.delete("/:id", async (req, res) => {
  try {
    const masterDoc = await requireMasterKey(req, res);
    if (!masterDoc) return;
    const ref = db.collection(API_KEYS_COLLECTION).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Key not found." });
    if (doc.data().isMaster) return res.status(400).json({ error: "Cannot delete the master key." });
    await ref.delete();
    res.json({ success: true, deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
exports.api = functions.https.onRequest(apiApp);
exports.keys = functions.https.onRequest(keysApp);
