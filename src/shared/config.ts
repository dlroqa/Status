/**
 * Persisted configuration schemas.
 *
 * Kept apart from the domain types in `account.ts` so that validation — and zod with it —
 * stays in the main process. The renderer needs the types and labels, not a validator, and
 * bundling one into the UI would be dead weight in every window.
 */

import { z } from 'zod';
import { PROVIDERS } from './account';
import { MENU_BAR_SOURCES } from './menubar';

export const ProviderSchema = z.enum(PROVIDERS);

export const ConfiguredAccountSchema = z
  .object({
    id: z.string().min(3),
    provider: ProviderSchema,
    label: z.string().min(1),
    configDir: z.string().min(1),
    /**
     * Monthly spend cap in minor units (e.g. 2000 = $20.00).
     *
     * Subscriptions have no monthly quota, so without a cap there is no denominator and
     * the monthly row can only report spend as text. Setting one here turns that row into
     * a real bar. Providers that report their own cap take precedence over this.
     */
    monthlyCapMinor: z.number().int().positive().optional(),
  })
  .strict();

export type ConfiguredAccount = z.infer<typeof ConfiguredAccountSchema>;

/**
 * The poll floor is deliberate: these endpoints back a live subscription, and hammering
 * them would be rude and could look like abuse. 30s is well below any window's resolution.
 */
export const MIN_POLL_SECONDS = 30;
export const DEFAULT_POLL_SECONDS = 60;

/**
 * What the menu-bar item tracks. `closest` follows whichever account is nearest its limit,
 * which is the figure that matters when several accounts are connected; `chosen` pins it to
 * one account.
 */
export const MenuBarSchema = z
  .object({
    source: z.enum(MENU_BAR_SOURCES).default('closest'),
    accountId: z.string().min(3).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    pollSeconds: z.number().int().min(MIN_POLL_SECONDS).max(3600).default(DEFAULT_POLL_SECONDS),
    accounts: z.array(ConfiguredAccountSchema).default([]),
    menuBar: MenuBarSchema.default({ source: 'closest' }),
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * What callers may hand to `save`: fields carrying a default may be omitted, because saving
 * validates and fills them in. Requiring the fully-defaulted shape everywhere would push
 * that busywork onto every call site.
 */
export type AppConfigInput = z.input<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  pollSeconds: DEFAULT_POLL_SECONDS,
  accounts: [],
  menuBar: { source: 'closest' },
};
