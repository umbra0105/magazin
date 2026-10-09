import { z } from "zod";
import { settingGroups } from "../settings/registry";
import type { AuthSettings } from "../auth/auth";

/** Setările `auth.*` implicite din registru, cu suprascrieri pentru teste. */
export function authSettings(overrides: Partial<AuthSettings> = {}): AuthSettings {
  return { ...z.object(settingGroups.auth).parse({}), ...overrides };
}
