/** PG enum mirrors for adapter types (kept as string unions so adapter code
 *  stays persistence-free and directly unit-testable). */
export type payment_mode = 'PREPAID' | 'COD' | 'UNRESOLVED';
