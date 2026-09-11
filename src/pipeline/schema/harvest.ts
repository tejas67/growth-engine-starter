import { z } from 'zod';
const PostedAt = z
    .object({
    timestamp: z.number().optional(),
    date: z.string().optional(),
    postedAgoText: z.string().optional(),
    postedAgoShort: z.string().optional(),
})
    .passthrough();
const Location = z
    .object({
    linkedinText: z.string().nullish(),
    countryCode: z.string().nullish(),
    parsed: z
        .object({
        text: z.string().nullish(),
        countryCode: z.string().nullish(),
        country: z.string().nullish(),
        countryFull: z.string().nullish(),
        state: z.string().nullish(),
        city: z.string().nullish(),
    })
        .passthrough()
        .nullish(),
})
    .passthrough();
const Experience = z
    .object({
    position: z.string().nullish(),
    companyName: z.string().nullish(),
    companyLinkedinUrl: z.string().nullish(),
    startDate: z.unknown().optional(),
    endDate: z.unknown().optional(),
})
    .passthrough();
export const ActorSchema = z
    .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    linkedinUrl: z.string().nullish(),
    publicIdentifier: z.string().nullish(),
    universalName: z.string().nullish(),
    position: z.string().nullish(),
    info: z.string().nullish(),
    headline: z.string().nullish(),
    location: z.union([Location, z.string()]).nullish(),
    type: z.string().nullish(),
    website: z.string().nullish(),
    websites: z.array(z.unknown()).nullish(),
    about: z.string().nullish(),
    experience: z.array(Experience).nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    followerCount: z.number().nullish(),
    connectionsCount: z.number().nullish(),
    verified: z.boolean().nullish(),
    pageType: z.string().nullish(),
    employeeCount: z.number().nullish(),
})
    .passthrough();
export const EngagementSchema = z
    .object({
    likes: z.number().nullish(),
    comments: z.number().nullish(),
    shares: z.number().nullish(),
})
    .passthrough();
export const CommentItemSchema = z
    .object({
    type: z.literal('comment').optional(),
    id: z.string().nullish(),
    linkedinUrl: z.string().nullish(),
    commentary: z.string().nullish(),
    createdAt: z.union([z.string(), z.number()]).nullish(),
    createdAtTimestamp: z.number().nullish(),
    actor: ActorSchema.nullish(),
    postId: z.string().nullish(),
    replies: z.array(z.unknown()).nullish(),
    query: z.object({ post: z.string().nullish() }).passthrough().nullish(),
})
    .passthrough();
export const ReactionItemSchema = z
    .object({
    type: z.literal('reaction').optional(),
    id: z.string().nullish(),
    reactionType: z.string().nullish(),
    actor: ActorSchema.nullish(),
    postId: z.string().nullish(),
    query: z.object({ post: z.string().nullish() }).passthrough().nullish(),
})
    .passthrough();
export const RepostSchema = z
    .object({
    id: z.string().nullish(),
    linkedinUrl: z.string().nullish(),
    content: z.string().nullish(),
    postedAt: PostedAt.nullish(),
    author: ActorSchema.nullish(),
    engagement: EngagementSchema.nullish(),
})
    .passthrough();
export const RepostedBySchema = z
    .object({
    name: z.string().nullish(),
    publicIdentifier: z.string().nullish(),
    universalName: z.string().nullish(),
    linkedinUrl: z.string().nullish(),
})
    .passthrough();
export const PostItemSchema = z
    .object({
    type: z.literal('post').optional(),
    id: z.string().nullish(),
    linkedinUrl: z.string().nullish(),
    content: z.string().nullish(),
    postedAt: PostedAt.nullish(),
    author: ActorSchema.nullish(),
    engagement: EngagementSchema.nullish(),
    repost: RepostSchema.nullish(),
    repostId: z.string().nullish(),
    repostedBy: RepostedBySchema.nullish(),
    repostedAt: PostedAt.nullish(),
    reactions: z.array(ReactionItemSchema).nullish(),
    comments: z.array(CommentItemSchema).nullish(),
    query: z.object({ targetUrl: z.string().nullish() }).passthrough().nullish(),
})
    .passthrough();
