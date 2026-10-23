export function issueSessionToken(): Promise<{ token: string; exp: number }>;
export function isSessionTokenShape(token: unknown): token is string;
export function validateSessionToken(token: unknown): Promise<boolean>;
