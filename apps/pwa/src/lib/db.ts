import Dexie, { type EntityTable } from "dexie";
import type { Endpoint, PendingOperation } from "./types";

type Settings = { key: string; value: string };
class SentinelDatabase extends Dexie {
  endpoints!: EntityTable<Endpoint, "id">;
  pendingOperations!: EntityTable<PendingOperation, "requestId">;
  settings!: EntityTable<Settings, "key">;
  constructor() {
    super("sentinel-wallet");
    this.version(1).stores({
      endpoints: "id, name, createdAt",
      pendingOperations: "requestId, createdAt",
      settings: "key",
    });
  }
}
export const db = new SentinelDatabase();
