import { z } from 'zod';
import type { HarvestActor, HarvestComment, HarvestPost, HarvestReaction } from './harvest.js';
const PostAuthor = z
    .object({
    name: z.string().nullish(),
    id: z.union([z.string(), z.number()]).nullish(),
    public_identifier: z.string().nullish(),
    is_company: z.boolean().nullish(),
    headline: z.string().nullish(),
})
    .passthrough();
export const UnipilePostSchema = z
    .object({
    id: z.union([z.string(), z.number()]).nullish(),
    social_id: z.string().nullish(),
    share_url: z.string().nullish(),
    text: z.string().nullish(),
    date: z.string().nullish(),
    parsed_datetime: z.string().nullish(),
    reaction_counter: z.number().nullish(),
    comment_counter: z.number().nullish(),
    repost_counter: z.number().nullish(),
    author: PostAuthor.nullish(),
    is_repost: z.boolean().nullish(),
})
    .passthrough();
const ReactionAuthor = z
    .object({
    id: z.union([z.string(), z.number()]).nullish(),
    type: z.string().nullish(),
    name: z.string().nullish(),
    headline: z.string().nullish(),
    profile_url: z.string().nullish(),
    network_distance: z.string().nullish(),
})
    .passthrough();
export const UnipileReactionSchema = z
    .object({
    value: z.string().nullish(),
    author: ReactionAuthor.nullish(),
})
    .passthrough();
const CommentAuthorDetails = z
    .object({
    id: z.union([z.string(), z.number()]).nullish(),
    public_identifier: z.string().nullish(),
    profile_url: z.string().nullish(),
    headline: z.string().nullish(),
    network_distance: z.string().nullish(),
})
    .passthrough();
export const UnipileCommentSchema = z
    .object({
    id: z.union([z.string(), z.number()]).nullish(),
    date: z.string().nullish(),
    author: z.string().nullish(),
    author_details: CommentAuthorDetails.nullish(),
    text: z.string().nullish(),
    reaction_counter: z.number().nullish(),
    reply_counter: z.number().nullish(),
})
    .passthrough();
