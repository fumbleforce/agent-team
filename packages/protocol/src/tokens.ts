import { createHash, createHmac } from 'node:crypto';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// What an agent presents to the platform tools. Derived from the lease, so it dies with it, and the agent never holds the lease token itself.
export const turnTokenFromHash = (machineToken: string, turnId: string, leaseTokenHash: string): string => `turn.${turnId}.${createHmac('sha256', machineToken).update(`mcp:${turnId}:${leaseTokenHash}`).digest('base64url')}`;
export const turnToken = (machineToken: string, turnId: string, leaseToken: string): string => turnTokenFromHash(machineToken, turnId, hashToken(leaseToken));
