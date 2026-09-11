/** View models shared between the server load functions and the components. */

export interface ProspectCard {
  id: number;
  full_name: string | null;
  headline: string | null;
  company_name: string | null;
  company_domain: string | null;
  company_verified: boolean;
  linkedin_url: string | null;
  email: string | null;
  is_gov: boolean;
  score: number | null;
  persona: string | null;
}

/**
 * What the platform rendered for a product-proof email, mirrored here so the founder
 * approves the EXACT bytes that will send (G3).
 *
 * `editable: false` on these is deliberate. The platform holds the bytes and sends
 * them; editing them here would leave our copy of the wording disagreeing with what
 * actually went out, and every metric downstream reads our copy.
 */
export interface BridgeProof {
  requestId: string | null;
  state: string;
  matchCount: number | null;
  headlineTotalUsd: string | null;
  contentHashPresent: boolean;
  failureReason: string | null;
  companyName: string | null;
}

/** One hand-raise: the post they engaged with and how. Every card shows every signal. */
export interface SignalCard {
  engagementType: string;
  commentText: string | null;
  /** When WE saw it — honest name; for reactions LinkedIn gives no timestamp. */
  detectedAt: string;
  age: string;
  postUrl: string | null;
  postAuthor: string | null;
  postAuthorHeadline: string | null;
  postExcerpt: string | null;
  postedAt: string | null;
}

export interface DraftCard {
  touchId: number;
  hot: boolean;
  channel: string;
  /** Set when this card mirrors a platform-rendered email rather than our own draft. */
  bridge: BridgeProof | null;
  templateVersion: string;
  generationProvider?: string | null;
  generationModel?: string | null;
  angle: string | null;
  persona: string | null;
  subject: string | null;
  body: string;
  /** Sent with the connection request when they are not yet connected; null = HeyReach's fallback line. */
  connectNote: string | null;
  founderEdited: boolean;
  dryRun: boolean;
  /** Human age of the draft. Visible, never enforced — drafts do not expire. */
  age: string;
  draftedAt: string;
  prospect: ProspectCard | null;
  /** Why this person is on the list: the post(s) they engaged with, newest first. */
  signals: SignalCard[];
  /** A LinkedIn people-search for their name — the fallback when a profile slug is dead. */
  searchUrl: string | null;
}

export interface ReplyCard {
  eventId: string;
  kind: string;
  channel: string | null;
  occurredAt: string;
  age: string;
  excerpt: string | null;
  subject: string | null;
  from: string | null;
  gmailUrl: string | null;
  touchId: number | null;
  founderVerdict: string | null;
}

export interface ReplyThread {
  prospectId: number | null;
  name: string;
  headline: string | null;
  companyName: string | null;
  linkedinUrl: string | null;
  email: string | null;
  paused: boolean;
  pauseReason: string | null;
  latestAt: string;
  replies: ReplyCard[];
}

export interface MetricCell {
  key: string;
  sends: number;
  replies: number;
  positive: number;
  positiveRate: number | null;
  belowFloor: boolean;
}

export interface MetricCut {
  title: string;
  /** Plain-language description of what one row means. */
  description: string;
  exploratory: boolean;
  cells: MetricCell[];
}
