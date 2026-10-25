export const DEFAULT_PROJECT_REF: string;
export type ApiKeyEntry = { name?: string; type?: string; api_key?: string; [k: string]: unknown };
export function parseApiKeysOutput(stdout: string): ApiKeyEntry[];
export function pickKeys(entries: ApiKeyEntry[]): { anon: string | undefined; serviceRole: string | undefined };
export function parseEnv(text: string): Record<string, string>;
export function mergeEnv(
  existingText: string,
  values: Record<string, string | undefined>,
  opts?: { force?: boolean },
): { text: string; set: { name: string; length: number }[]; kept: string[] };
export function buildEnvValues(args: {
  projectRef: string;
  anonKey: string | undefined;
  serviceRoleKey: string | undefined;
  withServiceRole: boolean;
}): Record<string, string | undefined>;
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined;
export function checkKey(
  name: string,
  key: string,
  role: "anon" | "service_role",
  urlRef: string | undefined,
): string | undefined;
export function validateEnv(
  env: Record<string, string | undefined>,
  opts?: { requireServiceRole?: boolean; projectRef?: string },
): { errors: string[]; warnings: string[]; lengths: Record<string, number> };
export function parseArgs(
  argv: string[],
  env?: Record<string, string | undefined>,
): {
  fromCli: boolean;
  projectRef: string | undefined;
  withServiceRole: boolean;
  requireServiceRole: boolean;
  force: boolean;
};
