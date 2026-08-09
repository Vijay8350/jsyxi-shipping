import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { CredentialFieldSchema, CredentialsVaultService } from './vault.service';

/**
 * Courier catalog (§9.3.1, §9.3.3): the courier master data a merchant needs
 * to connect an account — the credential-field schema (public fields only,
 * never values), the capability matrix (§8.2, A1-03) and the setup guides
 * (whose content also backs ADD-18's per-courier webhook instructions).
 * All of this data is global (not shop-scoped) and safe to show any role.
 */

export interface CourierCapabilityRow {
  capability: string;
  supported: boolean;
  manualFallbackNote: string | null;
}

export interface CourierGuideRow {
  videoUrl: string | null;
  docUrl: string | null;
  pdfObjectKey: string | null;
  publishedAt: string | null;
}

export interface CourierServiceRow {
  serviceId: string;
  code: string;
  name: string;
  labelMode: string;
  costSource: string;
  isActive: boolean;
}

export interface CourierCatalogEntry {
  courierId: string;
  code: string;
  name: string;
  kind: string;
  authPattern: string;
  credentialFields: CredentialFieldSchema[];
  capabilities: CourierCapabilityRow[];
  services: CourierServiceRow[];
  guide: CourierGuideRow | null;
}

@Injectable()
export class CourierCatalogService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly vault: CredentialsVaultService,
  ) {}

  /** §9.3.3: list active couriers with everything the connect form needs. */
  async listCouriers(): Promise<CourierCatalogEntry[]> {
    const couriers = await this.pool.query(
      `SELECT courier_id, code, name, kind, auth_pattern
         FROM courier WHERE is_active ORDER BY name`,
    );
    const out: CourierCatalogEntry[] = [];
    for (const c of couriers.rows) {
      const [credentialFields, capabilities, services, guide] = await Promise.all([
        this.vault.fieldSchema(c.courier_id),
        this.capabilities(c.courier_id),
        this.services(c.courier_id),
        this.guide(c.courier_id),
      ]);
      out.push({
        courierId: c.courier_id,
        code: c.code,
        name: c.name,
        kind: c.kind,
        authPattern: c.auth_pattern,
        credentialFields,
        capabilities,
        services,
        guide,
      });
    }
    return out;
  }

  async capabilities(courierId: string): Promise<CourierCapabilityRow[]> {
    const res = await this.pool.query(
      `SELECT capability, supported, manual_fallback_note
         FROM courier_capability WHERE courier_id = $1 ORDER BY capability`,
      [courierId],
    );
    return res.rows.map((r) => ({
      capability: r.capability,
      supported: r.supported,
      manualFallbackNote: r.manual_fallback_note,
    }));
  }

  async services(courierId: string): Promise<CourierServiceRow[]> {
    const res = await this.pool.query(
      `SELECT service_id, code, name, label_mode, cost_source, is_active
         FROM service WHERE courier_id = $1 ORDER BY code`,
      [courierId],
    );
    return res.rows.map((r) => ({
      serviceId: r.service_id,
      code: r.code,
      name: r.name,
      labelMode: r.label_mode,
      costSource: r.cost_source,
      isActive: r.is_active,
    }));
  }

  async guide(courierId: string): Promise<CourierGuideRow | null> {
    const res = await this.pool.query(
      `SELECT video_url, doc_url, pdf_object_key, published_at
         FROM courier_guide
        WHERE courier_id = $1 AND published_at IS NOT NULL
        ORDER BY published_at DESC LIMIT 1`,
      [courierId],
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return {
      videoUrl: r.video_url,
      docUrl: r.doc_url,
      pdfObjectKey: r.pdf_object_key,
      publishedAt: r.published_at,
    };
  }
}
