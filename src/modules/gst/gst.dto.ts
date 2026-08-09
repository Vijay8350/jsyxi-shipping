import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { InvoiceState } from './gst.types';

/**
 * DTOs for the GST invoice endpoints (§9.9.2). Writes while ISSUE_PENDING
 * carry the INV-22 `version` the writer read; a mismatch is a 409 with the
 * current state, never a silent last-write-wins (§6 INV-22).
 */

/** ₹ money as a 2dp string ('500.00') and rates as 0–1 at 6dp ('0.180000'). */
const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const RATE_RE = /^\d+(\.\d{1,6})?$/;

export class PatchPartyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15)
  gstin?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  addressLines?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{6}$/)
  pincode?: string;
}

export class PatchLineDto {
  @IsString()
  @IsNotEmpty()
  orderLineId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  hsnCode?: string;

  /** Unit price in rupees, 2dp string — overrides the snapshot price. */
  @IsOptional()
  @IsString()
  @Matches(MONEY_RE)
  unitPrice?: string;

  /** §9.9.2 tax model: per-line GST rate override, 0–1 at 6dp. */
  @IsOptional()
  @IsString()
  @Matches(RATE_RE)
  gstRate?: string;
}

/** PATCH /gst/invoices/:id — supply missing fields; re-attempts issue (§9.9.2). */
export class PatchInvoiceDto {
  @IsInt()
  @Min(1)
  version!: number; // INV-22

  @IsOptional()
  @ValidateNested()
  @Type(() => PatchPartyDto)
  seller?: PatchPartyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PatchPartyDto)
  buyer?: PatchPartyDto;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  placeOfSupply?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PatchLineDto)
  @ArrayMaxSize(500)
  lines?: PatchLineDto[];
}

/** POST /gst/invoices/:id/void — the reason is mandatory (§3.12). */
export class VoidInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class CreditNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

const INVOICE_STATES: readonly InvoiceState[] = ['ISSUE_PENDING', 'ISSUED', 'VOID'];

/** GET /gst/invoices query — feeds the §11 INVOICE_PENDING report filter. */
export class ListInvoicesQueryDto {
  @IsOptional()
  @IsIn(INVOICE_STATES)
  state?: InvoiceState;

  @IsOptional()
  @IsIn(['true', 'false'])
  missingFieldsPresent?: 'true' | 'false';

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}
