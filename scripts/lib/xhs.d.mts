export declare const XHS_CHATTER_RE: RegExp;
export declare function cleanXhsText(text: string | null | undefined, limit?: number): string;
export declare function xhsPublishedAtFromUrl(url: string, nowMs?: number): string | null;
export declare function parseXhsRelativeTime(text: string | null | undefined, nowMs?: number): string | null;
export declare function extractXhsDetailFromHtml(
  html: string,
  nowMs?: number,
): { desc: string; publishedAt: string | null };
export declare function extractXhsSearchNotesFromJson(
  jsonText: string,
  nowMs?: number,
): Array<{
  title: string;
  url: string;
  fetchUrl: string;
  author: string;
  imageUrl: string;
  publishedAt: string | null;
  pubSource: string | null;
}>;
export declare function collectXhsNotes(
  page: unknown,
  keywords: string[],
  opts?: {
    maxAgeDays?: number;
    detailBudget?: number;
    knownUrls?: string[];
    tag?: string;
    log?: (msg: string) => void;
    waitUntil?: string;
  },
): Promise<
  Array<{
    externalId: string;
    url: string;
    title: string;
    summary: string;
    content: string | null;
    author: string | null;
    publishedAt: string | null;
    imageUrl: string | null;
    tags: string[];
  }>
>;
