using System.Net.Http.Headers;
using System.Text.Json;

namespace MediaBot;

public sealed class BackendEventSink : IEventSink
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly ILogger<BackendEventSink> _log;

    public BackendEventSink(HttpClient http, IConfiguration cfg, ILogger<BackendEventSink> log)
    {
        _http = http;
        _log = log;
        _http.BaseAddress = new Uri(cfg["Backend:Url"] ?? throw new InvalidOperationException("Backend:Url is required"));
        _http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", cfg["Backend:Token"] ?? "");
    }

    private async Task PostAsync(object body)
    {
        try
        {
            var res = await _http.PostAsJsonAsync("/api/bot/events", body, Json);
            if (!res.IsSuccessStatusCode)
                _log.LogWarning("backend rejected event: {Status} {Body}", (int)res.StatusCode, await res.Content.ReadAsStringAsync());
        }
        catch (Exception e)
        {
            // Never let a backend hiccup kill the call; real impl should buffer + retry.
            _log.LogError(e, "failed to post event to backend");
        }
    }

    public Task LobbyWaitingAsync(string id) => PostAsync(new { type = "lobby_waiting", interviewId = id });
    public Task AdmittedAsync(string id) => PostAsync(new { type = "admitted", interviewId = id });
    public Task RecordingStatusAsync(string id, bool ok, string? detail) =>
        PostAsync(new { type = "recording_status", interviewId = id, ok, detail });

    public Task SegmentAsync(TranscriptSegment s) => PostAsync(new { type = "segment", segment = s });

    public Task EndedAsync(string id, EndReason reason) =>
        PostAsync(new
        {
            type = "ended",
            interviewId = id,
            reason = reason switch
            {
                EndReason.MeetingEnded => "meeting_ended",
                EndReason.Removed => "removed",
                EndReason.NotAdmitted => "not_admitted",
                _ => "error",
            },
        });
}