export type UnipilePost = z.infer<typeof UnipilePostSchema>;
export type UnipileReaction = z.infer<typeof UnipileReactionSchema>;
export type UnipileComment = z.infer<typeof UnipileCommentSchema>;
const RELATIVE = /^\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months|y|yr|year|years)\s*$/i;
const UNIT_MS: Record<string, number> = {
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 7 * 86400000,
    mo: 30 * 86400000,
    y: 365 * 86400000,
};
function unitKey(unit: string): string | null {
    const u = unit.toLowerCase();
    if (u.startsWith('mo'))
        return 'mo';
    if (u.startsWith('m'))
        return 'm';
    if (u.startsWith('h'))
        return 'h';
    if (u.startsWith('d'))
        return 'd';
    if (u.startsWith('w'))
        return 'w';
    if (u.startsWith('y'))
        return 'y';
    return null;
}
export function parseRelativeDate(raw: string | null | undefined, now: Date): Date | null {
    if (!raw)
        return null;
    const value = raw.trim();
    if (!value)
        return null;
    if (/^(now|just now)$/i.test(value))
        return new Date(now.getTime());
    const rel = RELATIVE.exec(value);
    if (rel) {
        const amount = Number(rel[1]);
        const key = unitKey(rel[2]!);
        if (!key || !Number.isFinite(amount))
            return null;
        return new Date(now.getTime() - amount * UNIT_MS[key]!);
    }
    const absolute = new Date(value);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
}
export function postedAtOf(post: UnipilePost, now: Date): Date | null {
    if (post.parsed_datetime) {
        const d = new Date(post.parsed_datetime);
        if (!Number.isNaN(d.getTime()))
            return d;
    }
    return parseRelativeDate(post.date, now);
}
export function socialIdFor(linkedinPostId: string, supplied?: string | null): string {
    return supplied || (linkedinPostId.startsWith('urn:') ? linkedinPostId : `urn:li:activity:${linkedinPostId}`);
}
function idString(v: string | number | null | undefined): string | null {
    if (v === null || v === undefined)
        return null;
    const s = String(v).trim();
    return s ? s : null;
}
export interface PostMapContext {
    now: Date;
    seedSlug: string | null;
}
function personUrl(slug: string): string {
    return `https://www.linkedin.com/in/${slug}`;
}
function companyUrl(slug: string): string {
    return `https://www.linkedin.com/company/${slug}`;
}
function postAuthorActor(author: UnipilePost['author']): HarvestActor | null {
    if (!author)
        return null;
    const isCompany = Boolean(author.is_company);
    const slug = author.public_identifier?.trim() || null;
    const id = idString(author.id);
    return {
        id,
        name: author.name ?? null,
        publicIdentifier: slug,
        linkedinUrl: slug ? (isCompany ? companyUrl(slug) : personUrl(slug)) : null,
        headline: author.headline ?? null,
        type: isCompany ? 'company' : 'profile',
    };
}
export function toHarvestPost(item: unknown, ctx: PostMapContext): HarvestPost | unknown {
    const parsed = UnipilePostSchema.safeParse(item);
    if (!parsed.success)
        return item;
    const post = parsed.data;
    const id = idString(post.id) ?? post.social_id ?? null;
    const postedAt = postedAtOf(post, ctx.now);
    const mapped: HarvestPost = {
        type: 'post',
        id,
        linkedinUrl: post.share_url ?? null,
        content: post.text ?? null,
        postedAt: postedAt
            ? { timestamp: postedAt.getTime(), date: postedAt.toISOString(), postedAgoText: post.date ?? undefined }
            : null,
        author: postAuthorActor(post.author),
        engagement: {
            likes: post.reaction_counter ?? null,
            comments: post.comment_counter ?? null,
            shares: post.repost_counter ?? null,
        },
    };
    if (post.is_repost) {
        mapped.repostedBy = { publicIdentifier: ctx.seedSlug ?? null };
    }
    return mapped;
}
export function toHarvestReaction(item: unknown, postId: string): HarvestReaction | unknown {
    const parsed = UnipileReactionSchema.safeParse(item);
    if (!parsed.success)
        return item;
    const reaction = parsed.data;
    const author = reaction.author;
    const isCompany = (author?.type ?? '').toLowerCase() === 'company';
    return {
        type: 'reaction',
        reactionType: reaction.value ?? 'UNKNOWN',
        postId,
        actor: author
            ? {
                id: idString(author.id),
                name: author.name ?? null,
                linkedinUrl: author.profile_url ?? null,
                headline: author.headline ?? null,
                type: isCompany ? 'company' : 'profile',
                networkDistance: author.network_distance ?? null,
            }
            : null,
    } satisfies HarvestReaction;
}
export function toHarvestComment(item: unknown, postId: string): HarvestComment | unknown {
    const parsed = UnipileCommentSchema.safeParse(item);
    if (!parsed.success)
        return item;
    const comment = parsed.data;
    const details = comment.author_details;
    return {
        type: 'comment',
        id: idString(comment.id),
        commentary: comment.text ?? '',
        createdAt: comment.date ?? null,
        postId,
        actor: details
            ? {
                id: idString(details.id),
                name: comment.author ?? null,
                publicIdentifier: details.public_identifier ?? null,
                linkedinUrl: details.profile_url ?? null,
                headline: details.headline ?? null,
                type: 'profile',
                networkDistance: details.network_distance ?? null,
            }
            : null,
    } satisfies HarvestComment;
}
export function mapPostsPage(items: unknown[], ctx: PostMapContext): unknown[] {
    return items.map((item) => toHarvestPost(item, ctx));
}
export function mapEngagersPage(reactions: unknown[], comments: unknown[], postId: string): unknown[] {
    return [
        ...reactions.map((item) => toHarvestReaction(item, postId)),
        ...comments.map((item) => toHarvestComment(item, postId)),
    ];
}
