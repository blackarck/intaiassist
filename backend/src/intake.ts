import type { BotController } from "./botController.js";
import { extractMeetingLink, parseInvite, type InviteEmail } from "./invite.js";
import type { InterviewStore } from "./store.js";

export type IntakeResult =
  | { status: "ignored"; reason: "no_alias" | "no_meeting_link" | "interview_in_progress" }
  | { status: "rejected"; reason: "unknown_alias" | "alias_bound_to_other_meeting" }
  | {
      status: "scheduled";
      interviewId: string;
      mode: "scheduled" | "ad_hoc";
      /** ISO time the bot was told to join; absent when it joins immediately */
      joinAt?: string;
      senderMismatch: boolean;
    }
  | { status: "cancelled"; interviewId: string };

export interface IntakeDeps {
  store: InterviewStore;
  controller: BotController;
  aliasDomain: string;
}

/** Entry point for emailed invites (Logic App -> backend). Errors from the bot provider propagate (HTTP 500) so the Logic App retries. */
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
    await deps.controller.cancel(interview);
    await deps.store.save({ ...interview, status: "cancelled" });
    return { status: "cancelled", interviewId: interview.id };
  }

  if (interview.status === "joining" || interview.status === "in_meeting") {
    return { status: "ignored", reason: "interview_in_progress" };
  }

  if (!parsed.meeting) return { status: "ignored", reason: "no_meeting_link" };

  // An alias is single-use per meeting: block re-use of a paid alias for a different meeting.
  if (interview.icalUid && parsed.icalUid && interview.icalUid !== parsed.icalUid) {
    return { status: "rejected", reason: "alias_bound_to_other_meeting" };
  }

  const updated = {
    ...interview,
    joinUrl: parsed.meeting.url,
    platform: parsed.meeting.platform,
    icalUid: parsed.icalUid ?? interview.icalUid,
    startsAt: parsed.startsAt ?? interview.startsAt,
    status: "scheduled" as const,
  };
  // updated still carries the previous recallBotId/joinMode, so the controller can replace that bot
  const plan = await deps.controller.schedule(updated);
  await deps.store.save({ ...updated, recallBotId: plan.botId, joinMode: plan.mode });

  const senderMismatch = !parsed.from.toLowerCase().includes(interview.ownerEmail.toLowerCase());
  return { status: "scheduled", interviewId: interview.id, mode: plan.mode, joinAt: plan.joinAt, senderMismatch };
}

/** Portal "paste your meeting link" fallback: same pipeline, no email. */
export async function handlePastedLink(
  args: { alias: string; link: string; startsAt?: string },
  deps: Pick<IntakeDeps, "store" | "controller">,
): Promise<IntakeResult> {
  const interview = await deps.store.findByAlias(args.alias);
  if (!interview) return { status: "rejected", reason: "unknown_alias" };
  if (interview.status === "joining" || interview.status === "in_meeting") {
    return { status: "ignored", reason: "interview_in_progress" };
  }
  const meeting = extractMeetingLink(args.link);
  if (!meeting) return { status: "ignored", reason: "no_meeting_link" };

  const updated = {
    ...interview,
    joinUrl: meeting.url,
    platform: meeting.platform,
    startsAt: args.startsAt ?? interview.startsAt,
    status: "scheduled" as const,
  };
  const plan = await deps.controller.schedule(updated);
  await deps.store.save({ ...updated, recallBotId: plan.botId, joinMode: plan.mode });
  return { status: "scheduled", interviewId: interview.id, mode: plan.mode, joinAt: plan.joinAt, senderMismatch: false };
}
