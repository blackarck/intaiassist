using MediaBot;
using Microsoft.Graph.Contracts;
using Microsoft.Graph.Models;
using Xunit;

namespace MediaBot.Tests;

public class JoinUrlParserTests
{
    private const string Tid = "86dc81db-c112-4228-9222-63f3e0aa1edb";
    private const string Oid = "5810cede-f3cc-42eb-b2c1-e9bd5d53ec96";

    private static string LongUrl() =>
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_Win6Ydo4wsMijFjZS00ZGVjLTk5MGUtOTRjNWY2NmNkYTFm%40thread.v2/0" +
        "?context=" + Uri.EscapeDataString($"{{\"Tid\":\"{Tid}\",\"Oid\":\"{Oid}\"}}");

    [Fact]
    public void LongLink_CarriesOrganizerAndTenant()
    {
        var (chat, meeting) = JoinUrlParser.Parse(LongUrl());

        Assert.NotNull(chat);
        Assert.Equal("19:meeting_Win6Ydo4wsMijFjZS00ZGVjLTk5MGUtOTRjNWY2NmNkYTFm@thread.v2", chat!.ThreadId);
        Assert.Equal("0", chat.MessageId);

        var organizer = Assert.IsType<OrganizerMeetingInfo>(meeting);
        Assert.Equal(Oid, organizer.Organizer!.User!.Id);
        Assert.Equal(Tid, JoinUrlParser.TenantOf(meeting));
    }

    [Fact]
    public void ShortLink_HasMeetingIdAndPasscode_ButNoTenant()
    {
        var (chat, meeting) = JoinUrlParser.Parse("https://teams.microsoft.com/meet/123456789012?p=AbC%2BdEf1");

        Assert.Null(chat);
        var info = Assert.IsType<JoinMeetingIdMeetingInfo>(meeting);
        Assert.Equal("123456789012", info.JoinMeetingId);
        Assert.Equal("AbC+dEf1", info.Passcode);
        // The caller MUST supply the tenant for these links.
        Assert.Null(JoinUrlParser.TenantOf(meeting));
    }

    [Theory]
    [InlineData("https://example.com/meet/123456789012?p=x")]
    [InlineData("https://teams.microsoft.com/something/else")]
    [InlineData("not a url")]
    public void Garbage_IsRejected(string url)
    {
        Assert.Throws<ArgumentException>(() => JoinUrlParser.Parse(url));
    }

    [Fact]
    public void LongLink_WithoutTidOrOid_IsRejected()
    {
        var url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0?context=" +
                  Uri.EscapeDataString("{\"MessageId\":\"0\"}");
        Assert.Throws<ArgumentException>(() => JoinUrlParser.Parse(url));
    }
}
