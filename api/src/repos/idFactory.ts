import { randomUUID } from 'node:crypto';

export type IdFactory = () => string;

export const uuidV4: IdFactory = () => randomUUID();
