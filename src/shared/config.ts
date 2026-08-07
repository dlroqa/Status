/**
 * Persisted configuration schemas.
 *
 * Kept apart from the domain types in `account.ts` so that validation — and zod with it —
 * stays in the main process. The renderer needs the types and labels, not a validator, and
 * bundling one into the UI would be dead weight in every window.
 */

import { z } from 'zod';
import { PROVIDERS } from './account';

export const ProviderSchema = z.enum(PROVIDERS);

export const ConfiguredAccountSchema = z
  .object({
    id: z.string().min(3),
    provider: ProviderSchema,
    label: z.string().min(1),
    configDir: z.string().min(1),
  })
  .strict();

export type ConfiguredAccount = z.infer<typeof ConfiguredAccountSchema>;

/**
 * The poll floor is deliberate: these endpoints back a live subscription, and hammering
 * them would be rude and could look like abuse. 30s is well below any window's resolution.
 */
export const MIN_POLL_SECONDS = 30;
export const DEFAULT_POLL_SECONDS = 60;

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    pollSeconds: z.number().int().min(MIN_POLL_SECONDS).max(3600).default(DEFAULT_POLL_SECONDS),
    accounts: z.array(ConfiguredAccountSchema).default([]),
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  pollSeconds: DEFAULT_POLL_SECONDS,
  accounts: [],
};
