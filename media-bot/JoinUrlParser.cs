using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Graph;
using Microsoft.Graph.Models;
using Microsoft.Graph.Communications.Common;
using Microsoft.Graph.Contracts;

namespace MediaBot;

/// <summary>
/// Turns a Teams join URL into the chatInfo + meetingInfo Graph needs.
///
/// Two URL shapes exist:
///  1. Long:  https://teams.microsoft.com/l/meetup-join/{thread}/{message}?context={"Tid":..,"Oid":..}
///            carries the organizer and tenant.
///  2. Short: https://teams.microsoft.com/meet/{digits}?p={passcode}
///            carries NEITHER, so the caller must supply the tenant id.
/// </summary>
public static class JoinUrlParser
{
    private static readonly Regex LongForm = new(
        @"^https://teams\.(?:microsoft|live)\.com/.*/(?<thread>[^/]+)/(?<message>[^/]+)\?context=(?<context>\{.*\})",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public static (ChatInfo? Chat, MeetingInfo Meeting) Parse(string joinUrl)
    {
        if (TryParseShort(joinUrl, out var shortInfo)) return (null, shortInfo);

        var decoded = WebUtility.UrlDecode(joinUrl);
        var m = LongForm.Match(decoded);
        if (!m.Success) throw new ArgumentException("Join URL cannot be parsed as a Teams meeting link.", nameof(joinUrl));

        using var doc = JsonDocument.Parse(m.Groups["context"].Value);
        string? Prop(string name) =>
            doc.RootElement.EnumerateObject()
                .FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))
                .Value is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

        var tid = Prop("Tid");
        var oid = Prop("Oid");
        if (string.IsNullOrEmpty(tid) || string.IsNullOrEmpty(oid))
            throw new ArgumentException("Join URL context is missing Tid/Oid.", nameof(joinUrl));

        var chat = new ChatInfo
        {
            ThreadId = m.Groups["thread"].Value,
            MessageId = m.Groups["message"].Value,
            ReplyChainMessageId = Prop("MessageId"),
        };

        var meeting = new OrganizerMeetingInfo
        {
            Organizer = new IdentitySet { User = new Identity { Id = oid } },
        };
        meeting.Organizer.User.SetTenantId(tid);
        return (chat, meeting);
    }

    private static bool TryParseShort(string joinUrl, out JoinMeetingIdMeetingInfo info)
    {
        info = null!;
        if (!Uri.TryCreate(joinUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        if (uri.Host != "teams.microsoft.com" && uri.Host != "teams.live.com") return false;
        const string prefix = "/meet/";
        if (!uri.AbsolutePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;

        var id = uri.AbsolutePath[prefix.Length..];
        if (id.Length == 0 || !id.All(char.IsAsciiDigit)) return false;

        string? passcode = null;
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            if (kv.Length == 2 && kv[0].Equals("p", StringComparison.OrdinalIgnoreCase))
                passcode = Uri.UnescapeDataString(kv[1]);
        }

        info = new JoinMeetingIdMeetingInfo { JoinMeetingId = id, Passcode = passcode };
        return true;
    }

    /// <summary>Tenant carried inside a long-form URL, if any.</summary>
    public static string? TenantOf(MeetingInfo meeting) =>
        (meeting as OrganizerMeetingInfo)?.Organizer?.GetPrimaryIdentity()?.GetTenantId();
}
