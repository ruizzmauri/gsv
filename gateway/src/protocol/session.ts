export type SessionRegistryEntry = {
  sessionKey: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
};
