/** Codul canalului de sistem: magazinul propriu. Creat de seed, nu se șterge. */
export const WEB_CHANNEL_CODE = "web";

export const CHANNEL_LISTING_STATUSES = [
  "draft",
  "pending",
  "active",
  "rejected",
  "inactive",
] as const;
export type ChannelListingStatus = (typeof CHANNEL_LISTING_STATUSES)[number];

export const CHANNEL_SYNC_STATUSES = ["ok", "error"] as const;
export type ChannelSyncStatus = (typeof CHANNEL_SYNC_STATUSES)[number];
