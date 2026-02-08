export { WhatsAppAdapter, type WhatsAppAdapterConfig } from "./adapter.js";
export {
  createBaileysClient,
  shouldReconnect,
  type BaileysClientConfig,
} from "./baileys-client.js";
export {
  normalizePhone,
  phoneToJid,
  jidToPhone,
  isGroupJid,
  jidToChatId,
  normalizeJid,
} from "./auth.js";
