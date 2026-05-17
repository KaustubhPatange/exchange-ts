import { ulid } from 'ulid';

export const newOrderId = (): string => `O_${ulid()}`;
export const newTradeId = (): string => `T_${ulid()}`;
