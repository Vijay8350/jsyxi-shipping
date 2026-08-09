# Health module — setup health (ADD-29/30/31) + §5.5 GDPR completion

## ADD-31 admin read pattern

The admin health board reads `setup_health_item` **directly** (read-only, no
PII — `state` is an enum and `detail` strings carry counts and enum names
only, never recipient data):

```sql
SELECT shop_id, item_key, state, detail, first_detected_at, updated_at
  FROM setup_health_item
  WHERE shop_id = $1;              -- detail panel for one merchant

-- "most broken" sort for the merchant list column:
SELECT shop_id,
       COUNT(*) FILTER (WHERE state = 'BROKEN')  AS broken,
       COUNT(*) FILTER (WHERE state = 'MISSING') AS missing
  FROM setup_health_item
  GROUP BY shop_id
  ORDER BY broken DESC, missing DESC;
```

Labels and deep links are resolved from the code catalog
(`setup-health.catalog.ts`), never stored. Rows appear after the shop's
first compute (hourly `setup-health` sweep, on-demand recompute, or the
first `GET /setup/health`).

## §5.5 later-expiring backups — ops procedure (not code)

Backups expire on their own schedule and cannot be rewritten in place, so
redaction reaches them by **restore-time enforcement**, not deletion:

1. **Inventory.** Nightly logical dumps (encrypted, 35-day horizon) and
   weekly base backups (90-day horizon) may still contain PII that a
   `customers/redact` or `shop/redact` has already erased from the primary
   tables. Object-storage versioned buckets likewise keep pre-redaction
   label PDFs until their lifecycle rule expires them (≤90 days, §5.4).
2. **Evidence is the allow-list.** Every completed redaction writes a
   `PRIVACY_REDACT_{CUSTOMER,SHOP}_FULL` audit row (§12) carrying the scope
   and per-store counts. These rows are the record that erasure happened;
   keep them beyond any backup horizon (audit_log retention is 7 FY, §5.4).
3. **Restore gate.** Any restore from a backup older than a redaction audit
   row MUST be followed, before the instance serves traffic, by a replay of
   the redaction: re-run `FullRedactionService.redactCustomerFull` /
   `redactShopFull` for every redaction audit row newer than the backup's
   snapshot time (all steps are idempotent and never regress, so replay is
   safe). The runbook step is: restore → replay redactions → open traffic.
4. **Expiry confirmation.** Once the oldest live backup post-dates a
   redaction, the redacted data exists nowhere; no further action. Backup
   horizons (≤90 days) bound how long erased PII can persist.
5. **Object storage.** Tombstoned `redacted/<document_id>` keys mean the
   bytes were deleted; versioned/delete-marker copies age out via the bucket
   lifecycle rule. A bucket-level restore follows the same replay gate.

## §5.5 store-by-store disposition (verified at build time)

| Store | Disposition |
|---|---|
| `order.recipient_snapshot`, mutable `shipment.working_values.recipient` | phase 1 (PrivacyRedactionService) — nulled |
| frozen `shipment.snapshot.recipient` | pseudonymized here (§5.5 exception to INV-10) |
| `gst_invoice.buyer_snapshot` | name/address stripped; buyer GSTIN retained as tax fact |
| `ndr_action.payload.address` (ADD-27 corrections) | stripped |
| search indexes | none exist in v1 — verified |
| `rollup_hourly_stats` | no PII (dimensions: card/service/state keys; metrics: counts, paise) — verified |
| object storage (`document` rows) | bytes deleted, keys tombstoned; shop scope also covers report CSVs |
| report exports (customer scope) | immutable as-of snapshots (§5.2); expire on the 30-day horizon (§5.4) |
| Redis caches | no buyer PII in any key/value (salted-hash / member-id keyed) — verified; shop-scope patterns evicted on shop redact |
| `message_log.recipient_ref` | salted hash by construction — verified, no action |
| track tokens | revoked by phase 1; shop redact adds `revokeAllForShop` |
| backups | restore-time replay gate (above) |