export type HarvestPost = z.infer<typeof PostItemSchema>;
export type HarvestActor = z.infer<typeof ActorSchema>;
export type HarvestReaction = z.infer<typeof ReactionItemSchema>;
export type HarvestComment = z.infer<typeof CommentItemSchema>;
const URN_ID = /urn:li:(?:activity|share|ugcPost|fsd_update):(\d+)/;
export function normalizePostId(raw: string | null | undefined): string | null {
    if (!raw)
        return null;
    const value = String(raw).trim();
    if (!value)
        return null;
    if (/^\d{10,}$/.test(value))
        return value;
    const urn = URN_ID.exec(value);
    if (urn?.[1])
        return urn[1];
    const activitySuffix = /-activity-(\d{10,})/.exec(value);
    if (activitySuffix?.[1])
        return activitySuffix[1];
    const trailing = /(\d{15,})/.exec(value);
    return trailing?.[1] ?? null;
}
export type HarvestItemKind = 'post' | 'reaction' | 'comment' | 'unknown';
export function classifyItem(item: unknown): HarvestItemKind {
    if (!item || typeof item !== 'object')
        return 'unknown';
    const obj = item as Record<string, unknown>;
    if (typeof obj.commentary === 'string')
        return 'comment';
    if (typeof obj.reactionType === 'string')
        return 'reaction';
    if (obj.author && (obj.content !== undefined || obj.postedAt !== undefined))
        return 'post';
    const declared = obj.type;
    if (declared === 'post' || declared === 'reaction' || declared === 'comment')
        return declared;
    return 'unknown';
}
export interface PartitionedRun {
    posts: HarvestPost[];
    reactions: HarvestReaction[];
    comments: HarvestComment[];
    unknown: unknown[];
}
export function partitionRunItems(items: unknown[]): PartitionedRun {
    const out: PartitionedRun = { posts: [], reactions: [], comments: [], unknown: [] };
    for (const item of items) {
        switch (classifyItem(item)) {
            case 'post': {
                const parsed = PostItemSchema.safeParse(item);
                parsed.success ? out.posts.push(parsed.data) : out.unknown.push(item);
                break;
            }
            case 'reaction': {
                const parsed = ReactionItemSchema.safeParse(item);
                parsed.success ? out.reactions.push(parsed.data) : out.unknown.push(item);
                break;
            }
            case 'comment': {
                const parsed = CommentItemSchema.safeParse(item);
                parsed.success ? out.comments.push(parsed.data) : out.unknown.push(item);
                break;
            }
            default:
                out.unknown.push(item);
        }
    }
    return out;
}
function postIsUsable(post: HarvestPost): boolean {
    return Boolean(normalizePostId(post.id) ??
        normalizePostId(post.linkedinUrl) ??
        normalizePostId(post.repost?.id) ??
        normalizePostId(post.repost?.linkedinUrl));
}
function actorIsUsable(actor: HarvestActor | null | undefined): boolean {
    if (!actor)
        return false;
    return Boolean(actor.linkedinUrl || actor.publicIdentifier || actor.universalName);
}
export type DriftVerdict = {
    kind: 'ok';
    usable: number;
    total: number;
} | {
    kind: 'zero';
    usable: 0;
    total: 0;
    note: string;
} | {
    kind: 'drift';
    usable: number;
    total: number;
    note: string;
    samples: string[];
};
function samplesOf(items: unknown[]): string[] {
    return items.slice(0, 2).map((i) => JSON.stringify(i).slice(0, 300));
}
export function assessPostsPayload(items: unknown[], driftThreshold = 0.5): DriftVerdict {
    if (items.length === 0) {
        return { kind: 'zero', usable: 0, total: 0, note: 'actor returned zero items' };
    }
    const split = partitionRunItems(items);
    if (split.posts.length === 0) {
        const engagers = split.reactions.length + split.comments.length;
        if (engagers > 0) {
            return assessEngagersPayload(items, driftThreshold);
        }
        return {
            kind: 'drift',
            usable: 0,
            total: items.length,
            note: `${items.length} items and not one is a post, a reaction or a comment — actor schema drift`,
            samples: samplesOf(items),
        };
    }
    const usable = split.posts.filter(postIsUsable).length;
    const total = split.posts.length + split.unknown.length;
    const unusableRatio = 1 - usable / total;
    if (unusableRatio > driftThreshold) {
        return {
            kind: 'drift',
            usable,
            total,
            note: `${total - usable}/${total} posts lack a usable id/url — actor schema drift`,
            samples: samplesOf([...split.unknown, ...split.posts]),
        };
    }
    return { kind: 'ok', usable, total };
}
export function assessEngagersPayload(items: unknown[], driftThreshold = 0.5): DriftVerdict {
    if (items.length === 0) {
        return { kind: 'zero', usable: 0, total: 0, note: 'actor returned zero engagers' };
    }
    const split = partitionRunItems(items);
    const engagers = [...split.reactions, ...split.comments];
    const total = engagers.length + split.unknown.length;
    if (total === 0) {
        return {
            kind: 'drift',
            usable: 0,
            total: items.length,
            note: `${items.length} items and not one is an engager — actor schema drift`,
            samples: samplesOf(items),
        };
    }
    const usable = engagers.filter((e) => actorIsUsable(e.actor)).length;
    const unusableRatio = 1 - usable / total;
    if (unusableRatio > driftThreshold) {
        return {
            kind: 'drift',
            usable,
            total,
            note: `${total - usable}/${total} engagers lack actor identity — actor schema drift`,
            samples: samplesOf([...split.unknown, ...engagers]),
        };
    }
    return { kind: 'ok', usable, total };
}
export const assessReactionsPayload = assessEngagersPayload;
