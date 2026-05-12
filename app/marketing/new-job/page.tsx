import { permanentRedirect } from "next/navigation";

export const metadata = {
  title: "Create Weekly Social Posts · Aries AI",
};

// QA ISSUE-008 (2026-05-12): legacy URL kept for outstanding bookmarks/emails.
// Use a 308 (permanent) so caches and crawlers update — the previous silent
// 307 made the move invisible to upstream caches.
export default function MarketingNewJobPage() {
  permanentRedirect("/social-content/new");
}
