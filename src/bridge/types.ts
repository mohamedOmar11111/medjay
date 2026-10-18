// How a message arrived. `voice` covers audio notes AND any text a provider marks as a transcription:
// a transcript is a machine's guess at speech, so it is never trusted to approve anything.
export type Via = "typed" | "button" | "voice" | "other";

export type Provider = "whatsapp_cloud_api" | "respond_io_webhook";
export const PROVIDERS: readonly Provider[] = ["whatsapp_cloud_api", "respond_io_webhook"];

export interface InboundMessage {
  /** The provider's message id; used once, for replay protection. */
  id: string;
  /** E.164 with a leading +. */
  from: string;
  timestamp: string | null;
  via: Via;
  /** Typed text, or (voice only) the provider's transcript. */
  text?: string;
  /** Interactive button reply id. */
  buttonId?: string;
}

export interface OutboundMessage {
  to: string;
  text: string;
  /** Interactive buttons; ids are signed, see buttons.ts. */
  buttons?: { id: string; title: string }[];
}
