namespace MediaBot;

public enum EndReason { MeetingEnded, Removed, NotAdmitted, Error }

/// <summary>Where bot events go. Real impl posts to the backend (POST /api/bot/events).</summary>
public interface IEventSink
{
    Task LobbyWaitingAsync(string interviewId);
    Task AdmittedAsync(string interviewId);

    /// <summary>
    /// Result of Graph updateRecordingStatus. Microsoft requires success before media/derived data
    /// (transcripts) may be persisted. This is the #1 risk to verify in the spike.
    /// </summary>
    Task RecordingStatusAsync(string interviewId, bool ok, string? detail);

    Task SegmentAsync(TranscriptSegment segment);
    Task EndedAsync(string interviewId, EndReason reason);
}

public record TranscriptSegment(
    string InterviewId,
    string SpeakerId,
    string? SpeakerName,
    string Role, // "interviewer" | "candidate" | "unknown"
    string Text,
    bool IsFinal,
    long StartMs);

/// <param name="TenantId">
/// Tenant of the meeting organizer. REQUIRED for short links (teams.microsoft.com/meet/{id}?p=...),
/// which do not carry the organizer. Long meetup-join links carry it.
/// </param>
/// <param name="InterviewerAadId">Entra object id of the interviewer; used to tag speakers as interviewer vs candidate.</param>
public record JoinArgs(string InterviewId, string JoinUrl, string? TenantId = null, string? InterviewerAadId = null);

public interface IMeetingBot
{
    /// <summary>Join the Teams meeting. Returns once the join request is accepted, not once admitted.</summary>
    Task JoinAsync(JoinArgs args);

    Task LeaveAsync(string interviewId);
}
