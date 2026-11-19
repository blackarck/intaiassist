import { extractJoinUrl, parseInvite, type InviteEmail } from "./invite.js";
import type { Scheduler } from "./scheduler.js";
import type { InterviewStore } from "./store.js";

export type IntakeResult =
  | { status: "ignored"; reason: "no_alias" | "no_join_url" | "interview_in_progress" }
  | { status: "rejected"; reason: "unknown_alias" | "alias_bound_to_other_meeting" }
  | { status: "scheduled"; interviewId: string; runAt: string; senderMismatch: boolean }
  | { status: "cancelled"; interviewId: string };

export interface IntakeDeps {
  store: InterviewStore;
  scheduler: Scheduler;
  aliasDomain: string;
}

/** Entry point for emailed invites (Logic App -> backend). */
export async function handleInvite(email: InviteEmail, deps: IntakeDeps): Promise<IntakeResult> {
  const parsed = parseInvite(email, deps.aliasDomain);
  if (parsed.aliasTags.length === 0) return { status: "ignored", reason: "no_alias" };

  let interview = undefined;
  for (const tag of parsed.aliasTags) {
    interview = await deps.store.findByAlias(tag);
    if (interview) break;
  }
  if (!interview) return { status: "rejected", reason: "unknown_alias" };

  if (parsed.method === "cancel") {
    deps.scheduler.cancel(interview.id);
    await deps.store.save({ ...interview, status: "cancelled" });
    return { status: "cancelled", interviewId: interview.id };
  }

  if (interview.status === "joining" || interview.status === "in_meeting") {
    return { status: "ignored", reason: "interview_in_progress" };
  }

  if (!parsed.joinUrl) return { status: "ignored", reason: "no_join_url" };

  // An alias is single-use per meeting: block re-use of a paid alias for a different meeting.
  if (interview.icalUid && parsed.icalUid && interview.icalUid !== parsed.icalUid) {
    return { status: "rejected", reason: "alias_bound_to_other_meeting" };
  }

  const updated = {
    ...interview,
    joinUrl: parsed.joinUrl,
    icalUid: parsed.icalUid ?? interview.icalUid,
    startsAt: parsed.startsAt ?? interview.startsAt,
    status: "scheduled" as const,
  };
  await deps.store.save(updated);
  const { runAt } = deps.scheduler.schedule(updated);

  const senderMismatch = !parsed.from.toLowerCase().includes(interview.ownerEmail.toLowerCase());
  return { status: "scheduled", interviewId: interview.id, runAt, senderMismatch };
}

/** Portal "paste your meeting link" fallback — same pipeline, no email. */
export async function handlePastedLink(
  args: { alias: string; link: string; startsAt?: string },
  deps: Pick<IntakeDeps, "store" | "scheduler">,
): Promise<IntakeResult> {
  const interview = await deps.store.findByAlias(args.alias);
  if (!interview) return { status: "rejected", reason: "unknown_alias" };
  if (interview.status === "joining" || interview.status === "in_meeting") {
    return { status: "ignored", reason: "interview_in_progress" };
  }
  const joinUrl = extractJoinUrl(args.link);
  if (!joinUrl) return { status: "ignored", reason: "no_join_url" };

  const updated = {
    ...interview,
    joinUrl,
    startsAt: args.startsAt ?? interview.startsAt,
    status: "scheduled" as const,
  };
  await deps.store.save(updated);
  const { runAt } = deps.scheduler.schedule(updated);
  return { status: "scheduled", interviewId: interview.id, runAt, senderMismatch: false };
}
