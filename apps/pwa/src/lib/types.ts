export type Endpoint = {
  id: string;
  name: string;
  url: string;
  triggerToken: string;
  managementToken: string;
  triggerTokenVersion: number;
  managementTokenVersion: number;
  enabled: boolean;
  notificationsEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt?: string;
};

export type PendingOperation = {
  requestId: string;
  recoverySecret: string;
  createdAt: string;
};
export type EventRecord = {
  id: string;
  receivedAt: string;
  method: string;
  contentType?: string;
  byteCount: number;
};
export type RemoteEndpoint = Omit<
  Endpoint,
  "url" | "triggerToken" | "managementToken" | "lastSyncedAt"
>;
